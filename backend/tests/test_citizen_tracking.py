import pytest
from datetime import datetime, timezone
from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend.app.models.entities import Incident, Dispatch, Ambulance, Hospital, User
from backend.app.schemas.incident import IncidentCreate
from backend.app.api.incidents import create_incident, get_incident, list_incidents
from backend.app.api.dispatch import (
    create_dispatch,
    get_dispatch,
    list_dispatches,
    confirm_ambulance,
    confirm_hospital,
    advance_dispatch_lifecycle,
    confirm_patient_arrival_at_hospital,
)
from backend.app.schemas.dispatch import DispatchRequest, ConfirmationDecision
from backend.app.api.ambulances import update_ambulance_telemetry
from backend.app.schemas.ambulance import AmbulanceLocationUpdate
from backend.app.core.auth import ROLE_CITIZEN, ROLE_DISPATCHER, ROLE_AMBULANCE_CREW, ROLE_HOSPITAL_STAFF


def test_citizen_incident_creation_and_full_tracking_flow(fresh_db: Session):
    """
    Verifies that a citizen can create an SOS emergency incident and track the full
    end-to-end lifecycle: triage, ambulance assignment, real-time status transitions,
    ETA, ambulance unit identification, and destination hospital bed coordination.
    """
    db = fresh_db
    citizen = db.query(User).filter(User.email == "citizen@lifelink.demo").first()
    assert citizen is not None, "Seed citizen user must exist"

    # 1. Citizen submits an SOS emergency request
    inc_payload = IncidentCreate(
        caller_name=citizen.full_name or "Demo Citizen",
        caller_phone=citizen.phone_number or "+91 98450 11200",
        location_address="Kadri Hills, Mangaluru, Karnataka",
        latitude=12.8760,
        longitude=74.8560,
        chief_complaint="Severe road accident with chest pain and bleeding",
        chest_pain=True,
        severe_bleeding=True,
        severe_trauma=True,
    )
    incident = create_incident(inc_payload, db=db, current_user=citizen)
    assert incident.id is not None
    assert incident.reporter_user_id == citizen.id
    assert incident.status == "TRIAGED"
    assert incident.triage_level in ["RED", "Priority 1", "IMMEDIATE"] or incident.triage_color in ["RED", "YELLOW"]

    # 2. Citizen can retrieve their own active incident
    tracked_inc = get_incident(incident.id, db=db, current_user=citizen)
    assert tracked_inc.id == incident.id
    assert tracked_inc.location_address == "Kadri Hills, Mangaluru, Karnataka"
    assert "road accident" in tracked_inc.chief_complaint.lower()

    # 3. Dispatch is created by emergency dispatcher allocating ambulance and hospital
    dispatcher = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    ambulance = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hospital = db.query(Hospital).first()
    assert ambulance is not None
    assert hospital is not None

    disp_payload = DispatchRequest(
        incident_id=incident.id,
        ambulance_id=ambulance.id,
        destination_hospital_id=hospital.id,
    )
    dispatch = create_dispatch(disp_payload, db=db, current_user=dispatcher)
    assert dispatch.id is not None
    assert dispatch.incident_id == incident.id
    assert dispatch.ambulance_id == ambulance.id

    # 4. Citizen queries dispatches for their incident via GET /api/dispatch?incident_id=...
    citizen_dispatches = list_dispatches(incident_id=incident.id, db=db, current_user=citizen)
    assert len(citizen_dispatches) == 1
    c_disp = citizen_dispatches[0]

    # Verify tracking information required for citizen visibility
    assert c_disp.id == dispatch.id
    assert c_disp.ambulance_call_sign == ambulance.call_sign
    assert c_disp.ambulance_vehicle_type == ambulance.vehicle_type
    assert c_disp.ambulance_current_latitude == ambulance.current_latitude
    assert c_disp.ambulance_current_longitude == ambulance.current_longitude
    assert c_disp.destination_hospital_name == hospital.name
    assert c_disp.destination_hospital_address == hospital.address
    assert c_disp.estimated_eta_seconds is not None and c_disp.estimated_eta_seconds > 0
    assert c_disp.route_distance_meters is not None and c_disp.route_distance_meters > 0
    assert c_disp.status in ["ASSIGNED", "DISPATCHED", "PENDING_CONFIRMATIONS"]

    # 5. Dual confirmation: ambulance crew and hospital accept
    amb_user = db.query(User).filter(User.ambulance_id == ambulance.id).first()
    hosp_user = db.query(User).filter(User.hospital_id == hospital.id).first()

    confirm_ambulance(dispatch.id, ConfirmationDecision(decision="ACCEPTED"), db=db, current_user=amb_user)
    confirm_hospital(dispatch.id, ConfirmationDecision(decision="ACCEPTED"), db=db, current_user=hosp_user)

    c_disp_after_confirm = get_dispatch(dispatch.id, db=db, current_user=citizen)
    assert c_disp_after_confirm.coordination_status == "CONFIRMED"
    assert c_disp_after_confirm.ambulance_confirmation_status == "ACCEPTED"
    assert c_disp_after_confirm.hospital_confirmation_status == "ACCEPTED"

    # 6. Ambulance steps lifecycle to EN_ROUTE_INCIDENT -> ON_SCENE -> EN_ROUTE_HOSPITAL
    advance_dispatch_lifecycle(
        dispatch.id,
        expected_status=None,
        db=db,
        current_user=amb_user,
    )
    tracked_en_route = get_dispatch(dispatch.id, db=db, current_user=citizen)
    assert tracked_en_route.status == "EN_ROUTE_INCIDENT"

    # Update ambulance GPS telemetry
    update_ambulance_telemetry(
        ambulance.id,
        AmbulanceLocationUpdate(latitude=12.8750, longitude=74.8550),
        db=db,
        current_user=amb_user,
    )
    tracked_gps = get_dispatch(dispatch.id, db=db, current_user=citizen)
    assert tracked_gps.ambulance_current_latitude == 12.8750
    assert tracked_gps.ambulance_current_longitude == 74.8550

    # Step to ON_SCENE
    advance_dispatch_lifecycle(
        dispatch.id,
        expected_status=None,
        db=db,
        current_user=amb_user,
    )
    tracked_scene = get_dispatch(dispatch.id, db=db, current_user=citizen)
    assert tracked_scene.status == "ON_SCENE"

    # Step to EN_ROUTE_HOSPITAL
    advance_dispatch_lifecycle(
        dispatch.id,
        expected_status=None,
        db=db,
        current_user=amb_user,
    )
    tracked_transport = get_dispatch(dispatch.id, db=db, current_user=citizen)
    assert tracked_transport.status == "EN_ROUTE_HOSPITAL"

    # 7. Hospital confirms patient arrival at ER
    confirm_patient_arrival_at_hospital(dispatch.id, db=db, current_user=hosp_user)
    tracked_arrived = get_dispatch(dispatch.id, db=db, current_user=citizen)
    assert tracked_arrived.status == "AT_HOSPITAL"
    assert tracked_arrived.patient_arrived_hospital_confirmed_at is not None

    # Verify incident status synchronized
    tracked_inc_final = get_incident(incident.id, db=db, current_user=citizen)
    assert tracked_inc_final.status == "AT_HOSPITAL"


def test_citizen_privacy_and_data_isolation(fresh_db: Session):
    """
    Verifies that a citizen CANNOT inspect or list another citizen's emergency incidents
    or active dispatch tracking records (enforcing 403 Forbidden and tenant isolation).
    """
    db = fresh_db
    citizen_1 = db.query(User).filter(User.email == "citizen@lifelink.demo").first()
    assert citizen_1 is not None

    # Create Citizen 2
    citizen_2 = db.query(User).filter(User.email == "citizen2@lifelink.demo").first()
    if not citizen_2:
        citizen_2 = User(
            email="citizen2@lifelink.demo",
            full_name="Second Citizen",
            phone_number="+91 99999 88888",
            role=ROLE_CITIZEN,
            password_hash="mock_hash",
            is_active=True,
        )
        db.add(citizen_2)
        db.commit()
        db.refresh(citizen_2)

    # Citizen 1 reports an incident
    inc_1 = create_incident(
        IncidentCreate(
            caller_name="Citizen One",
            caller_phone="+91 98450 11111",
            location_address="Location 1, Mangaluru",
            latitude=12.8700,
            longitude=74.8400,
            chief_complaint="Chest tightness",
        ),
        db=db,
        current_user=citizen_1,
    )

    # Dispatcher dispatches for Incident 1
    dispatcher = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    ambulance = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hospital = db.query(Hospital).first()

    disp_1 = create_dispatch(
        DispatchRequest(
            incident_id=inc_1.id,
            ambulance_id=ambulance.id,
            destination_hospital_id=hospital.id,
        ),
        db=db,
        current_user=dispatcher,
    )

    # Citizen 2 attempts to fetch Incident 1 directly -> MUST FAIL with 403
    with pytest.raises(HTTPException) as exc_info:
        get_incident(inc_1.id, db=db, current_user=citizen_2)
    assert exc_info.value.status_code == 403
    assert "Citizens can only inspect their own" in exc_info.value.detail

    # Citizen 2 attempts to fetch Dispatch 1 directly -> MUST FAIL with 403
    with pytest.raises(HTTPException) as exc_disp:
        get_dispatch(disp_1.id, db=db, current_user=citizen_2)
    assert exc_disp.value.status_code == 403
    assert "Cannot view another citizen's emergency dispatch" in exc_disp.value.detail

    # Citizen 2 lists incidents -> Incident 1 must NOT appear in list
    c2_incidents = list_incidents(db=db, current_user=citizen_2)
    assert inc_1.id not in [inc.id for inc in c2_incidents]

    # Citizen 2 lists dispatches -> Dispatch 1 must NOT appear in list
    c2_dispatches = list_dispatches(db=db, current_user=citizen_2)
    assert disp_1.id not in [d.id for d in c2_dispatches]
