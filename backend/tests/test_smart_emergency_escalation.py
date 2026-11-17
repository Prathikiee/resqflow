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
    check_and_escalate_expired_dispatches,
    reassign_dispatch,
)
from backend.app.schemas.dispatch import (
    DispatchRequest,
    ConfirmationDecision,
)

@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    seed_database(session, force=True)
    yield session
    session.close()

def test_smart_escalation_demo_scenario(fresh_db):
    """
    FEATURE 2 DEMO SCENARIO:
    1. Incident registered in Mangaluru.
    2. Ambulance A and Hospital A provisionally reserved (Attempt #1).
    3. Ambulance A rejects assignment.
    4. Auto-escalation triggers instantly:
       - Ambulance A released to AVAILABLE.
       - Ambulance B provisionally reserved.
       - Attempt #2 started with fresh 90s TTL.
       - Audit history recorded.
    5. Ambulance B and Hospital A accept.
    6. Coordination promoted to CONFIRMED and vehicle advances.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    available_ambs = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").all()
    assert len(available_ambs) >= 2
    amb_a = available_ambs[0]
    hosp_a = db.query(Hospital).first()

    # Step 1: Create initial dispatch
    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb_a.id, destination_hospital_id=hosp_a.id),
        db=db,
    )
    assert disp.attempt_number == 1
    assert disp.ambulance_id == amb_a.id
    assert disp.coordination_status == "PENDING_CONFIRMATIONS"
    assert amb_a.status == "RESERVED"

    # Step 2: Ambulance A rejects
    disp = confirm_ambulance(
        disp.id,
        ConfirmationDecision(decision="REJECTED", reason="Crew dispatched to higher priority trauma"),
        db=db,
    )

    # Step 3: Verify automatic escalation
    assert disp.attempt_number == 2
    assert disp.ambulance_id != amb_a.id  # Replaced with alternative unit
    assert disp.coordination_status == "PENDING_CONFIRMATIONS"
    assert disp.ambulance_confirmation_status == "PENDING"
    assert disp.hospital_confirmation_status == "PENDING"
    assert disp.reservation_expires_at is not None

    # Verify previous ambulance A released back to AVAILABLE
    db.refresh(amb_a)
    assert amb_a.status == "AVAILABLE"
    assert amb_a.reservation_dispatch_id is None

    # Verify replacement ambulance B is now RESERVED
    amb_b = db.query(Ambulance).filter(Ambulance.id == disp.ambulance_id).first()
    assert amb_b.status == "RESERVED"
    assert amb_b.reservation_dispatch_id == disp.id

    # Verify Escalation Audit History
    assert len(disp.escalation_history) == 1
    entry = disp.escalation_history[0]
    assert entry["attempt_number"] == 1
    assert entry["failed_ambulance_id"] == amb_a.id
    assert entry["failure_source"] == "AMBULANCE"
    assert "higher priority trauma" in entry["failure_reason"]
    assert entry["replacement_ambulance_id"] == amb_b.id
    assert entry["escalation_result"] == "SUCCESSFULLY_ESCALATED"
    assert "timestamp" in entry

    # Step 4: Replacement Ambulance B and Hospital accept
    disp = confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    disp = confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)

    # Step 5: Verification of CONFIRMED state & lifecycle progression
    assert disp.coordination_status == "CONFIRMED"
    db.refresh(amb_b)
    db.refresh(inc)
    assert amb_b.status == "DISPATCHED"
    assert inc.status == "DISPATCHED"

    step = advance_dispatch_lifecycle(disp.id, db=db)
    assert step.status == "EN_ROUTE_INCIDENT"

def test_smart_escalation_on_hospital_rejection(fresh_db):
    """
    Test: Hospital rejects -> auto-escalates to alternative hospital, preserves or reassigns ambulance.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )

    disp = confirm_hospital(
        disp.id,
        ConfirmationDecision(decision="REJECTED", reason="No neurosurgery coverage tonight"),
        db=db,
    )

    assert disp.attempt_number == 2
    assert disp.coordination_status == "PENDING_CONFIRMATIONS"
    assert len(disp.escalation_history) == 1
    assert disp.escalation_history[0]["failure_source"] == "HOSPITAL"
    assert "neurosurgery" in disp.escalation_history[0]["failure_reason"]

def test_smart_escalation_on_timeout_sweep(fresh_db):
    """
    Test: Background sweep detects expired reservation and automatically escalates.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )

    # Expire reservation
    disp.reservation_expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=5)
    db.commit()

    # Run sweep
    escalated_ids = check_and_escalate_expired_dispatches(db=db)
    assert disp.id in escalated_ids

    db.refresh(disp)
    assert disp.attempt_number == 2
    assert disp.coordination_status == "PENDING_CONFIRMATIONS"
    assert len(disp.escalation_history) == 1
    assert disp.escalation_history[0]["failure_source"] == "TIMEOUT"

def test_smart_escalation_no_alternatives_preserves_incident(fresh_db):
    """
    Test: If no compatible alternative units exist, status becomes REASSIGNMENT_REQUIRED,
    incident is preserved in queue, and history records the exhaustion.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    all_ambs = db.query(Ambulance).all()

    # Put all ambulances except one on MAINTENANCE
    for a in all_ambs[1:]:
        a.status = "MAINTENANCE"
    db.commit()

    only_amb = all_ambs[0]
    hosp = db.query(Hospital).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=only_amb.id, destination_hospital_id=hosp.id),
        db=db,
    )

    # The lone ambulance rejects
    disp = confirm_ambulance(
        disp.id,
        ConfirmationDecision(decision="REJECTED", reason="Engine failure"),
        db=db,
    )

    # No alternatives exist -> REASSIGNMENT_REQUIRED
    assert disp.coordination_status == "REASSIGNMENT_REQUIRED"
    assert len(disp.escalation_history) == 1
    assert disp.escalation_history[0]["escalation_result"] == "REASSIGNMENT_REQUIRED_NO_ALTERNATIVES"

    db.refresh(inc)
    assert inc.status == "TRIAGED"
