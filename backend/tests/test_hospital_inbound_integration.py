import pytest
from datetime import datetime, timezone, timedelta
from fastapi import HTTPException, Response
from backend.app.models.entities import Ambulance, Hospital, Incident, Dispatch, User
from backend.app.api.dispatch import (
    confirm_ambulance,
    confirm_hospital,
    get_utc_now,
)
from backend.app.api.hospitals import get_allocated_incidents
from backend.app.api.auth import switch_facility
from backend.app.schemas.dispatch import ConfirmationDecision
from backend.app.core.auth import ROLE_HOSPITAL_STAFF, ROLE_AMBULANCE_CREW

def test_hospital_data_isolation_and_inbound_query(fresh_db):
    """
    Verifies strict hospital data isolation:
    - Dispatch allocated to Hospital A appears in Hospital A's inbound queue.
    - Dispatch does NOT appear in Hospital B's inbound queue.
    - Hospital B staff user is blocked from reading Hospital A's dispatches.
    """
    db = fresh_db
    hosp_a = db.query(Hospital).filter(Hospital.id == 3).first() or db.query(Hospital).first()
    hosp_b = db.query(Hospital).filter(Hospital.id != hosp_a.id).first()

    # Staff users
    user_a = db.query(User).filter(User.role == ROLE_HOSPITAL_STAFF, User.hospital_id == hosp_a.id).first()
    user_b = db.query(User).filter(User.role == ROLE_HOSPITAL_STAFF, User.hospital_id == hosp_b.id).first()

    inc = Incident(
        caller_name="Test Inbound Citizen",
        caller_phone="+919876543210",
        location_address="Kankanady bypass",
        latitude=12.8620,
        longitude=74.8620,
        chief_complaint="Severe abdominal pain with dizziness",
        triage_level="Priority 1",
        triage_color="RED",
        status="ALLOCATED",
    )
    db.add(inc)
    db.commit()
    db.refresh(inc)

    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    if not amb:
        amb = db.query(Ambulance).first()
        amb.status = "AVAILABLE"
        db.commit()

    now = get_utc_now()
    disp = Dispatch(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp_a.id,
        status="ASSIGNED",
        coordination_status="PENDING_CONFIRMATIONS",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="PENDING",
        reservation_expires_at=now + timedelta(seconds=90),
        attempt_number=1,
    )
    db.add(disp)
    db.commit()
    db.refresh(disp)

    # Hospital A queries its allocated incidents -> disp is present
    dispatches_a = get_allocated_incidents(hosp_a.id, db, user_a)
    assert any(d.id == disp.id for d in dispatches_a)
    found_a = next(d for d in dispatches_a if d.id == disp.id)
    assert found_a.destination_hospital_id == hosp_a.id
    assert found_a.ambulance_confirmation_status == "ACCEPTED"
    assert found_a.hospital_confirmation_status == "PENDING"

    # Hospital B queries its allocated incidents -> disp is NOT present (strict isolation)
    dispatches_b = get_allocated_incidents(hosp_b.id, db, user_b)
    assert not any(d.id == disp.id for d in dispatches_b)

    # Hospital B staff user querying Hospital A's endpoint -> blocked with 403 Forbidden
    with pytest.raises(HTTPException) as exc_info:
        get_allocated_incidents(hosp_a.id, db, user_b)
    assert exc_info.value.status_code == 403
    assert "Access denied" in exc_info.value.detail


def test_switch_facility_endpoint(fresh_db):
    """
    Verifies that the /api/auth/switch-facility/{hospital_id} endpoint
    properly returns an authentic token scoped to the target hospital.
    """
    db = fresh_db
    resp = Response()
    hosp = db.query(Hospital).first()
    token_res = switch_facility(hosp.id, resp, db)

    assert token_res.access_token is not None
    assert token_res.user.hospital_id == hosp.id
    assert token_res.user.role == ROLE_HOSPITAL_STAFF

    # Switch to another hospital
    other_hosp = db.query(Hospital).filter(Hospital.id != hosp.id).first()
    token_res_other = switch_facility(other_hosp.id, resp, db)
    assert token_res_other.user.hospital_id == other_hosp.id
    assert token_res_other.user.role == ROLE_HOSPITAL_STAFF


def test_dual_confirmation_lifecycle_with_hospital_acceptance(fresh_db):
    """
    Verifies the complete dual confirmation acceptance:
    1. Ambulance crew accepts
    2. Hospital ER accepts
    3. coordination_status transitions to CONFIRMED and unit is dispatched
    """
    db = fresh_db
    hosp = db.query(Hospital).filter(Hospital.id == 3).first()
    user_hosp = db.query(User).filter(User.role == ROLE_HOSPITAL_STAFF, User.hospital_id == hosp.id).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    user_amb = db.query(User).filter(User.role == ROLE_AMBULANCE_CREW, User.ambulance_id == amb.id).first()

    inc = Incident(
        caller_name="Dual Confirm Test",
        caller_phone="+919988776655",
        location_address="Bunts Hostel circle",
        latitude=12.8718,
        longitude=74.8458,
        chief_complaint="Cardiac emergency",
        triage_level="Priority 1",
        triage_color="RED",
        status="ALLOCATED",
    )
    db.add(inc)
    db.commit()

    now = get_utc_now()
    disp = Dispatch(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
        status="ASSIGNED",
        coordination_status="PENDING_CONFIRMATIONS",
        ambulance_confirmation_status="PENDING",
        hospital_confirmation_status="PENDING",
        reservation_expires_at=now + timedelta(seconds=90),
        attempt_number=1,
    )
    db.add(disp)
    db.commit()

    # Step 1: Ambulance accepts
    disp_after_amb = confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED", attempt_number=1), db, user_amb)
    assert disp_after_amb.ambulance_confirmation_status == "ACCEPTED"
    assert disp_after_amb.coordination_status == "PENDING_CONFIRMATIONS"

    # Step 2: Hospital accepts
    disp_after_hosp = confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED", attempt_number=1), db, user_hosp)
    assert disp_after_hosp.hospital_confirmation_status == "ACCEPTED"
    assert disp_after_hosp.coordination_status == "CONFIRMED"
    assert disp_after_hosp.status == "ASSIGNED"


def test_stale_expired_attempt_cannot_be_accepted(fresh_db):
    """
    Verifies that once a provisional reservation is expired or marked REASSIGNMENT_REQUIRED,
    late acceptance attempts are rejected with 400 Bad Request.
    """
    db = fresh_db
    hosp = db.query(Hospital).first()
    user_hosp = db.query(User).filter(User.role == ROLE_HOSPITAL_STAFF, User.hospital_id == hosp.id).first()
    amb = db.query(Ambulance).first()
    inc = db.query(Incident).first()

    disp = Dispatch(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
        status="ASSIGNED",
        coordination_status="REASSIGNMENT_REQUIRED",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="PENDING",
        attempt_number=2,
    )
    db.add(disp)
    db.commit()

    with pytest.raises(HTTPException) as exc_info:
        confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED", attempt_number=2), db, user_hosp)
    assert exc_info.value.status_code == 400
    assert "Cannot accept" in exc_info.value.detail
