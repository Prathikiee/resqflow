import pytest
from datetime import datetime, timezone, timedelta
from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend.app.models.entities import (
    Incident,
    Ambulance,
    Hospital,
    Dispatch,
    IncidentEvent,
    User,
)
from backend.app.schemas.incident import IncidentCreate
from backend.app.schemas.dispatch import (
    DispatchRequest,
    ConfirmationDecision,
    IncidentCancelRequest,
    IncidentCloseRequest,
    IncidentStatusUpdate,
)
from backend.app.api.incidents import (
    create_incident,
    get_incident,
    cancel_incident,
    close_incident,
    update_incident_status,
)
from backend.app.api.dispatch import (
    create_dispatch,
    confirm_ambulance,
    confirm_hospital,
    reassign_dispatch,
    check_and_escalate_expired_dispatches,
    validate_dispatch_preflight,
)
from backend.app.core.auth import (
    ROLE_CITIZEN,
    ROLE_DISPATCHER,
    ROLE_AMBULANCE_CREW,
    ROLE_HOSPITAL_STAFF,
    ROLE_SUPER_ADMIN,
)


def _get_demo_users(db: Session):
    dispatcher = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    citizen = db.query(User).filter(User.role == ROLE_CITIZEN).first()
    crew = db.query(User).filter(User.role == ROLE_AMBULANCE_CREW).first()
    hospital_staff = db.query(User).filter(User.role == ROLE_HOSPITAL_STAFF).first()
    admin = db.query(User).filter(User.role == ROLE_SUPER_ADMIN).first()
    return {
        "dispatcher": dispatcher,
        "citizen": citizen,
        "crew": crew,
        "hospital_staff": hospital_staff,
        "admin": admin,
    }


# =============================================================================
# 1. Successful citizen cancellation
# =============================================================================
def test_successful_citizen_cancellation(db: Session):
    users = _get_demo_users(db)
    citizen = users["citizen"]

    # Create incident attributed to citizen
    new_inc = IncidentCreate(
        caller_name=citizen.full_name,
        caller_phone=citizen.phone_number or "+91 98451 99887",
        location_address="Hampankatta Market, Mangaluru",
        latitude=12.8700,
        longitude=74.8420,
        chief_complaint="Fall on stairs, mild dizziness, conscious and breathing",
        patient_age=28,
        patient_gender="Male",
    )
    inc = create_incident(payload=new_inc, db=db, current_user=citizen)
    assert inc.id is not None
    assert inc.status == "TRIAGED"
    assert inc.reporter_user_id == citizen.id

    # Citizen cancels incident
    cancelled_inc = cancel_incident(
        incident_id=inc.id,
        payload=IncidentCancelRequest(reason="Assistance no longer needed; relative arrived"),
        db=db,
        current_user=citizen,
    )

    assert cancelled_inc.status == "CANCELLED"
    db.refresh(inc)
    assert inc.status == "CANCELLED"

    # Verify timeline event logged
    events = db.query(IncidentEvent).filter(
        IncidentEvent.incident_id == inc.id,
        IncidentEvent.event_type == "INCIDENT_CANCELLED",
    ).all()
    assert len(events) >= 1
    assert "relative arrived" in events[0].event_description


# =============================================================================
# 2. Unauthorized cancellation rejection
# =============================================================================
def test_invalid_cancellation_by_unauthorized_role(db: Session):
    users = _get_demo_users(db)
    citizen = users["citizen"]
    crew = users["crew"]
    hospital_staff = users["hospital_staff"]

    # Create incident owned by citizen
    new_inc = IncidentCreate(
        caller_name="Ananya Rao",
        caller_phone="+91 99000 11223",
        location_address="Kodialbail, Mangaluru",
        latitude=12.8805,
        longitude=74.8430,
        chief_complaint="Severe asthma attack, wheezing",
        patient_age=32,
    )
    inc = create_incident(payload=new_inc, db=db, current_user=citizen)

    # Another citizen cannot cancel
    other_citizen = db.query(User).filter(User.role == ROLE_CITIZEN, User.id != citizen.id).first()
    if not other_citizen:
        other_citizen = User(
            email=f"other_citizen_{int(datetime.now(timezone.utc).timestamp())}@example.com",
            full_name="Other Citizen",
            role=ROLE_CITIZEN,
            password_hash="fake",
        )
        db.add(other_citizen)
        db.commit()
        db.refresh(other_citizen)

    with pytest.raises(HTTPException) as exc_info:
        cancel_incident(
            incident_id=inc.id,
            payload=IncidentCancelRequest(reason="Malicious cancellation"),
            db=db,
            current_user=other_citizen,
        )
    assert exc_info.value.status_code == 403
    assert "access denied" in exc_info.value.detail.lower() or "only cancel their own" in exc_info.value.detail.lower()

    # Ambulance crew cannot cancel
    with pytest.raises(HTTPException) as exc_info:
        cancel_incident(
            incident_id=inc.id,
            payload=IncidentCancelRequest(reason="Crew attempting cancellation"),
            db=db,
            current_user=crew,
        )
    assert exc_info.value.status_code == 403

    # Hospital staff cannot cancel
    with pytest.raises(HTTPException) as exc_info:
        cancel_incident(
            incident_id=inc.id,
            payload=IncidentCancelRequest(reason="Hospital attempting cancellation"),
            db=db,
            current_user=hospital_staff,
        )
    assert exc_info.value.status_code == 403


# =============================================================================
# 3. Cancellation of incident with active dispatch releases ambulance & hospital
# =============================================================================
def test_cancellation_releases_ambulance_and_hospital_reservations(db: Session):
    users = _get_demo_users(db)
    dispatcher = users["dispatcher"]

    # Find available ambulance and hospital
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    assert amb is not None
    hosp = db.query(Hospital).first()
    assert hosp is not None

    initial_hosp_reserved_beds = hosp.reserved_emergency_beds or 0

    # Create incident
    inc = create_incident(
        payload=IncidentCreate(
            caller_name="Praveen D",
            caller_phone="+91 98888 77777",
            location_address="Kuntikan NH 66, Mangaluru",
            latitude=12.8990,
            longitude=74.8465,
            chief_complaint="Two wheeler collision, leg fracture",
        ),
        db=db,
        current_user=dispatcher,
    )

    # Dispatch ambulance
    disp = create_dispatch(
        DispatchRequest(
            incident_id=inc.id,
            ambulance_id=amb.id,
            destination_hospital_id=hosp.id,
        ),
        db=db,
        current_user=dispatcher,
    )

    db.refresh(amb)
    db.refresh(hosp)
    assert amb.status == "RESERVED"
    assert amb.reservation_dispatch_id == disp.id
    assert hosp.reserved_emergency_beds == initial_hosp_reserved_beds + 1
    assert disp.status == "ASSIGNED"

    # Cancel incident via dispatcher
    cancel_incident(
        incident_id=inc.id,
        payload=IncidentCancelRequest(reason="Patient cleared by local doctor on scene"),
        db=db,
        current_user=dispatcher,
    )

    # Verify resources released
    db.refresh(amb)
    db.refresh(hosp)
    db.refresh(disp)
    db.refresh(inc)

    assert inc.status == "CANCELLED"
    assert amb.status == "AVAILABLE"
    assert amb.reservation_dispatch_id is None
    assert hosp.reserved_emergency_beds == initial_hosp_reserved_beds
    assert disp.status == "CANCELLED"
    assert disp.coordination_status == "CANCELLED"


# =============================================================================
# 4. Duplicate cancellation idempotency
# =============================================================================
def test_cancellation_idempotency(db: Session):
    users = _get_demo_users(db)
    dispatcher = users["dispatcher"]

    inc = create_incident(
        payload=IncidentCreate(
            caller_name="Ramesh Poojary",
            caller_phone="+91 97777 66666",
            location_address="Pumpwell Circle, Mangaluru",
            latitude=12.8615,
            longitude=74.8700,
            chief_complaint="Minor burn injury",
        ),
        db=db,
        current_user=dispatcher,
    )

    # First cancellation
    res1 = cancel_incident(
        incident_id=inc.id,
        payload=IncidentCancelRequest(reason="Minor burn self-treated"),
        db=db,
        current_user=dispatcher,
    )
    assert res1.status == "CANCELLED"

    # Second cancellation (idempotent call)
    res2 = cancel_incident(
        incident_id=inc.id,
        payload=IncidentCancelRequest(reason="Duplicate cancel request"),
        db=db,
        current_user=dispatcher,
    )
    assert res2.status == "CANCELLED"
    assert res2.id == inc.id


# =============================================================================
# 5. Cannot cancel resolved or closed incident
# =============================================================================
def test_cannot_cancel_resolved_or_closed_incident(db: Session):
    users = _get_demo_users(db)
    dispatcher = users["dispatcher"]

    inc = create_incident(
        payload=IncidentCreate(
            caller_name="Mahesh Kumar",
            caller_phone="+91 96666 55555",
            location_address="Surathkal Beach Road, Mangaluru",
            latitude=12.9815,
            longitude=74.7950,
            chief_complaint="Near drowning rescued by lifeguards",
        ),
        db=db,
        current_user=dispatcher,
    )

    # Manually transition to RESOLVED
    inc.status = "RESOLVED"
    db.commit()

    with pytest.raises(HTTPException) as exc_info:
        cancel_incident(
            incident_id=inc.id,
            payload=IncidentCancelRequest(reason="Try canceling resolved case"),
            db=db,
            current_user=dispatcher,
        )
    assert exc_info.value.status_code == 400
    assert "terminal stage" in exc_info.value.detail.lower()

    # Transition to CLOSED
    inc.status = "CLOSED"
    db.commit()

    with pytest.raises(HTTPException) as exc_info:
        cancel_incident(
            incident_id=inc.id,
            payload=IncidentCancelRequest(reason="Try canceling closed case"),
            db=db,
            current_user=dispatcher,
        )
    assert exc_info.value.status_code == 400
    assert "terminal stage" in exc_info.value.detail.lower()


# =============================================================================
# 6. Smart manual allocation pre-flight validation
# =============================================================================
def test_manual_allocation_preflight_validation(db: Session):
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).first()
    assert amb is not None
    assert hosp is not None

    inc = create_incident(
        payload=IncidentCreate(
            caller_name="Vinod Nayak",
            caller_phone="+91 95555 44444",
            location_address="Kadri Park, Mangaluru",
            latitude=12.8760,
            longitude=74.8560,
            chief_complaint="Suspected stroke, left side numbness",
        ),
        db=db,
    )

    # Case A: Valid scenario
    preflight = validate_dispatch_preflight(
        DispatchRequest(
            incident_id=inc.id,
            ambulance_id=amb.id,
            destination_hospital_id=hosp.id,
        ),
        db=db,
    )
    assert preflight.is_valid is True
    assert len(preflight.errors) == 0

    # Case B: Busy ambulance
    amb.status = "BUSY"
    db.commit()

    preflight_busy = validate_dispatch_preflight(
        DispatchRequest(
            incident_id=inc.id,
            ambulance_id=amb.id,
            destination_hospital_id=hosp.id,
        ),
        db=db,
    )
    assert preflight_busy.is_valid is False
    assert any("busy" in err.lower() or "expected 'available'" in err.lower() for err in preflight_busy.errors)

    # Reset ambulance
    amb.status = "AVAILABLE"
    db.commit()

    # Case C: Terminal incident status
    inc.status = "CANCELLED"
    db.commit()

    preflight_cancelled = validate_dispatch_preflight(
        DispatchRequest(
            incident_id=inc.id,
            ambulance_id=amb.id,
            destination_hospital_id=hosp.id,
        ),
        db=db,
    )
    assert preflight_cancelled.is_valid is False
    assert any("terminal stage" in err.lower() or "cannot be allocated" in err.lower() for err in preflight_cancelled.errors)

    # Case D: Duplicate active dispatch collision
    inc.status = "TRIAGED"
    db.commit()
    # Create active dispatch
    disp = create_dispatch(
        DispatchRequest(
            incident_id=inc.id,
            ambulance_id=amb.id,
            destination_hospital_id=hosp.id,
        ),
        db=db,
    )
    assert disp.id is not None

    # Check preflight now flags existing active dispatch
    preflight_dup = validate_dispatch_preflight(
        DispatchRequest(
            incident_id=inc.id,
            ambulance_id=amb.id,
            destination_hospital_id=hosp.id,
        ),
        db=db,
    )
    assert preflight_dup.is_valid is False
    assert any("already has an active dispatch" in err.lower() for err in preflight_dup.errors)


# =============================================================================
# 7. Duplicate dispatch prevention regression
# =============================================================================
def test_duplicate_dispatch_prevention(db: Session):
    ambs = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").all()
    assert len(ambs) >= 2
    hosp = db.query(Hospital).first()

    inc = create_incident(
        payload=IncidentCreate(
            caller_name="Deepak Pai",
            caller_phone="+91 94444 33333",
            location_address="Bunder, Mangaluru",
            latitude=12.8590,
            longitude=74.8380,
            chief_complaint="Industrial laceration",
        ),
        db=db,
    )

    # First dispatch creation succeeds
    disp1 = create_dispatch(
        DispatchRequest(
            incident_id=inc.id,
            ambulance_id=ambs[0].id,
            destination_hospital_id=hosp.id,
        ),
        db=db,
    )
    assert disp1.id is not None

    # Repeated dispatch creation must be rejected
    with pytest.raises(HTTPException) as exc_info:
        create_dispatch(
            DispatchRequest(
                incident_id=inc.id,
                ambulance_id=ambs[1].id,
                destination_hospital_id=hosp.id,
            ),
            db=db,
        )
    assert exc_info.value.status_code == 400
    assert "already has an active dispatch" in exc_info.value.detail


# =============================================================================
# 8. Incident formal closure from RESOLVED to CLOSED
# =============================================================================
def test_incident_formal_closure_success(db: Session):
    users = _get_demo_users(db)
    dispatcher = users["dispatcher"]

    inc = create_incident(
        payload=IncidentCreate(
            caller_name="Saritha Hegde",
            caller_phone="+91 93333 22222",
            location_address="Urwa Market, Mangaluru",
            latitude=12.8850,
            longitude=74.8350,
            chief_complaint="Severe allergic reaction",
        ),
        db=db,
        current_user=dispatcher,
    )

    # Set to RESOLVED (patient handover completed)
    inc.status = "RESOLVED"
    db.commit()

    # Dispatcher formally closes case
    closed_inc = close_incident(
        incident_id=inc.id,
        payload=IncidentCloseRequest(resolution_notes="Patient stabilized in ER; emergency closed"),
        db=db,
        current_user=dispatcher,
    )

    assert closed_inc.status == "CLOSED"
    db.refresh(inc)
    assert inc.status == "CLOSED"

    # Verify closure event in timeline
    event = db.query(IncidentEvent).filter(
        IncidentEvent.incident_id == inc.id,
        IncidentEvent.event_type == "INCIDENT_CLOSED",
    ).first()
    assert event is not None
    assert "Patient stabilized in ER" in event.event_description


# =============================================================================
# 9. Invalid closure from active non-RESOLVED status
# =============================================================================
def test_invalid_closure_from_active_status(db: Session):
    users = _get_demo_users(db)
    dispatcher = users["dispatcher"]

    inc = create_incident(
        payload=IncidentCreate(
            caller_name="Naveen Shenoy",
            caller_phone="+91 92222 11111",
            location_address="Car Street, Mangaluru",
            latitude=12.8710,
            longitude=74.8450,
            chief_complaint="Syncope / fainting episode",
        ),
        db=db,
        current_user=dispatcher,
    )
    assert inc.status == "TRIAGED"

    # Attempting to close from TRIAGED must fail
    with pytest.raises(HTTPException) as exc_info:
        close_incident(
            incident_id=inc.id,
            payload=IncidentCloseRequest(resolution_notes="Attempt closing unhandled case"),
            db=db,
            current_user=dispatcher,
        )
    assert exc_info.value.status_code == 400
    assert "resolved" in exc_info.value.detail.lower()


# =============================================================================
# 10. Unauthorized incident closure attempts
# =============================================================================
def test_unauthorized_incident_closure(db: Session):
    users = _get_demo_users(db)
    citizen = users["citizen"]
    crew = users["crew"]
    hospital_staff = users["hospital_staff"]

    inc = create_incident(
        payload=IncidentCreate(
            caller_name="Kavitha Prabhu",
            caller_phone="+91 91111 00000",
            location_address="Bejai, Mangaluru",
            latitude=12.8800,
            longitude=74.8500,
            chief_complaint="Fractured arm",
        ),
        db=db,
    )
    inc.status = "RESOLVED"
    db.commit()

    # Citizen cannot close
    with pytest.raises(HTTPException) as exc_info:
        close_incident(
            incident_id=inc.id,
            payload=IncidentCloseRequest(),
            db=db,
            current_user=citizen,
        )
    assert exc_info.value.status_code == 403

    # Crew cannot close
    with pytest.raises(HTTPException) as exc_info:
        close_incident(
            incident_id=inc.id,
            payload=IncidentCloseRequest(),
            db=db,
            current_user=crew,
        )
    assert exc_info.value.status_code == 403

    # Hospital staff cannot close
    with pytest.raises(HTTPException) as exc_info:
        close_incident(
            incident_id=inc.id,
            payload=IncidentCloseRequest(),
            db=db,
            current_user=hospital_staff,
        )
    assert exc_info.value.status_code == 403


# =============================================================================
# 11. Lifecycle status update to CLOSED via PATCH /status
# =============================================================================
def test_lifecycle_patch_status_closed(db: Session):
    users = _get_demo_users(db)
    dispatcher = users["dispatcher"]

    inc = create_incident(
        payload=IncidentCreate(
            caller_name="Girish Nayak",
            caller_phone="+91 90000 99999",
            location_address="Ladyhill, Mangaluru",
            latitude=12.8900,
            longitude=74.8350,
            chief_complaint="Palpitations",
        ),
        db=db,
        current_user=dispatcher,
    )

    # Invalid PATCH to CLOSED from TRIAGED
    with pytest.raises(HTTPException) as exc_info:
        update_incident_status(
            incident_id=inc.id,
            payload=IncidentStatusUpdate(status="CLOSED"),
            db=db,
            current_user=dispatcher,
        )
    assert exc_info.value.status_code == 400

    # Transition to RESOLVED then valid PATCH to CLOSED
    inc.status = "RESOLVED"
    db.commit()

    updated = update_incident_status(
        incident_id=inc.id,
        payload=IncidentStatusUpdate(status="CLOSED"),
        db=db,
        current_user=dispatcher,
    )
    assert updated.status == "CLOSED"


# =============================================================================
# 12. Manual reassignment reservation release
# =============================================================================
def test_reassignment_reservation_release(db: Session):
    users = _get_demo_users(db)
    dispatcher = users["dispatcher"]

    ambs = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").all()
    assert len(ambs) >= 2
    amb1 = ambs[0]
    hosp = db.query(Hospital).first()

    inc = create_incident(
        payload=IncidentCreate(
            caller_name="Shankar Bhat",
            caller_phone="+91 89999 88888",
            location_address="Mannagudda, Mangaluru",
            latitude=12.8820,
            longitude=74.8320,
            chief_complaint="Head injury",
        ),
        db=db,
    )

    disp = create_dispatch(
        DispatchRequest(
            incident_id=inc.id,
            ambulance_id=amb1.id,
            destination_hospital_id=hosp.id,
        ),
        db=db,
    )

    db.refresh(amb1)
    assert amb1.status == "RESERVED"
    assert amb1.reservation_dispatch_id == disp.id
    assert disp.attempt_number == 1

    # Reassign dispatch via auto-escalation
    new_disp = reassign_dispatch(
        dispatch_id=disp.id,
        db=db,
        current_user=dispatcher,
    )

    db.refresh(amb1)

    # Unit 1 released
    assert amb1.status == "AVAILABLE"
    assert amb1.reservation_dispatch_id is None

    # New ambulance now reserved
    new_amb = db.query(Ambulance).filter(Ambulance.id == new_disp.ambulance_id).first()
    assert new_amb.id != amb1.id
    assert new_amb.status == "RESERVED"
    assert new_amb.reservation_dispatch_id == new_disp.id
    assert new_disp.attempt_number == 2

    # Verify escalation audit history
    assert len(new_disp.escalation_history) >= 1
    assert new_disp.escalation_history[-1]["failed_ambulance_id"] == amb1.id
    assert new_disp.escalation_history[-1]["replacement_ambulance_id"] == new_amb.id
