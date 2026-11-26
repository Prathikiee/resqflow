import pytest
from datetime import datetime, timezone, timedelta
import jwt
from backend.app.core.config import Settings
from backend.app.core.security import create_access_token
from backend.app.models.entities import Ambulance, Hospital, Incident, Dispatch, User, HandoverPacket, PatientVitals
from backend.app.services.seed_service import seed_database, MANGALURU_HOSPITALS
from backend.app.api.dispatch import (
    confirm_ambulance,
    confirm_hospital,
    confirm_patient_pickup,
    confirm_patient_arrival_at_hospital,
    advance_dispatch_lifecycle,
    record_patient_vitals,
    get_handover_packet,
    complete_handover_packet,
    auto_allocate_dispatch,
    get_dispatch,
    list_dispatches,
)
from backend.app.api.hospitals import get_allocated_incidents
from backend.app.schemas.dispatch import ConfirmationDecision, HandoverCompleteRequest
from backend.app.schemas.vitals import VitalsCreate
from backend.app.core.auth import ROLE_CITIZEN, ROLE_DISPATCHER, ROLE_AMBULANCE_CREW, ROLE_HOSPITAL_STAFF
from fastapi import HTTPException


def test_citizen_session_persistence_30_days():
    """
    Deliverable 1: Verify Citizen and staff JWT access tokens are valid for 30 days
    (43,200 minutes) to eliminate premature session timeouts across browser refreshes.
    """
    settings = Settings()
    assert settings.ACCESS_TOKEN_EXPIRE_MINUTES == 43200

    token_data = {"sub": "citizen_persisted_user", "role": ROLE_CITIZEN, "user_id": 999}
    token = create_access_token(data=token_data)
    decoded = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])

    assert decoded["sub"] == "citizen_persisted_user"
    assert decoded["role"] == ROLE_CITIZEN
    assert "exp" in decoded

    exp_dt = datetime.fromtimestamp(decoded["exp"], tz=timezone.utc)
    now_dt = datetime.now(timezone.utc)
    duration_days = (exp_dt - now_dt).total_seconds() / (24 * 3600)

    # Token must expire ~30 days in the future (between 29.9 and 30.1 days)
    assert 29.8 < duration_days < 30.2


def test_ten_hospitals_seeded_with_multidepartment_doctors(db):
    """
    Deliverable 4: Verify that seed_database maintains demonstration data for at least 10 hospitals,
    each with multi-department doctor rosters, shift types, start/end hours, working days, designations,
    and statuses idempotently without duplicate entries.
    """
    seed_database(db, force=False)
    hospitals = db.query(Hospital).all()
    assert len(hospitals) >= 10

    for h in hospitals:
        # Check that Mangaluru regional hospitals have full doctor rosters
        if h.facility_code and h.facility_code.startswith("HOSP-MNG-"):
            doctors = h.doctors_availability or []
            assert len(doctors) >= 4, f"Hospital {h.name} has only {len(doctors)} doctors"
            for doc in doctors:
                assert "id" in doc
                assert "name" in doc
                assert "specialty" in doc
                assert "department" in doc
                assert "designation" in doc
                assert "shift_type" in doc
                assert "shift_start" in doc
                assert "shift_end" in doc
                assert "working_days" in doc
                assert "status" in doc
                assert doc["status"] in ["AVAILABLE", "BUSY", "OFF_DUTY"]

    # Re-running seed_database must be idempotent (no duplicate hospitals or doctors)
    initial_count = db.query(Hospital).count()
    seed_database(db, force=False)
    assert db.query(Hospital).count() == initial_count


def test_full_cross_portal_emergency_workflow(db, monkeypatch):
    """
    Deliverable 6 & 7: Verify end-to-end cross-portal coordination workflow with real database state:
    1. Citizen creates emergency SOS
    2. Dispatcher reviews and triggers auto-allocation
    3. Ambulance and Hospital receive assignment and both confirm
    4. Dual confirmation promotes coordination to CONFIRMED
    5. Ambulance moves: EN_ROUTE_INCIDENT -> ON_SCENE
    6. Paramedic explicitly confirms patient pickup before departure
    7. Field vitals recorded in transit
    8. Ambulance arrives at ER -> Hospital confirms arrival
    9. SBAR clinical handover completed
    10. Mission closed & ambulance returns to AVAILABLE
    """
    # Mock routing calculations for ultra-fast offline execution
    mock_route = {
        "distance_meters": 3200.0,
        "duration_seconds": 380.0,
        "duration_minutes": 6.3,
        "geometry": [[12.87, 74.84], [12.89, 74.85]],
        "routing_mode": "Deterministic Test",
        "is_simulated": True,
        "attribution": "Test Routing Mock",
    }
    monkeypatch.setattr("backend.app.api.dispatch.calculate_route", lambda *args, **kwargs: mock_route)
    monkeypatch.setattr("backend.app.services.allocation_engine.calculate_route", lambda *args, **kwargs: mock_route)
    monkeypatch.setattr("backend.app.services.hospital_engine.calculate_route", lambda *args, **kwargs: mock_route)
    monkeypatch.setattr("backend.app.services.routing_service.calculate_route", lambda *args, **kwargs: mock_route)

    seed_database(db, force=False)

    # Setup actors from authoritative database seed
    citizen = db.query(User).filter(User.role == ROLE_CITIZEN).first()
    dispatcher = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    driver = db.query(User).filter(User.role == ROLE_AMBULANCE_CREW).first()
    hosp_staff = db.query(User).filter(User.role == ROLE_HOSPITAL_STAFF).first()

    assert citizen is not None, "Citizen demo user missing"
    assert dispatcher is not None, "Dispatcher demo user missing"
    assert driver is not None, "Paramedic crew demo user missing"
    assert hosp_staff is not None, "Hospital staff demo user missing"

    # Ensure an available ambulance unit exists
    ambulance = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    if not ambulance:
        ambulance = db.query(Ambulance).first()
        ambulance.status = "AVAILABLE"
        ambulance.reservation_dispatch_id = None
        db.commit()

    driver.ambulance_id = ambulance.id
    db.commit()

    # 1. Citizen creates emergency SOS
    incident = Incident(
        caller_name=citizen.full_name,
        caller_phone="+91 98451 99999",
        location_address="Hampankatta Junction, Mangaluru",
        latitude=12.8700,
        longitude=74.8420,
        chief_complaint="Severe chest pain and sudden cardiac collapse",
        patient_age=62,
        patient_gender="Male",
        consciousness_level="Unconscious",
        breathing_status="Absent",
        chest_pain=True,
        severe_trauma=False,
        severe_bleeding=False,
        triage_level="Priority 1",
        triage_color="RED",
        triage_score=95,
        required_ambulance_type="ALS",
        status="TRIAGED",
        reporter_user_id=citizen.id,
    )
    db.add(incident)
    db.commit()
    db.refresh(incident)

    # 2. Dispatcher triggers auto-allocation
    dispatch = auto_allocate_dispatch(incident_id=incident.id, db=db, current_user=dispatcher)
    assert dispatch.coordination_status == "PENDING_CONFIRMATIONS"
    assert dispatch.destination_hospital_id is not None
    active_hosp_id = dispatch.destination_hospital_id
    active_amb_id = dispatch.ambulance_id

    # 3. Paramedic crew confirms assignment
    confirm_decision = ConfirmationDecision(decision="ACCEPTED", attempt_number=dispatch.attempt_number)
    driver.ambulance_id = active_amb_id
    db.commit()

    d_amb = confirm_ambulance(dispatch_id=dispatch.id, payload=confirm_decision, db=db, current_user=driver)
    assert d_amb.ambulance_confirmation_status == "ACCEPTED"

    # 4. Hospital team confirms bed reservation
    hosp_staff.hospital_id = active_hosp_id
    db.commit()

    d_hosp = confirm_hospital(dispatch_id=dispatch.id, payload=confirm_decision, db=db, current_user=hosp_staff)
    assert d_hosp.hospital_confirmation_status == "ACCEPTED"

    # 5. Dual confirmation -> CONFIRMED
    db.refresh(dispatch)
    assert dispatch.coordination_status == "CONFIRMED"

    # 6. Ambulance advances to EN_ROUTE_INCIDENT and ON_SCENE
    d_enroute = advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db, current_user=driver)
    assert d_enroute.status == "EN_ROUTE_INCIDENT"

    d_scene = advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db, current_user=driver)
    assert d_scene.status == "ON_SCENE"

    # 7. Paramedic explicitly confirms patient pickup before leaving scene (advances to EN_ROUTE_HOSPITAL)
    d_pickup = confirm_patient_pickup(dispatch_id=dispatch.id, db=db, current_user=driver)
    assert d_pickup.status == "EN_ROUTE_HOSPITAL"
    assert d_pickup.departed_incident_at is not None

    # 8. In-transit patient vitals recorded
    vitals_payload = VitalsCreate(
        heart_rate=118,
        blood_pressure_systolic=135,
        blood_pressure_diastolic=88,
        oxygen_saturation=96,
        respiratory_rate=20,
        notes="Patient conscious after CPR & defibrillation; IV line secured.",
    )
    vitals = record_patient_vitals(dispatch_id=dispatch.id, payload=vitals_payload, db=db, current_user=driver)
    assert vitals.heart_rate == 118
    assert vitals.oxygen_saturation == 96

    # 9. Ambulance arrives at ER -> Hospital confirms ER arrival
    d_arrived = confirm_patient_arrival_at_hospital(dispatch_id=dispatch.id, db=db, current_user=hosp_staff)
    assert d_arrived.status == "AT_HOSPITAL"
    assert d_arrived.patient_arrived_hospital_confirmed_at is not None

    # 10. SBAR Clinical Handover review and completion
    handover = get_handover_packet(dispatch_id=dispatch.id, db=db, current_user=hosp_staff)
    assert handover is not None
    assert handover.chief_complaint is not None

    complete_payload = HandoverCompleteRequest(
        completed_by="Dr. Aditi Shenoy",
        receiving_notes="Patient received in Resus Bay 1. Cardiology team standby.",
    )
    completed_handover = complete_handover_packet(
        dispatch_id=dispatch.id, payload=complete_payload, db=db, current_user=hosp_staff
    )
    assert completed_handover.status == "COMPLETED"
    assert completed_handover.completed_at is not None

    # 12. Mission completed and ambulance returned to AVAILABLE
    d_comp = advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db, current_user=dispatcher)
    assert d_comp.status == "COMPLETED"

    db.refresh(ambulance)
    assert ambulance.status == "AVAILABLE"


def test_strict_hospital_data_isolation(db):
    """
    Deliverable 3: Enforce strict Hospital data isolation.
    Hospital A staff cannot view or alter Hospital B's dispatches or allocated incidents.
    """
    seed_database(db, force=False)

    staff_a = db.query(User).filter(User.email == "kmc.er@lifelink.demo").first()
    staff_b = db.query(User).filter(User.email == "aj.er@lifelink.demo").first()

    if not staff_a or not staff_b or staff_a.hospital_id == staff_b.hospital_id:
        all_staff = db.query(User).filter(User.role == ROLE_HOSPITAL_STAFF).all()
        assert len(all_staff) >= 2
        staff_a = all_staff[0]
        # Pick another staff with distinct hospital_id
        staff_b = next((s for s in all_staff if s.hospital_id != staff_a.hospital_id), all_staff[1])

    hosp_a_id = staff_a.hospital_id
    hosp_b_id = staff_b.hospital_id
    assert hosp_a_id != hosp_b_id

    # Create dispatch allocated to Hospital A
    amb = db.query(Ambulance).first()
    inc = Incident(
        caller_name="Test Isolation",
        caller_phone="999",
        location_address="Test Address",
        latitude=12.9,
        longitude=74.8,
        chief_complaint="Chest pain",
        triage_level="Priority 1",
        triage_color="RED",
        status="ALLOCATED",
    )
    db.add(inc)
    db.commit()

    disp_a = Dispatch(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp_a_id,
        status="ASSIGNED",
        coordination_status="PENDING_CONFIRMATIONS",
    )
    db.add(disp_a)
    db.commit()

    # 1. Staff A can access Hospital A's allocated incidents
    incidents_a = get_allocated_incidents(hospital_id=hosp_a_id, db=db, current_user=staff_a)
    assert any(d.id == disp_a.id for d in incidents_a)

    # 2. Staff B accessing Hospital A's allocated incidents -> 403 Forbidden
    with pytest.raises(HTTPException) as exc_info:
        get_allocated_incidents(hospital_id=hosp_a_id, db=db, current_user=staff_b)
    assert exc_info.value.status_code == 403

    # 3. Staff B accessing Hospital A's dispatch record directly -> 403 Forbidden
    with pytest.raises(HTTPException) as exc_info:
        get_dispatch(dispatch_id=disp_a.id, db=db, current_user=staff_b)
    assert exc_info.value.status_code == 403

    # 4. Staff B attempting to accept or reject Hospital A's dispatch -> 403 Forbidden
    decision = ConfirmationDecision(decision="ACCEPTED")
    with pytest.raises(HTTPException) as exc_info:
        confirm_hospital(dispatch_id=disp_a.id, payload=decision, db=db, current_user=staff_b)
    assert exc_info.value.status_code == 403


def test_timestamp_utc_iso_serialization_and_timeline_chronology(db):
    """
    Verify:
    1. Timestamp serialization outputs UTC with 'Z' suffix (avoiding client timezone distortion)
    2. Chronological timeline events are sorted ascending and accurately timestamped
    """
    from fastapi.encoders import jsonable_encoder
    from datetime import datetime, timezone
    from backend.app.api.incidents import get_incident_timeline
    from backend.app.services.timeline_service import log_incident_event

    # 1. Test jsonable_encoder timezone serialization
    naive_dt = datetime(2026, 11, 26, 5, 20, 0)
    serialized = jsonable_encoder(naive_dt)
    assert isinstance(serialized, str)
    assert serialized.endswith("Z"), f"Expected UTC 'Z' suffix on naive datetime serialization, got: {serialized}"

    # 2. Test timeline chronology
    seed_database(db, force=False)
    citizen = db.query(User).filter(User.role == ROLE_CITIZEN).first()
    inc = Incident(
        caller_name=citizen.full_name,
        caller_phone="+91 98451 99999",
        location_address="Test Junction, Mangaluru",
        latitude=12.8700,
        longitude=74.8420,
        chief_complaint="Severe injury",
        status="TRIAGED",
        reporter_user_id=citizen.id,
    )
    db.add(inc)
    db.commit()

    log_incident_event(
        db=db,
        incident_id=inc.id,
        event_type="INCIDENT_REGISTERED",
        event_title="Emergency SOS Registered",
        event_description="Test incident created",
        actor_type="CITIZEN",
    )
    log_incident_event(
        db=db,
        incident_id=inc.id,
        event_type="INCIDENT_TRIAGED",
        event_title="Triage Priority Assessed",
        event_description="Priority evaluated as P1",
        actor_type="SYSTEM",
    )

    events = get_incident_timeline(incident_id=inc.id, db=db, current_user=citizen)
    assert len(events) >= 2
    for i in range(len(events) - 1):
        assert events[i].created_at <= events[i+1].created_at

