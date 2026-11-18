import pytest
from datetime import datetime, timezone, timedelta
from fastapi import HTTPException
from sqlalchemy.orm import Session
from starlette.requests import Request

from backend.app.models.entities import (
    User,
    Incident,
    Ambulance,
    Hospital,
    Dispatch,
    HandoverPacket,
    IncidentEvent,
    WitnessReport,
)
from backend.app.schemas.incident import IncidentCreate
from backend.app.schemas.dispatch import (
    DispatchRequest,
    ConfirmationDecision,
    HandoverAcknowledgeRequest,
)
from backend.app.schemas.hospital import HospitalCapacityUpdate
from backend.app.api.incidents import create_incident, list_incidents, get_incident
from backend.app.api.dispatch import (
    create_dispatch,
    confirm_ambulance,
    confirm_hospital,
    advance_dispatch_lifecycle,
    get_handover_packet,
    acknowledge_handover_packet,
    check_expirations,
    list_dispatches,
    auto_allocate_dispatch,
)
from backend.app.api.hospitals import update_hospital_capacity
from backend.app.services.allocation_engine import score_and_rank_ambulances
from backend.app.services.hospital_engine import rank_suitable_hospitals
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
)
from backend.app.services.seed_service import seed_demo_users


def build_client(user: User) -> WebSocketClient:
    return WebSocketClient(
        websocket=None,
        user_id=user.id,
        email=user.email,
        role=user.role,
        ambulance_id=user.ambulance_id,
        hospital_id=user.hospital_id,
    )


# =============================================================================
# SCENARIO 1: Citizen SOS creation with GPS
# =============================================================================
def test_01_citizen_sos_creation_with_gps(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    citizen = db.query(User).filter(User.email == "citizen@lifelink.demo").first()
    payload = IncidentCreate(
        caller_name=citizen.full_name,
        caller_phone=citizen.phone_number or "+91 98451 99887",
        location_address="Kadri Park Road, Mangaluru (Live GPS Fix ±12m)",
        latitude=12.8760,
        longitude=74.8560,
        chief_complaint="Acute crushing chest pain, diaphoresis and difficulty breathing",
        chest_pain=True,
        breathing_status="Difficult",
    )
    inc = create_incident(payload, db=db, current_user=citizen)
    assert inc.id is not None
    assert inc.latitude == 12.8760
    assert inc.longitude == 74.8560
    assert inc.reporter_user_id == citizen.id
    assert inc.triage_level == "Priority 1 (Critical)"
    assert inc.required_ambulance_type == "ALS"


# =============================================================================
# SCENARIO 2: Citizen SOS creation with manual location
# =============================================================================
def test_02_citizen_sos_creation_with_manual_location(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    citizen = db.query(User).filter(User.email == "citizen@lifelink.demo").first()
    # GPS denied or disabled -> User manually selected Hampankatta landmark
    payload = IncidentCreate(
        caller_name=citizen.full_name,
        caller_phone=citizen.phone_number or "+91 98451 99887",
        location_address="Hampankatta (City Centre), Mangaluru",
        latitude=12.8700,
        longitude=74.8420,
        chief_complaint="Elderly person slipped, hip fracture with severe bleeding",
        severe_bleeding=True,
        severe_trauma=True,
    )
    inc = create_incident(payload, db=db, current_user=citizen)
    assert inc.id is not None
    assert inc.location_address == "Hampankatta (City Centre), Mangaluru"
    assert inc.latitude == 12.8700
    assert inc.longitude == 74.8420
    assert inc.status == "TRIAGED"


# =============================================================================
# SCENARIO 3: Dispatcher receives the incident
# =============================================================================
def test_03_dispatcher_receives_the_incident(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    dispatcher = db.query(User).filter(User.email == "dispatcher@lifelink.demo").first()
    citizen = db.query(User).filter(User.email == "citizen@lifelink.demo").first()

    inc = create_incident(
        IncidentCreate(
            caller_name="Radha Nayak",
            caller_phone="+91 94480 12345",
            location_address="Surathkal Market Road",
            latitude=12.9815,
            longitude=74.7950,
            chief_complaint="Severe vehicular collision",
            severe_trauma=True,
        ),
        db=db,
        current_user=citizen,
    )

    dispatcher_incidents = list_incidents(db=db, current_user=dispatcher)
    assert any(i.id == inc.id for i in dispatcher_incidents)


# =============================================================================
# SCENARIO 4: Best available ambulance selection
# =============================================================================
def test_04_best_available_ambulance_selection(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    inc = db.query(Incident).filter(Incident.required_ambulance_type == "ALS").first()
    ambulances = db.query(Ambulance).all()

    result = score_and_rank_ambulances(incident=inc, ambulances=ambulances)
    recommended = result["recommended_ambulance"]

    assert recommended is not None
    assert recommended["vehicle_type"] == "ALS"
    # Unavailable unit KA-19-ALS-104 (MAINTENANCE) must be excluded
    excluded_ids = [e["ambulance_id"] for e in result["excluded_ambulances"]]
    maint_amb = db.query(Ambulance).filter(Ambulance.status == "MAINTENANCE").first()
    if maint_amb:
        assert maint_amb.id in excluded_ids


# =============================================================================
# SCENARIO 5: Hospital suitability selection using current availability
# =============================================================================
def test_05_hospital_suitability_selection_using_current_availability(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    inc = db.query(Incident).first()
    hospitals = db.query(Hospital).all()

    result = rank_suitable_hospitals(incident=inc, hospitals=hospitals)
    ranked = result["ranked_hospitals"]
    recommended = result["recommended_hospital"]

    assert len(ranked) >= 1
    assert recommended is not None
    # Indiana Hospital is marked BUSY in seed data -> must reflect reduced readiness score
    indiana = next((h for h in ranked if "Indiana" in h["name"]), None)
    if indiana:
        assert indiana["readiness_status"] == "BUSY"


# =============================================================================
# SCENARIO 6: Ambulance accepts and hospital accepts
# =============================================================================
def test_06_ambulance_accepts_and_hospital_accepts(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    dispatcher = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    paramedic = db.query(User).filter(User.email == "als101@lifelink.demo").first()
    hospital = db.query(User).filter(User.email == "kmc@lifelink.demo").first()

    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.id == paramedic.ambulance_id).first()
    hosp = db.query(Hospital).filter(Hospital.id == hospital.hospital_id).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
        current_user=dispatcher,
    )

    # Crew accepts
    disp = confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db, current_user=paramedic)
    assert disp.ambulance_confirmation_status == "ACCEPTED"

    # Hospital accepts
    disp = confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db, current_user=hospital)
    assert disp.hospital_confirmation_status == "ACCEPTED"


# =============================================================================
# SCENARIO 7: Dispatch is confirmed only after both accept
# =============================================================================
def test_07_dispatch_is_confirmed_only_after_both_accept(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    dispatcher = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    paramedic = db.query(User).filter(User.email == "als101@lifelink.demo").first()
    hospital = db.query(User).filter(User.email == "kmc@lifelink.demo").first()

    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.id == paramedic.ambulance_id).first()
    hosp = db.query(Hospital).filter(Hospital.id == hospital.hospital_id).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
        current_user=dispatcher,
    )
    assert disp.coordination_status == "PENDING_CONFIRMATIONS"

    # Only ambulance accepts -> MUST still be PENDING_CONFIRMATIONS
    disp = confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db, current_user=paramedic)
    assert disp.coordination_status == "PENDING_CONFIRMATIONS"
    assert disp.confirmed_at is None

    # Hospital also accepts -> now promoted to CONFIRMED
    disp = confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db, current_user=hospital)
    assert disp.coordination_status == "CONFIRMED"
    assert disp.confirmed_at is not None


# =============================================================================
# SCENARIO 8: Ambulance rejection and alternative selection
# =============================================================================
def test_08_ambulance_rejection_and_alternative_selection(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    dispatcher = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    paramedic = db.query(User).filter(User.email == "als101@lifelink.demo").first()
    hospital = db.query(User).filter(User.email == "kmc@lifelink.demo").first()

    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.id == paramedic.ambulance_id).first()
    hosp = db.query(Hospital).filter(Hospital.id == hospital.hospital_id).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
        current_user=dispatcher,
    )

    # Paramedic declines assignment
    rejection = ConfirmationDecision(decision="REJECTED", reason="Mechanical breakdown / flat tire")
    escalated = confirm_ambulance(disp.id, rejection, db=db, current_user=paramedic)

    # Unit 1 released
    db.refresh(amb)
    assert amb.status == "AVAILABLE"
    assert amb.reservation_dispatch_id is None

    # Alternative ambulance selected
    assert escalated.attempt_number >= 2
    assert escalated.ambulance_id != amb.id
    assert escalated.ambulance_confirmation_status == "PENDING"


# =============================================================================
# SCENARIO 9: Hospital rejection and alternative selection
# =============================================================================
def test_09_hospital_rejection_and_alternative_selection(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    dispatcher = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    paramedic = db.query(User).filter(User.email == "als101@lifelink.demo").first()
    hospital = db.query(User).filter(User.email == "kmc@lifelink.demo").first()

    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.id == paramedic.ambulance_id).first()
    hosp = db.query(Hospital).filter(Hospital.id == hospital.hospital_id).first()
    initial_beds = hosp.reserved_emergency_beds or 0

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
        current_user=dispatcher,
    )

    db.refresh(hosp)
    assert hosp.reserved_emergency_beds == initial_beds + 1

    # Hospital declines
    rejection = ConfirmationDecision(decision="REJECTED", reason="CT scanner under emergency maintenance")
    escalated = confirm_hospital(disp.id, rejection, db=db, current_user=hospital)

    # Bed reservation released
    db.refresh(hosp)
    assert hosp.reserved_emergency_beds == initial_beds

    # Alternative hospital selected
    assert escalated.attempt_number >= 2
    assert escalated.destination_hospital_id != hosp.id
    assert escalated.hospital_confirmation_status == "PENDING"


# =============================================================================
# SCENARIO 10: Reservation expiry after 90 seconds
# =============================================================================
def test_10_reservation_expiry_after_90_seconds(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    dispatcher = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
        current_user=dispatcher,
    )

    # Simulate 90-second timeout expiration
    disp.reservation_expires_at = datetime.now(timezone.utc) - timedelta(seconds=10)
    db.commit()

    sweep_res = check_expirations(db=db)
    assert sweep_res["expired_count"] >= 1

    db.refresh(disp)
    assert disp.attempt_number >= 2


# =============================================================================
# SCENARIO 11: Concurrent incidents cannot reserve the same ambulance
# =============================================================================
def test_11_concurrent_incidents_cannot_reserve_same_ambulance(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    dispatcher = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    citizen = db.query(User).filter(User.role == ROLE_CITIZEN).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()

    inc1 = db.query(Incident).first()
    inc2 = create_incident(
        IncidentCreate(
            caller_name="Caller Two",
            caller_phone="+91 98888 77777",
            location_address="Bunder Port, Mangaluru",
            latitude=12.8650,
            longitude=74.8350,
            chief_complaint="Drowning emergency at wharf",
        ),
        db=db,
        current_user=citizen,
    )

    # Dispatch 1 books ambulance
    disp1 = create_dispatch(
        DispatchRequest(incident_id=inc1.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
        current_user=dispatcher,
    )
    assert disp1.id is not None

    db.refresh(amb)
    assert amb.status == "RESERVED"

    # Dispatch 2 attempts to reserve the same unit simultaneously -> 409 Conflict
    with pytest.raises(HTTPException) as exc:
        create_dispatch(
            DispatchRequest(incident_id=inc2.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
            db=db,
            current_user=dispatcher,
        )
    assert exc.value.status_code == 409


# =============================================================================
# SCENARIO 12: Hospital availability changes affect future recommendations
# =============================================================================
def test_12_hospital_availability_changes_affect_future_recommendations(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    dispatcher = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    hosp = db.query(Hospital).filter(Hospital.facility_code == "HOSP-MNG-001").first()

    # 1. Initially KMC Hospital is accepting and ready
    inc = db.query(Incident).first()
    initial_ranking = rank_suitable_hospitals(incident=inc, hospitals=db.query(Hospital).all())
    kmc_in_initial = any(h["hospital_id"] == hosp.id for h in initial_ranking["ranked_hospitals"])
    assert kmc_in_initial is True

    # 2. Hospital staff sets facility to DIVERT (no incoming emergencies)
    update_hospital_capacity(
        hospital_id=hosp.id,
        payload=HospitalCapacityUpdate(readiness_status="DIVERT", accepting_emergencies=False),
        db=db,
        current_user=dispatcher,
    )

    db.refresh(hosp)
    assert hosp.readiness_status == "DIVERT"
    assert hosp.accepting_emergencies is False

    # 3. Future suitability ranking excludes KMC Hospital entirely!
    new_ranking = rank_suitable_hospitals(incident=inc, hospitals=db.query(Hospital).all())
    kmc_in_new = any(h["hospital_id"] == hosp.id for h in new_ranking["ranked_hospitals"])
    assert kmc_in_new is False

    # 4. Restore KMC Hospital to READY
    update_hospital_capacity(
        hospital_id=hosp.id,
        payload=HospitalCapacityUpdate(readiness_status="READY", accepting_emergencies=True),
        db=db,
        current_user=dispatcher,
    )
    db.refresh(hosp)
    assert hosp.readiness_status == "READY"


# =============================================================================
# SCENARIO 13: Citizen sees authorized progress updates
# =============================================================================
def test_13_citizen_sees_authorized_progress_updates(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    citizen = db.query(User).filter(User.email == "citizen@lifelink.demo").first()
    dispatcher = db.query(User).filter(User.email == "dispatcher@lifelink.demo").first()
    paramedic = db.query(User).filter(User.email == "als101@lifelink.demo").first()
    hospital = db.query(User).filter(User.email == "kmc@lifelink.demo").first()

    inc = create_incident(
        IncidentCreate(
            caller_name=citizen.full_name,
            caller_phone="+91 98451 99887",
            location_address="Kadri Hills, Mangaluru",
            latitude=12.8770,
            longitude=74.8580,
            chief_complaint="Severe asthma crisis",
        ),
        db=db,
        current_user=citizen,
    )

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=paramedic.ambulance_id, destination_hospital_id=hospital.hospital_id),
        db=db,
        current_user=dispatcher,
    )
    confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db, current_user=paramedic)
    confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db, current_user=hospital)

    # Paramedic steps to EN_ROUTE_INCIDENT
    advance_dispatch_lifecycle(disp.id, db=db, current_user=paramedic)

    # Citizen inspects incident status
    cit_view = get_incident(inc.id, db=db, current_user=citizen)
    assert cit_view.id == inc.id
    assert cit_view.reporter_user_id == citizen.id


# =============================================================================
# SCENARIO 14: Citizen cannot access clinical handover information
# =============================================================================
def test_14_citizen_cannot_access_clinical_handover_information(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    citizen = db.query(User).filter(User.role == ROLE_CITIZEN).first()
    dispatcher = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    amb = db.query(Ambulance).first()
    hosp = db.query(Hospital).first()
    inc = db.query(Incident).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
        current_user=dispatcher,
    )

    # Citizen strictly denied access to pre-arrival clinical packet -> 403 Forbidden
    with pytest.raises(HTTPException) as exc:
        get_handover_packet(disp.id, db=db, current_user=citizen)
    assert exc.value.status_code == 403


# =============================================================================
# SCENARIO 15: Unauthorized roles cannot access operational endpoints
# =============================================================================
def test_15_unauthorized_roles_cannot_access_operational_endpoints(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    citizen = db.query(User).filter(User.role == ROLE_CITIZEN).first()
    amb = db.query(Ambulance).first()
    hosp = db.query(Hospital).first()
    inc = db.query(Incident).first()

    # Citizen cannot directly create dispatch
    with pytest.raises(HTTPException) as exc1:
        create_dispatch(
            DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
            db=db,
            current_user=citizen,
        )
    assert exc1.value.status_code == 403

    # Unauthenticated capacity modification rejected with 401
    with pytest.raises(HTTPException) as exc2:
        update_hospital_capacity(
            hospital_id=hosp.id,
            payload=HospitalCapacityUpdate(available_emergency_beds=10),
            db=db,
            current_user=None,
        )
    assert exc2.value.status_code == 401


# =============================================================================
# SCENARIO 16: Resource availability is correctly restored after completion
# =============================================================================
def test_16_resource_availability_correctly_restored_after_completion(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    paramedic = db.query(User).filter(User.email == "als101@lifelink.demo").first()
    hospital = db.query(User).filter(User.email == "kmc@lifelink.demo").first()
    dispatcher = db.query(User).filter(User.role == ROLE_DISPATCHER).first()

    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.id == paramedic.ambulance_id).first()
    hosp = db.query(Hospital).filter(Hospital.id == hospital.hospital_id).first()

    initial_reserved = hosp.reserved_emergency_beds or 0

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
        current_user=dispatcher,
    )
    confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db, current_user=paramedic)
    confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db, current_user=hospital)

    # Advance all the way to COMPLETED
    advance_dispatch_lifecycle(disp.id, db=db, current_user=paramedic)  # EN_ROUTE_INCIDENT
    advance_dispatch_lifecycle(disp.id, db=db, current_user=paramedic)  # ON_SCENE
    advance_dispatch_lifecycle(disp.id, db=db, current_user=paramedic)  # EN_ROUTE_HOSPITAL
    completed = advance_dispatch_lifecycle(disp.id, db=db, current_user=paramedic)  # COMPLETED

    assert completed.status == "COMPLETED"

    # Reconciled resources
    db.refresh(amb)
    db.refresh(hosp)
    db.refresh(inc)

    assert amb.status == "AVAILABLE"
    assert amb.reservation_dispatch_id is None
    assert hosp.reserved_emergency_beds == initial_reserved
    assert inc.status == "RESOLVED"
