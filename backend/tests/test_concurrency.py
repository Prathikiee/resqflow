import pytest
import threading
import concurrent.futures
from datetime import datetime, timezone, timedelta
from fastapi import HTTPException
from sqlalchemy.orm import Session
from backend.app.core.database import SessionLocal, Base, engine
from backend.app.models.entities import Incident, Ambulance, Hospital, Dispatch, HandoverPacket, IncidentEvent
from backend.app.services.seed_service import seed_database
from backend.app.api.incidents import create_incident
from backend.app.schemas.incident import IncidentCreate
from backend.app.api.dispatch import (
    create_dispatch,
    advance_dispatch_lifecycle,
    confirm_ambulance,
    confirm_hospital,
    reassign_dispatch,
    auto_escalate_dispatch,
    check_and_escalate_expired_dispatches,
    acknowledge_handover_packet,
    get_handover_packet,
)
from backend.app.schemas.dispatch import (
    DispatchRequest,
    ConfirmationDecision,
    HandoverAcknowledgeRequest,
)

@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    seed_database(session, force=True)
    yield session
    session.close()

def test_concurrent_dual_confirmation(fresh_db):
    """
    Scenario 1: Two threads submit acceptance simultaneously (ambulance crew and hospital ER).
    Both must succeed, the dispatch must transition to CONFIRMED, and Handover Packet
    must be generated exactly once without duplicates.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )
    dispatch_id = disp.id

    barrier = threading.Barrier(2)

    def amb_worker():
        barrier.wait()
        s = SessionLocal()
        try:
            return confirm_ambulance(dispatch_id, ConfirmationDecision(decision="ACCEPTED"), db=s)
        finally:
            s.close()

    def hosp_worker():
        barrier.wait()
        s = SessionLocal()
        try:
            return confirm_hospital(dispatch_id, ConfirmationDecision(decision="ACCEPTED"), db=s)
        finally:
            s.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        f_amb = executor.submit(amb_worker)
        f_hosp = executor.submit(hosp_worker)
        res_amb = f_amb.result(timeout=25)
        res_hosp = f_hosp.result(timeout=25)

    # In a fresh session, verify final state
    s_verify = SessionLocal()
    try:
        final_disp = s_verify.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
        assert final_disp.coordination_status == "CONFIRMED"
        assert final_disp.ambulance_confirmation_status == "ACCEPTED"
        assert final_disp.hospital_confirmation_status == "ACCEPTED"
        assert final_disp.confirmed_at is not None

        # Handover packet must exist and be unique
        packets = s_verify.query(HandoverPacket).filter(HandoverPacket.dispatch_id == dispatch_id).all()
        assert len(packets) == 1
        assert packets[0].status == "SENT"

        # Check ambulance and incident status
        final_amb = s_verify.query(Ambulance).filter(Ambulance.id == final_disp.ambulance_id).first()
        final_inc = s_verify.query(Incident).filter(Incident.id == final_disp.incident_id).first()
        assert final_amb.status == "DISPATCHED"
        assert final_inc.status == "DISPATCHED"
    finally:
        s_verify.close()

def test_concurrent_ambulance_reservation(fresh_db):
    """
    Scenario 2: Two concurrent dispatch creations targeting the same available ambulance.
    Exactly one must succeed, and the other must be rejected with 409 Conflict.
    """
    db = fresh_db
    inc1 = db.query(Incident).all()[0]
    inc2 = create_incident(
        IncidentCreate(
            caller_name="Test Witness",
            caller_phone="+91 99999 88888",
            location_address="State Bank Circle, Mangaluru",
            latitude=12.8600,
            longitude=74.8400,
            chief_complaint="Severe head injury",
        ),
        db=db,
    )
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()

    barrier = threading.Barrier(2)

    def dispatch_worker(incident_id):
        barrier.wait()
        s = SessionLocal()
        try:
            res = create_dispatch(
                DispatchRequest(incident_id=incident_id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
                db=s,
            )
            return {"status": "SUCCESS", "id": res.id}
        except HTTPException as e:
            return {"status": "FAILED", "code": e.status_code, "detail": e.detail}
        finally:
            s.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        f1 = executor.submit(dispatch_worker, inc1.id)
        f2 = executor.submit(dispatch_worker, inc2.id)
        res1 = f1.result(timeout=25)
        res2 = f2.result(timeout=25)

    results = [res1, res2]
    successes = [r for r in results if r["status"] == "SUCCESS"]
    failures = [r for r in results if r["status"] == "FAILED"]

    assert len(successes) == 1, f"Expected exactly 1 success, got: {results}"
    assert len(failures) == 1, f"Expected exactly 1 failure, got: {results}"
    assert failures[0]["code"] in [400, 409]

    # Verify database state
    s_verify = SessionLocal()
    try:
        amb_check = s_verify.query(Ambulance).filter(Ambulance.id == amb.id).first()
        assert amb_check.status == "RESERVED"
        assert amb_check.reservation_dispatch_id == successes[0]["id"]
    finally:
        s_verify.close()

def test_concurrent_hospital_capacity_reservation(fresh_db):
    """
    Scenario 3: Two concurrent dispatches targeting the last available emergency bed in a hospital.
    Exactly one must succeed and reserve the bed; the other must fail with 409 Conflict.
    """
    db = fresh_db
    inc1 = db.query(Incident).all()[0]
    inc2 = create_incident(
        IncidentCreate(
            caller_name="Concurrent Caller",
            caller_phone="+91 99999 11111",
            location_address="Kadri Road, Mangaluru",
            latitude=12.8700,
            longitude=74.8500,
            chief_complaint="Chest pain acute",
        ),
        db=db,
    )
    ambs = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").all()
    assert len(ambs) >= 2
    amb1, amb2 = ambs[0], ambs[1]

    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()
    # Constrain available beds to exactly 1
    hosp.available_emergency_beds = 1
    hosp.reserved_emergency_beds = 0
    db.commit()

    barrier = threading.Barrier(2)

    def dispatch_worker(inc_id, amb_id):
        barrier.wait()
        s = SessionLocal()
        try:
            res = create_dispatch(
                DispatchRequest(incident_id=inc_id, ambulance_id=amb_id, destination_hospital_id=hosp.id),
                db=s,
            )
            return {"status": "SUCCESS", "id": res.id}
        except HTTPException as e:
            return {"status": "FAILED", "code": e.status_code, "detail": e.detail}
        finally:
            s.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        f1 = executor.submit(dispatch_worker, inc1.id, amb1.id)
        f2 = executor.submit(dispatch_worker, inc2.id, amb2.id)
        res1 = f1.result(timeout=25)
        res2 = f2.result(timeout=25)

    results = [res1, res2]
    successes = [r for r in results if r["status"] == "SUCCESS"]
    failures = [r for r in results if r["status"] == "FAILED"]

    assert len(successes) == 1, f"Expected exactly 1 success, got: {results}"
    assert len(failures) == 1, f"Expected exactly 1 failure, got: {results}"
    assert failures[0]["code"] == 409

    s_verify = SessionLocal()
    try:
        hosp_check = s_verify.query(Hospital).filter(Hospital.id == hosp.id).first()
        assert hosp_check.reserved_emergency_beds == 1
    finally:
        s_verify.close()

def test_escalation_racing_with_reassignment(fresh_db):
    """
    Scenario 4: An auto-escalation (e.g. timeout sweep) races with manual dispatcher reassignment.
    Both specify expected_attempt=1. Exactly one escalation must execute, attempt_number increments by 1,
    and history records exactly 1 entry.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )
    dispatch_id = disp.id
    assert disp.attempt_number == 1

    # Fast forward reservation_expires_at to the past so timeout sweep sees it as expired
    disp.reservation_expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=10)
    db.commit()

    barrier = threading.Barrier(2)

    def manual_worker():
        barrier.wait()
        s = SessionLocal()
        try:
            return reassign_dispatch(dispatch_id, expected_attempt=1, db=s)
        except Exception as e:
            return e
        finally:
            s.close()

    def timeout_worker():
        barrier.wait()
        s = SessionLocal()
        try:
            return check_and_escalate_expired_dispatches(db=s)
        except Exception as e:
            return e
        finally:
            s.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        f1 = executor.submit(manual_worker)
        f2 = executor.submit(timeout_worker)
        f1.result(timeout=25)
        f2.result(timeout=25)

    s_verify = SessionLocal()
    try:
        disp_check = s_verify.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
        # Exactly one escalation must have occurred
        assert disp_check.attempt_number == 2
        assert len(disp_check.escalation_history) == 1
    finally:
        s_verify.close()

def test_concurrent_handover_acknowledgment(fresh_db):
    """
    Scenario 5: Two hospital ER staff members click Acknowledge simultaneously.
    First caller sets definitive timestamp and staff identity; second receives idempotent response
    preserving the initial timestamp, and only 1 timeline event is logged.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )
    confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)

    dispatch_id = disp.id
    barrier = threading.Barrier(2)

    def ack_worker(name):
        barrier.wait()
        s = SessionLocal()
        try:
            return acknowledge_handover_packet(
                dispatch_id=dispatch_id,
                payload=HandoverAcknowledgeRequest(acknowledged_by=name),
                db=s,
            )
        finally:
            s.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        f1 = executor.submit(ack_worker, "Dr. Alice (Triage)")
        f2 = executor.submit(ack_worker, "Nurse Bob (Intake)")
        pkt1 = f1.result(timeout=25)
        pkt2 = f2.result(timeout=25)

    assert pkt1.status == "ACKNOWLEDGED"
    assert pkt2.status == "ACKNOWLEDGED"
    # Both must report the same acknowledged_at timestamp
    assert pkt1.acknowledged_at == pkt2.acknowledged_at
    assert pkt1.acknowledged_by in ["Dr. Alice (Triage)", "Nurse Bob (Intake)"]
    assert pkt2.acknowledged_by == pkt1.acknowledged_by

    s_verify = SessionLocal()
    try:
        events = s_verify.query(IncidentEvent).filter(
            IncidentEvent.dispatch_id == dispatch_id,
            IncidentEvent.event_type == "HANDOVER_ACKNOWLEDGED",
        ).all()
        assert len(events) == 1, f"Expected exactly 1 timeline event, got {len(events)}"
    finally:
        s_verify.close()

def test_concurrent_lifecycle_advancement(fresh_db):
    """
    Scenario 6: Two concurrent advance_dispatch_lifecycle calls specifying expected_status.
    One must advance the stage; the second must receive a 409 Conflict.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )
    confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)

    dispatch_id = disp.id
    assert disp.status == "ASSIGNED"

    barrier = threading.Barrier(2)

    def step_worker():
        barrier.wait()
        s = SessionLocal()
        try:
            res = advance_dispatch_lifecycle(dispatch_id, expected_status="ASSIGNED", db=s)
            return {"status": "SUCCESS", "disp_status": res.status}
        except HTTPException as e:
            return {"status": "FAILED", "code": e.status_code, "detail": e.detail}
        finally:
            s.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        f1 = executor.submit(step_worker)
        f2 = executor.submit(step_worker)
        res1 = f1.result(timeout=25)
        res2 = f2.result(timeout=25)

    results = [res1, res2]
    successes = [r for r in results if r["status"] == "SUCCESS"]
    conflicts = [r for r in results if r["status"] == "FAILED" and r["code"] == 409]

    assert len(successes) == 1, f"Expected 1 success, got: {results}"
    assert len(conflicts) == 1, f"Expected 1 conflict, got: {results}"
    assert successes[0]["disp_status"] == "EN_ROUTE_INCIDENT"

def test_repeated_advancement_after_completion(fresh_db):
    """
    Scenario 7: Attempting to advance a dispatch past COMPLETED must be rejected with 400.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )
    confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)

    # Step: ASSIGNED -> EN_ROUTE_INCIDENT -> ON_SCENE -> EN_ROUTE_HOSPITAL -> COMPLETED
    advance_dispatch_lifecycle(disp.id, db=db)
    advance_dispatch_lifecycle(disp.id, db=db)
    advance_dispatch_lifecycle(disp.id, db=db)
    comp = advance_dispatch_lifecycle(disp.id, db=db)
    assert comp.status == "COMPLETED"

    # Repeated step past completed must raise 400
    with pytest.raises(HTTPException) as exc_info:
        advance_dispatch_lifecycle(disp.id, db=db)
    assert exc_info.value.status_code == 400
    assert "terminal stage" in exc_info.value.detail.lower()

def test_allocation_failure_rollback(fresh_db):
    """
    Scenario 8: If dispatch creation fails partway (e.g. invalid hospital bed capacity or inactive unit),
    the transaction must cleanly roll back — no partial reservation or orphaned dispatch records.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()

    # Create dispatch with non-existent hospital id
    with pytest.raises(HTTPException) as exc_info:
        create_dispatch(
            DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=99999),
            db=db,
        )
    assert exc_info.value.status_code == 404

    # Ensure ambulance is still AVAILABLE and no dispatch was created
    db.refresh(amb)
    assert amb.status == "AVAILABLE"
    assert amb.reservation_dispatch_id is None

    disp_count = db.query(Dispatch).filter(Dispatch.incident_id == inc.id).count()
    assert disp_count == 0
