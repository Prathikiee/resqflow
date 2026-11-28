import pytest
from datetime import datetime, timezone, timedelta
from fastapi import Response
from sqlalchemy.orm import Session
from backend.app.models.entities import Hospital, User, Dispatch, Incident, Ambulance
from backend.app.api.auth import switch_facility, build_user_out
from backend.app.api.hospitals import (
    list_hospitals,
    list_hospital_network,
    get_hospital,
    list_hospital_doctors,
    get_allocated_incidents,
    compute_doctor_duty_and_availability,
)
from backend.app.api.dispatch import confirm_hospital, expire_single_dispatch_if_due
from backend.app.schemas.dispatch import ConfirmationDecision
from backend.app.core.auth import ROLE_HOSPITAL_STAFF

def test_hospital_network_endpoint_returns_30_facilities(fresh_db: Session):
    """
    Verifies that the /network endpoint returns all 30 regional facilities
    with strictly unique facility codes and non-empty metadata.
    """
    facilities = list_hospital_network(db=fresh_db)
    assert len(facilities) == 30, f"Expected exactly 30 hospitals in network, found {len(facilities)}"

    codes = [f.facility_code for f in facilities if f.facility_code]
    assert len(codes) == 30, "All 30 hospitals must possess a facility_code"
    assert len(set(codes)) == 30, "Facility codes must be completely unique across the network"

    for f in facilities:
        assert f.name, "Hospital name must not be empty"
        assert f.address, "Hospital address must not be empty"
        assert f.total_emergency_beds > 0, f"Hospital {f.name} must have emergency beds"
        assert f.facility_code.startswith("HOSP-"), f"Facility code {f.facility_code} must start with HOSP-"

def test_facility_switcher_query_parameter(fresh_db: Session):
    """
    Verifies list_hospitals behavior:
    - Default for HOSPITAL_STAFF returns isolated facility.
    - all_network=True returns all 30 facilities for switcher UI.
    """
    kmc_user = fresh_db.query(User).filter(User.role == ROLE_HOSPITAL_STAFF, User.hospital_id == 1).first()
    assert kmc_user is not None

    # Default isolation
    isolated_list = list_hospitals(all_network=False, db=fresh_db, current_user=kmc_user)
    assert len(isolated_list) == 1
    assert isolated_list[0].id == 1

    # Switcher query with all_network=True
    network_list = list_hospitals(all_network=True, db=fresh_db, current_user=kmc_user)
    assert len(network_list) == 30

def test_all_30_hospitals_have_active_doctors_on_duty_in_ist(fresh_db: Session):
    """
    Verifies that doctor shift schedules evaluated in Indian Standard Time (IST)
    always produce active on-duty doctors across all 30 hospitals.
    """
    hospitals = fresh_db.query(Hospital).all()
    assert len(hospitals) == 30

    admin = fresh_db.query(User).filter(User.role == "SUPER_ADMIN").first()
    assert admin is not None

    IST = timezone(timedelta(hours=5, minutes=30))
    now_ist = datetime.now(IST)

    for h in hospitals:
        doctors = list_hospital_doctors(h.id, db=fresh_db, current_user=admin)
        assert len(doctors) > 0, f"Hospital {h.name} must have seeded doctors"
        on_duty = [d for d in doctors if d.get("is_on_duty")]
        assert len(on_duty) > 0, f"Hospital {h.name} ({h.facility_code}) must have at least 1 doctor on duty in IST (now: {now_ist.strftime('%H:%M %Z')})"

def test_facility_switching_and_isolated_inbound_emergency_visibility(fresh_db: Session):
    """
    Verifies end-to-end multi-facility dispatch and switching:
    1. Incident dispatched to Father Muller (ID 3).
    2. KMC staff (ID 1) cannot view Father Muller's inbound emergency.
    3. User switches facility context to Father Muller (ID 3).
    4. New token allows Father Muller staff to see the emergency in the queue.
    5. Father Muller staff accepts the bed reservation, confirming the dispatch.
    """
    # Create test incident
    incident = Incident(
        caller_name="Ananya Rao",
        caller_phone="+91 98451 23456",
        location_address="Pumpwell Circle, Mangaluru",
        latitude=12.8620,
        longitude=74.8640,
        chief_complaint="Severe blunt trauma and respiratory distress from bike skid",
        triage_level="Priority 1 (Resuscitation)",
        triage_color="RED",
        status="TRIAGED",
    )
    fresh_db.add(incident)
    fresh_db.commit()
    fresh_db.refresh(incident)

    # Get ambulance and target hospital (Father Muller, ID 3)
    amb = fresh_db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    assert amb is not None
    hosp_fm = fresh_db.query(Hospital).filter(Hospital.id == 3).first()
    assert hosp_fm is not None
    hosp_kmc = fresh_db.query(Hospital).filter(Hospital.id == 1).first()
    assert hosp_kmc is not None

    # Create dispatch with dual confirmation
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=90)
    dispatch = Dispatch(
        incident_id=incident.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp_fm.id,
        status="DISPATCHED",
        coordination_status="PENDING_CONFIRMATIONS",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="PENDING",
        reservation_expires_at=expires_at,
        attempt_number=1,
    )
    fresh_db.add(dispatch)
    hosp_fm.reserved_emergency_beds = (hosp_fm.reserved_emergency_beds or 0) + 1
    fresh_db.commit()
    fresh_db.refresh(dispatch)

    # 1. KMC staff checks inbound allocations: must NOT see Father Muller's dispatch
    kmc_user = fresh_db.query(User).filter(User.role == ROLE_HOSPITAL_STAFF, User.hospital_id == 1).first()
    kmc_inbound = get_allocated_incidents(1, db=fresh_db, current_user=kmc_user)
    assert not any(d.id == dispatch.id for d in kmc_inbound), "KMC staff must not see Father Muller's dispatch"

    # 2. Switch facility context to Father Muller (ID 3)
    resp = Response()
    token_resp = switch_facility(hospital_id=3, response=resp, db=fresh_db)
    assert token_resp.user.hospital_id == 3
    assert token_resp.user.hospital_name == hosp_fm.name

    # 3. Fetch Father Muller user and inspect inbound allocations
    fm_user = fresh_db.query(User).filter(User.id == token_resp.user.id).first()
    fm_inbound = get_allocated_incidents(3, db=fresh_db, current_user=fm_user)
    assert any(d.id == dispatch.id for d in fm_inbound), "Father Muller staff must see the inbound dispatch"

    # 4. Father Muller accepts bed reservation
    decision_payload = ConfirmationDecision(decision="ACCEPTED", attempt_number=1)
    confirmed_disp = confirm_hospital(
        dispatch_id=dispatch.id,
        payload=decision_payload,
        db=fresh_db,
        current_user=fm_user,
    )
    assert confirmed_disp.hospital_confirmation_status in ["ACCEPTED", "CONFIRMED"]
    assert confirmed_disp.coordination_status == "CONFIRMED"
