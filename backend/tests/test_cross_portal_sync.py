import pytest
from datetime import datetime, timedelta
from fastapi import HTTPException
from sqlalchemy.orm import Session
from unittest.mock import Mock
from fastapi import WebSocket

from backend.app.models.entities import (
    User,
    Incident,
    Ambulance,
    Hospital,
    Dispatch,
    WitnessReport,
    HandoverPacket,
    IncidentEvent,
)
from backend.app.schemas.incident import IncidentCreate
from backend.app.schemas.dispatch import DispatchRequest, ConfirmationDecision, IncidentStatusUpdate, HandoverAcknowledgeRequest
from backend.app.schemas.witness_report import WitnessReportCreate, WitnessReportLinkRequest
from backend.app.api.incidents import create_incident, list_incidents, get_incident, update_incident_status
from backend.app.api.dispatch import (
    create_dispatch,
    confirm_ambulance,
    confirm_hospital,
    advance_dispatch_lifecycle,
    get_handover_packet,
    acknowledge_handover_packet,
    reassign_dispatch,
    list_dispatches,
)
from backend.app.api.witness_reports import create_witness_report, link_witness_report
from backend.app.api.hospitals import update_hospital_capacity, HospitalCapacityUpdate
from backend.app.core.auth import (
    ROLE_CITIZEN,
    ROLE_AMBULANCE_CREW,
    ROLE_HOSPITAL_STAFF,
    ROLE_DISPATCHER,
    ROLE_SUPER_ADMIN,
)
from backend.app.core.ws import (
    ws_manager,
    WebSocketClient,
    create_event_envelope,
    ROLE_CITIZEN,
    ROLE_AMBULANCE_CREW,
    ROLE_HOSPITAL_STAFF,
    ROLE_DISPATCHER,
    ROLE_SUPER_ADMIN,
)
from backend.app.core.database import Base, engine, SessionLocal, upgrade_schema
from backend.app.services.seed_service import seed_database, seed_demo_users

@pytest.fixture
def sync_db(fresh_db: Session):
    seed_demo_users(fresh_db)
    return fresh_db

# =========================================================================
# 1. Citizen emergency creation appears in dispatcher view (isolated from other citizens)
# =========================================================================
def test_citizen_emergency_creation_appears_in_dispatcher_view(sync_db: Session):
    db = sync_db
    citizen_user = db.query(User).filter(User.email == "citizen@lifelink.demo").first()
    disp_user = db.query(User).filter(User.email == "dispatcher@lifelink.demo").first()

    # Create another citizen if not exists
    other_citizen = db.query(User).filter(User.email == "othercitizen@lifelink.demo").first()
    if not other_citizen:
        other_citizen = User(
            email="othercitizen@lifelink.demo",
            password_hash="hashed",
            full_name="Other Citizen",
            role=ROLE_CITIZEN,
            is_active=True,
        )
        db.add(other_citizen)
        db.commit()

    # Citizen logs emergency
    payload = IncidentCreate(
        caller_name=citizen_user.full_name,
        caller_phone=citizen_user.phone_number or "+91 98888 11111",
        location_address="Kadri Hills, Mangaluru",
        latitude=12.8765,
        longitude=74.8580,
        chief_complaint="Severe breathing difficulty and cyanosis",
        chest_pain=False,
        breathing_status="Severely Compromised",
    )
    created_inc = create_incident(payload, db=db, current_user=citizen_user)
    assert created_inc.reporter_user_id == citizen_user.id
    assert created_inc.triage_level is not None
    assert created_inc.triage_color in ["RED", "YELLOW", "GREEN"]

    # Dispatcher sees it in the regional incident queue
    disp_incidents = list_incidents(db=db, current_user=disp_user)
    assert any(inc.id == created_inc.id for inc in disp_incidents)

    # Reporting citizen sees it in their isolated list
    citizen_incidents = list_incidents(db=db, current_user=citizen_user)
    assert any(inc.id == created_inc.id for inc in citizen_incidents)

    # Other citizen CANNOT see it (strict privacy isolation)
    other_citizen_incidents = list_incidents(db=db, current_user=other_citizen)
    assert not any(inc.id == created_inc.id for inc in other_citizen_incidents)

# =========================================================================
# 2. Dispatcher reservation targeted routing & organization filtering
# =========================================================================
def test_dispatcher_reservation_targeted_routing(sync_db: Session):
    db = sync_db
    als101 = db.query(Ambulance).filter(Ambulance.call_sign == "KA-19-ALS-101").first()
    als102 = db.query(Ambulance).filter(Ambulance.call_sign == "KA-19-ALS-102").first()
    kmc_hosp = db.query(Hospital).filter(Hospital.facility_code == "HOSP-MNG-002").first()
    wenlock_hosp = db.query(Hospital).filter(Hospital.facility_code == "HOSP-MNG-001").first()

    mock_ws = Mock(spec=WebSocket)

    # Construct client representations for each stakeholder
    c_disp = WebSocketClient(websocket=mock_ws, user_id=1, email="dispatcher@lifelink.demo", role=ROLE_DISPATCHER)
    c_als101 = WebSocketClient(websocket=mock_ws, user_id=4, email="als101@lifelink.demo", role=ROLE_AMBULANCE_CREW, ambulance_id=als101.id)
    c_als102 = WebSocketClient(websocket=mock_ws, user_id=5, email="als102@lifelink.demo", role=ROLE_AMBULANCE_CREW, ambulance_id=als102.id)
    c_kmc = WebSocketClient(websocket=mock_ws, user_id=7, email="kmc.er@lifelink.demo", role=ROLE_HOSPITAL_STAFF, hospital_id=kmc_hosp.id)
    c_wenlock = WebSocketClient(websocket=mock_ws, user_id=6, email="wenlock.er@lifelink.demo", role=ROLE_HOSPITAL_STAFF, hospital_id=wenlock_hosp.id)
    c_reporting_citizen = WebSocketClient(websocket=mock_ws, user_id=99, email="citizen@lifelink.demo", role=ROLE_CITIZEN)
    c_other_citizen = WebSocketClient(websocket=mock_ws, user_id=100, email="other@lifelink.demo", role=ROLE_CITIZEN)

    # Event targeted to ALS-101, KMC Hospital, and reporting citizen #99
    # 1. Dispatcher always receives it
    assert ws_manager.is_client_eligible(c_disp, ambulance_id=als101.id, hospital_id=kmc_hosp.id, reporter_user_id=99) is True
    # 2. ALS-101 receives it, ALS-102 is denied
    assert ws_manager.is_client_eligible(c_als101, ambulance_id=als101.id, hospital_id=kmc_hosp.id, reporter_user_id=99) is True
    assert ws_manager.is_client_eligible(c_als102, ambulance_id=als101.id, hospital_id=kmc_hosp.id, reporter_user_id=99) is False
    # 3. KMC Hospital receives it, Wenlock Hospital is denied
    assert ws_manager.is_client_eligible(c_kmc, ambulance_id=als101.id, hospital_id=kmc_hosp.id, reporter_user_id=99) is True
    assert ws_manager.is_client_eligible(c_wenlock, ambulance_id=als101.id, hospital_id=kmc_hosp.id, reporter_user_id=99) is False
    # 4. Reporting citizen receives it, other citizen is denied
    assert ws_manager.is_client_eligible(c_reporting_citizen, ambulance_id=als101.id, hospital_id=kmc_hosp.id, reporter_user_id=99) is True
    assert ws_manager.is_client_eligible(c_other_citizen, ambulance_id=als101.id, hospital_id=kmc_hosp.id, reporter_user_id=99) is False

# =========================================================================
# 3. Ambulance and Hospital acceptance synchronization & Handover generation
# =========================================================================
def test_dual_acceptance_handover_synchronization(sync_db: Session):
    db = sync_db
    als101_user = db.query(User).filter(User.email == "als101@lifelink.demo").first()
    kmc_user = db.query(User).filter(User.email == "kmc@lifelink.demo").first()
    aj_user = db.query(User).filter(User.email == "aj@lifelink.demo").first()

    inc = Incident(
        caller_name="Sync Test Patient",
        caller_phone="+91 98888 22222",
        location_address="Hampankatta Junction",
        latitude=12.8680,
        longitude=74.8430,
        chief_complaint="Suspected stroke, facial droop",
        triage_level="P1",
        triage_color="RED",
        status="TRIAGED",
    )
    db.add(inc)
    db.commit()
    db.refresh(inc)

    amb = db.query(Ambulance).filter(Ambulance.id == als101_user.ambulance_id).first()
    amb.status = "AVAILABLE"
    amb.reservation_dispatch_id = None
    hosp = db.query(Hospital).filter(Hospital.id == kmc_user.hospital_id).first()
    db.commit()

    # Dispatcher initiates dual reservation
    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )
    assert disp.coordination_status == "PENDING_CONFIRMATIONS"
    assert disp.ambulance_confirmation_status == "PENDING"
    assert disp.hospital_confirmation_status == "PENDING"

    # Step A: Paramedic accepts
    confirmed_amb = confirm_ambulance(
        disp.id,
        ConfirmationDecision(decision="ACCEPTED"),
        db=db,
        current_user=als101_user,
    )
    assert confirmed_amb.ambulance_confirmation_status == "ACCEPTED"
    assert confirmed_amb.coordination_status == "PENDING_CONFIRMATIONS"

    # Step B: Unauthorized hospital staff (AJ Hospital) attempts to confirm KMC's reservation -> 403
    with pytest.raises(HTTPException) as exc:
        confirm_hospital(
            disp.id,
            ConfirmationDecision(decision="ACCEPTED"),
            db=db,
            current_user=aj_user,
        )
    assert exc.value.status_code == 403

    # Step C: Authorized KMC ER staff accepts -> Promoted to CONFIRMED
    confirmed_all = confirm_hospital(
        disp.id,
        ConfirmationDecision(decision="ACCEPTED"),
        db=db,
        current_user=kmc_user,
    )
    assert confirmed_all.hospital_confirmation_status == "ACCEPTED"
    assert confirmed_all.coordination_status == "CONFIRMED"
    assert confirmed_all.status == "ASSIGNED"

    # Handover packet automatically compiled upon dual confirmation
    packet = get_handover_packet(disp.id, db=db, current_user=kmc_user)
    assert packet.dispatch_id == disp.id
    assert packet.receiving_hospital_name == hosp.name
    assert packet.status == "SENT"

# =========================================================================
# 4. Lifecycle stepping & Handover acknowledgment synchronization
# =========================================================================
def test_lifecycle_stepping_and_handover_acknowledgment(sync_db: Session):
    db = sync_db
    als101_user = db.query(User).filter(User.email == "als101@lifelink.demo").first()
    kmc_user = db.query(User).filter(User.email == "kmc@lifelink.demo").first()

    inc = Incident(
        caller_name="Lifecycle Patient",
        caller_phone="+91 98888 33333",
        location_address="Mallikatta, Mangaluru",
        latitude=12.8750,
        longitude=74.8550,
        chief_complaint="Acute coronary syndrome",
        triage_level="P1",
        triage_color="RED",
        status="DISPATCHED",
    )
    db.add(inc)
    db.commit()
    db.refresh(inc)

    amb = db.query(Ambulance).filter(Ambulance.id == als101_user.ambulance_id).first()
    hosp = db.query(Hospital).filter(Hospital.id == kmc_user.hospital_id).first()
    hosp.reserved_emergency_beds = (hosp.reserved_emergency_beds or 0) + 1
    db.commit()

    disp = Dispatch(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
        coordination_status="CONFIRMED",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="ACCEPTED",
        status="ASSIGNED",
        attempt_number=1,
    )
    db.add(disp)
    db.commit()
    db.refresh(disp)

    # Paramedic steps lifecycle: EN_ROUTE_INCIDENT
    s1 = advance_dispatch_lifecycle(disp.id, db=db, current_user=als101_user)
    assert s1.status == "EN_ROUTE_INCIDENT"

    # Paramedic steps lifecycle: ON_SCENE
    s2 = advance_dispatch_lifecycle(disp.id, db=db, current_user=als101_user)
    assert s2.status == "ON_SCENE"

    # Paramedic steps lifecycle: EN_ROUTE_HOSPITAL
    s3 = advance_dispatch_lifecycle(disp.id, db=db, current_user=als101_user)
    assert s3.status == "EN_ROUTE_HOSPITAL"

    # Hospital ER staff acknowledges clinical handover
    ack_res = acknowledge_handover_packet(
        disp.id,
        payload=HandoverAcknowledgeRequest(acknowledged_by="Dr. A. Shenoy (ER Triage Officer)"),
        db=db,
        current_user=kmc_user,
    )
    assert ack_res.status == "ACKNOWLEDGED"
    assert "Dr. A. Shenoy" in ack_res.acknowledged_by

    # Paramedic final step: COMPLETED -> Releases resources
    s4 = advance_dispatch_lifecycle(disp.id, db=db, current_user=als101_user)
    assert s4.status == "COMPLETED"
    db.refresh(amb)
    assert amb.status == "AVAILABLE"

# =========================================================================
# 5. Incident status resolution releases active reservations
# =========================================================================
def test_incident_cancellation_releases_active_reservations(sync_db: Session):
    db = sync_db
    disp_user = db.query(User).filter(User.email == "dispatcher@lifelink.demo").first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).first()

    inc = Incident(
        caller_name="Accidental Trigger Patient",
        caller_phone="+91 97777 00000",
        location_address="Kankanady bypass",
        latitude=12.8600,
        longitude=74.8500,
        chief_complaint="False alarm, caller reported resolved",
        triage_level="P3",
        triage_color="GREEN",
        status="REPORTED",
    )
    db.add(inc)
    db.commit()
    db.refresh(inc)

    # Dispatch created
    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )
    db.refresh(amb)
    assert amb.status == "RESERVED"

    # Dispatcher cancels the emergency incident
    update_incident_status(
        inc.id,
        IncidentStatusUpdate(status="CANCELLED"),
        db=db,
        current_user=disp_user,
    )

    db.refresh(inc)
    assert inc.status == "CANCELLED"

    db.refresh(amb)
    # Unit should be immediately released back to AVAILABLE
    assert amb.status == "AVAILABLE"
    assert amb.reservation_dispatch_id is None

# =========================================================================
# 6. Hospital capacity management endpoint RBAC and synchronization
# =========================================================================
def test_hospital_capacity_management_rbac(sync_db: Session):
    db = sync_db
    kmc_user = db.query(User).filter(User.email == "kmc@lifelink.demo").first()
    aj_user = db.query(User).filter(User.email == "aj@lifelink.demo").first()
    disp_user = db.query(User).filter(User.email == "dispatcher@lifelink.demo").first()
    kmc_hosp = db.query(Hospital).filter(Hospital.id == kmc_user.hospital_id).first()

    initial_beds = kmc_hosp.available_emergency_beds

    # 1. KMC ER staff updates KMC capacity -> Allowed
    updated = update_hospital_capacity(
        kmc_hosp.id,
        HospitalCapacityUpdate(available_emergency_beds=initial_beds + 3, accepting_emergencies=True),
        db=db,
        current_user=kmc_user,
    )
    assert updated.available_emergency_beds == initial_beds + 3

    # 2. AJ Hospital ER staff attempts to update KMC capacity -> 403 Forbidden
    with pytest.raises(HTTPException) as exc:
        update_hospital_capacity(
            kmc_hosp.id,
            HospitalCapacityUpdate(available_emergency_beds=0, accepting_emergencies=False),
            db=db,
            current_user=aj_user,
        )
    assert exc.value.status_code == 403

    # 3. Regional Dispatcher can update capacity for any hospital
    disp_updated = update_hospital_capacity(
        kmc_hosp.id,
        HospitalCapacityUpdate(available_emergency_beds=initial_beds),
        db=db,
        current_user=disp_user,
    )
    assert disp_updated.available_emergency_beds == initial_beds

# =========================================================================
# 7. Witness report deduplication and synchronization
# =========================================================================
def test_witness_report_sync_and_linking(sync_db: Session):
    db = sync_db
    inc = db.query(Incident).first()

    # Citizen submits secondary eyewitness report
    report = create_witness_report(
        WitnessReportCreate(
            reporter_identifier="Eyewitness Traffic Warden",
            incident_description=f"Two-wheeler collision at location {inc.location_address}",
            incident_type="Road Traffic Accident",
            latitude=inc.latitude + 0.0005,
            longitude=inc.longitude + 0.0005,
        ),
        db=db,
    )
    assert report.id is not None
    assert report.review_status in ["POSSIBLE_DUPLICATE", "NEW"]

    # Dispatcher links eyewitness report to master incident
    linked = link_witness_report(
        report.id,
        WitnessReportLinkRequest(master_incident_id=inc.id, notes="Confirmed secondary caller"),
        db=db,
    )
    assert linked.review_status == "CONFIRMED_DUPLICATE"
    assert linked.master_incident_id == inc.id

# =========================================================================
# 8. Structured Event Envelope generation and client deduplication
# =========================================================================
def test_structured_event_envelope_contract():
    env1 = create_event_envelope("DISPATCH_STEPPED", {"status": "EN_ROUTE_SCENE"}, entity_type="dispatch", entity_id=42)
    env2 = create_event_envelope("DISPATCH_STEPPED", {"status": "EN_ROUTE_SCENE"}, entity_type="dispatch", entity_id=42)

    # Contract properties
    assert env1["event"] == "DISPATCH_STEPPED"
    assert env1["entity_type"] == "dispatch"
    assert env1["entity_id"] == 42
    assert "timestamp" in env1
    assert env1["timestamp"].endswith("Z")

    # Unique event IDs for client-side deduplication
    assert env1["event_id"].startswith("evt_")
    assert env2["event_id"].startswith("evt_")
    assert env1["event_id"] != env2["event_id"]
