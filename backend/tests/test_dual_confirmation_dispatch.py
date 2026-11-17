import pytest
from datetime import datetime, timezone, timedelta
from fastapi import HTTPException
from backend.app.core.database import SessionLocal, Base, engine
from backend.app.models.entities import Incident, Ambulance, Hospital, Dispatch
from backend.app.services.seed_service import seed_database
from backend.app.api.incidents import create_incident
from backend.app.schemas.incident import IncidentCreate
from backend.app.api.dispatch import (
    create_dispatch,
    advance_dispatch_lifecycle,
    confirm_ambulance,
    confirm_hospital,
    simulate_decision,
    check_expirations,
    reassign_dispatch,
)
from backend.app.schemas.dispatch import (
    DispatchRequest,
    ConfirmationDecision,
    SimulateDecisionRequest,
)

@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    seed_database(session, force=True)
    yield session
    session.close()

def test_dual_confirmation_success_flow(fresh_db):
    """
    Test: Ambulance accepts and hospital accepts -> coordination_status becomes CONFIRMED,
    ambulance becomes DISPATCHED, incident becomes DISPATCHED, and lifecycle can advance.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).first()

    initial_reserved_beds = hosp.reserved_emergency_beds or 0

    # 1. Create dispatch
    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )
    assert disp.coordination_status == "PENDING_CONFIRMATIONS"
    assert disp.ambulance_confirmation_status == "PENDING"
    assert disp.hospital_confirmation_status == "PENDING"

    db.refresh(amb)
    db.refresh(hosp)
    db.refresh(inc)
    assert amb.status == "RESERVED"
    assert amb.reservation_dispatch_id == disp.id
    assert hosp.reserved_emergency_beds == initial_reserved_beds + 1
    assert inc.status == "ALLOCATED"

    # 2. Cannot advance lifecycle before dual confirmation
    with pytest.raises(HTTPException) as exc_info:
        advance_dispatch_lifecycle(dispatch_id=disp.id, db=db)
    assert exc_info.value.status_code == 400

    # 3. Ambulance accepts
    disp = confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    assert disp.ambulance_confirmation_status == "ACCEPTED"
    assert disp.coordination_status == "PENDING_CONFIRMATIONS"  # Hospital still pending!

    # 4. Hospital accepts
    disp = confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    assert disp.hospital_confirmation_status == "ACCEPTED"
    assert disp.coordination_status == "CONFIRMED"
    assert disp.confirmed_at is not None

    db.refresh(amb)
    db.refresh(inc)
    assert amb.status == "DISPATCHED"
    assert inc.status == "DISPATCHED"

    # 5. Lifecycle can now advance
    step1 = advance_dispatch_lifecycle(disp.id, db=db)
    assert step1.status == "EN_ROUTE_INCIDENT"

def test_ambulance_rejection_releases_reservations(fresh_db):
    """
    Test Feature 2: Ambulance rejects -> previous reservation is released and smart escalation
    automatically assigns the next available ambulance with attempt_number incremented.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).first()
    initial_reserved = hosp.reserved_emergency_beds or 0

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )
    assert amb.status == "RESERVED"
    assert hosp.reserved_emergency_beds == initial_reserved + 1
    assert disp.attempt_number == 1

    # Ambulance rejects -> triggers automatic smart emergency escalation!
    disp = confirm_ambulance(
        disp.id,
        ConfirmationDecision(decision="REJECTED", reason="Crew unavailable due to emergency maintenance"),
        db=db,
    )
    # Automatically escalated to attempt 2 with a replacement ambulance!
    assert disp.attempt_number == 2
    assert disp.ambulance_id != amb.id
    assert disp.coordination_status == "PENDING_CONFIRMATIONS"
    assert disp.ambulance_confirmation_status == "PENDING"
    assert len(disp.escalation_history) == 1
    assert disp.escalation_history[0]["failure_source"] == "AMBULANCE"
    assert disp.escalation_history[0]["failed_ambulance_id"] == amb.id

    # The old ambulance must have been released back to AVAILABLE
    db.refresh(amb)
    assert amb.status == "AVAILABLE"
    assert amb.reservation_dispatch_id is None

def test_hospital_rejection_releases_reservations(fresh_db):
    """
    Test Feature 2: Hospital rejects -> previous reservation is released and smart escalation
    automatically reassigns to an alternative hospital/ambulance.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).first()
    initial_reserved = hosp.reserved_emergency_beds or 0

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )

    # Hospital rejects -> triggers automatic smart escalation
    disp = confirm_hospital(
        disp.id,
        ConfirmationDecision(decision="REJECTED", reason="Trauma bay full"),
        db=db,
    )
    assert disp.attempt_number == 2
    assert disp.coordination_status == "PENDING_CONFIRMATIONS"
    assert len(disp.escalation_history) == 1
    assert disp.escalation_history[0]["failure_source"] == "HOSPITAL"

    # Old ambulance released
    db.refresh(amb)
    assert amb.status == "AVAILABLE"

def test_reservation_expiration_flow(fresh_db):
    """
    Test Feature 2: Reservation expires -> automatic escalation assigns next candidate and restarts TTL.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )
    assert amb.status == "RESERVED"

    # Fast forward reservation_expires_at to the past
    disp.reservation_expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=10)
    db.commit()

    # Trigger expiration check
    result = check_expirations(db=db)
    assert disp.id in result["expired_dispatch_ids"]

    db.refresh(disp)
    db.refresh(amb)
    db.refresh(hosp)
    assert disp.attempt_number == 2
    assert disp.coordination_status == "PENDING_CONFIRMATIONS"
    assert len(disp.escalation_history) == 1
    assert disp.escalation_history[0]["failure_source"] == "TIMEOUT"
    assert amb.status == "AVAILABLE"

def test_ambulance_cannot_be_double_reserved(fresh_db):
    """
    Test: Ambulance cannot be provisionally reserved for two active dispatches.
    """
    db = fresh_db
    incidents = db.query(Incident).all()
    if len(incidents) < 2:
        # Create a second incident
        inc2 = create_incident(
            IncidentCreate(
                caller_name="Pooja Rao",
                caller_phone="+91 99001 22334",
                location_address="Bunder Port Road, Mangaluru",
                latitude=12.8550,
                longitude=74.8350,
                chief_complaint="Fall injury with bleeding",
            ),
            db=db,
        )
        incidents = [incidents[0], inc2]

    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).first()

    # Dispatch 1 reserves the ambulance
    d1 = create_dispatch(
        DispatchRequest(incident_id=incidents[0].id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )
    assert amb.status == "RESERVED"

    # Dispatch 2 tries to reserve the SAME ambulance
    with pytest.raises(HTTPException) as exc_info:
        create_dispatch(
            DispatchRequest(incident_id=incidents[1].id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
            db=db,
        )
    assert exc_info.value.status_code in [400, 409]
    assert "cannot be dispatched" in exc_info.value.detail or "cannot be reserved" in exc_info.value.detail

def test_hospital_cannot_be_over_reserved(fresh_db):
    """
    Test: Hospital capacity cannot be over-reserved.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).first()

    # Simulate hospital having 0 available unreserved emergency beds
    hosp.available_emergency_beds = 1
    hosp.reserved_emergency_beds = 1
    db.commit()

    with pytest.raises(HTTPException) as exc_info:
        create_dispatch(
            DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
            db=db,
        )
    assert exc_info.value.status_code == 409
    assert "no remaining unreserved emergency bays" in exc_info.value.detail

def test_idempotent_confirmation_requests(fresh_db):
    """
    Test: Duplicate confirmation requests must be idempotent.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )

    # First accept
    d_first = confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    first_timestamp = d_first.ambulance_confirmed_at

    # Duplicate accept
    d_second = confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    assert d_second.ambulance_confirmation_status == "ACCEPTED"
    assert d_second.ambulance_confirmed_at == first_timestamp

def test_reassignment_flow(fresh_db):
    """
    Test: Reassignment must select another eligible resource and restart confirmations.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    available_ambs = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").all()
    assert len(available_ambs) >= 2
    first_amb = available_ambs[0]
    hosp = db.query(Hospital).first()

    # 1. First dispatch
    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=first_amb.id, destination_hospital_id=hosp.id),
        db=db,
    )
    assert disp.attempt_number == 1
    assert disp.ambulance_id == first_amb.id

    # 2. Ambulance rejects -> Auto-escalates to attempt 2
    disp = confirm_ambulance(disp.id, ConfirmationDecision(decision="REJECTED", reason="Breakdown"), db=db)
    assert disp.attempt_number == 2
    assert disp.ambulance_id != first_amb.id
    assert disp.coordination_status == "PENDING_CONFIRMATIONS"
    attempt2_amb_id = disp.ambulance_id

    # 3. Manual dispatcher reassignment trigger -> escalates to attempt 3
    reassigned_disp = reassign_dispatch(disp.id, db=db)
    assert reassigned_disp.attempt_number == 3
    assert reassigned_disp.ambulance_id != first_amb.id
    assert reassigned_disp.ambulance_id != attempt2_amb_id
    assert reassigned_disp.coordination_status == "PENDING_CONFIRMATIONS"
    assert reassigned_disp.ambulance_confirmation_status == "PENDING"
    assert reassigned_disp.hospital_confirmation_status == "PENDING"
    assert reassigned_disp.reservation_expires_at is not None

    new_amb = db.query(Ambulance).filter(Ambulance.id == reassigned_disp.ambulance_id).first()
    assert new_amb.status == "RESERVED"
    assert new_amb.reservation_dispatch_id == reassigned_disp.id

def test_escalation_exhaustion_marks_reassignment_required(fresh_db):
    """
    Test Feature 2: When all alternative ambulances are unavailable or exhausted,
    dispatch is marked REASSIGNMENT_REQUIRED and incident preserved for dispatcher intervention.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    available_ambs = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").all()

    # Mark all except 1 ambulance as busy
    for amb in available_ambs[1:]:
        amb.status = "MAINTENANCE"
    db.commit()

    only_amb = available_ambs[0]
    hosp = db.query(Hospital).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=only_amb.id, destination_hospital_id=hosp.id),
        db=db,
    )
    assert disp.attempt_number == 1

    # The only available ambulance rejects
    disp = confirm_ambulance(disp.id, ConfirmationDecision(decision="REJECTED", reason="Flat tire"), db=db)

    # Escalation runs, finds no alternative ambulances, and safely sets REASSIGNMENT_REQUIRED
    assert disp.coordination_status == "REASSIGNMENT_REQUIRED"
    assert len(disp.escalation_history) == 1
    assert disp.escalation_history[0]["escalation_result"] == "REASSIGNMENT_REQUIRED_NO_ALTERNATIVES"

    # Incident preserved in TRIAGED
    db.refresh(inc)
    assert inc.status == "TRIAGED"

