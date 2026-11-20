import pytest
from datetime import datetime, timezone
from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend.app.models.entities import Hospital, User, Dispatch, Incident, Ambulance, HandoverPacket
from backend.app.schemas.hospital import (
    DoctorCreate,
    DoctorUpdate,
    DoctorStatusUpdate,
    DepartmentItemUpdate,
    CapabilitiesUpdate,
    BedCapacityBreakdownUpdate,
    BedCategoryInput,
    HospitalProfileUpdate,
)
from backend.app.schemas.dispatch import (
    HandoverReviewRequest,
    HandoverAcknowledgeRequest,
    HandoverCompleteRequest,
    ConfirmationDecision,
)
from backend.app.api.hospitals import (
    compute_doctor_duty_and_availability,
    list_hospital_doctors,
    add_hospital_doctor,
    update_hospital_doctor,
    update_hospital_doctor_status,
    delete_hospital_doctor,
    get_hospital_departments,
    update_single_department,
    get_hospital_capabilities,
    update_hospital_capabilities,
    get_hospital_bed_capacity,
    update_hospital_bed_capacity,
    update_hospital_profile,
    get_hospital,
)
from backend.app.api.dispatch import (
    confirm_hospital,
    review_handover_packet,
    acknowledge_handover_packet,
    complete_handover_packet,
    get_handover_packet,
)

def test_doctor_shift_and_schedule_availability_engine():
    # 1. Daytime Doctor: 08:00 - 16:00, Mon-Fri
    doc_day = {
        "id": "doc_test_1",
        "name": "Dr. Ramesh Rao",
        "specialty": "Emergency Medicine",
        "shift_type": "MORNING",
        "shift_start": "08:00",
        "shift_end": "16:00",
        "working_days": ["MON", "TUE", "WED", "THU", "FRI"],
        "status": "AVAILABLE",
        "is_active": True,
    }

    # At 11:30 on Wednesday (2026-11-18 was Wednesday)
    wed_dt = datetime(2026, 11, 18, 11, 30, tzinfo=timezone.utc)
    res_on = compute_doctor_duty_and_availability(doc_day, current_dt=wed_dt)
    assert res_on["is_on_duty"] is True
    assert res_on["is_available"] is True
    assert res_on["effective_status"] == "AVAILABLE"

    # At 21:00 on Wednesday: outside shift hours -> OFF_DUTY
    wed_night_dt = datetime(2026, 11, 18, 21, 0, tzinfo=timezone.utc)
    res_off_time = compute_doctor_duty_and_availability(doc_day, current_dt=wed_night_dt)
    assert res_off_time["is_on_duty"] is False
    assert res_off_time["is_available"] is False
    assert res_off_time["effective_status"] == "OFF_DUTY"
    assert "Outside shift hours" in res_off_time["duty_reason"]

    # At 11:30 on Sunday (2026-11-22 was Sunday): not working day -> OFF_DUTY
    sun_dt = datetime(2026, 11, 22, 11, 30, tzinfo=timezone.utc)
    res_off_day = compute_doctor_duty_and_availability(doc_day, current_dt=sun_dt)
    assert res_off_day["is_on_duty"] is False
    assert res_off_day["effective_status"] == "OFF_DUTY"
    assert "Scheduled off today" in res_off_day["duty_reason"]

    # 2. Overnight Doctor: 20:00 - 08:00
    doc_night = {
        "id": "doc_test_2",
        "name": "Dr. Anita Prabhu",
        "specialty": "Trauma Surgery",
        "shift_type": "NIGHT",
        "shift_start": "20:00",
        "shift_end": "08:00",
        "working_days": ["ALL"],
        "status": "AVAILABLE",
        "is_active": True,
    }
    # At 23:30 -> ON DUTY
    dt_2330 = datetime(2026, 11, 18, 23, 30, tzinfo=timezone.utc)
    res_night_1 = compute_doctor_duty_and_availability(doc_night, current_dt=dt_2330)
    assert res_night_1["is_on_duty"] is True
    assert res_night_1["is_available"] is True

    # At 03:00 -> ON DUTY (overnight crosses midnight)
    dt_0300 = datetime(2026, 11, 19, 3, 0, tzinfo=timezone.utc)
    res_night_2 = compute_doctor_duty_and_availability(doc_night, current_dt=dt_0300)
    assert res_night_2["is_on_duty"] is True

    # At 14:00 -> OFF DUTY
    dt_1400 = datetime(2026, 11, 19, 14, 0, tzinfo=timezone.utc)
    res_night_off = compute_doctor_duty_and_availability(doc_night, current_dt=dt_1400)
    assert res_night_off["is_on_duty"] is False

    # 2b. Overnight Doctor with single working day (Friday shift: Fri 20:00 - Sat 08:00)
    doc_fri_night = {
        "id": "doc_test_fri",
        "name": "Dr. Sandeep Rao",
        "specialty": "Neuro Trauma",
        "shift_type": "NIGHT",
        "shift_start": "20:00",
        "shift_end": "08:00",
        "working_days": ["FRI"],
        "status": "AVAILABLE",
        "is_active": True,
    }
    # Friday 22:00 -> ON DUTY
    fri_night = datetime(2026, 11, 20, 22, 0, tzinfo=timezone.utc)
    assert compute_doctor_duty_and_availability(doc_fri_night, current_dt=fri_night)["is_on_duty"] is True

    # Saturday 03:00 -> ON DUTY (shift started on Friday)
    sat_early = datetime(2026, 11, 21, 3, 0, tzinfo=timezone.utc)
    assert compute_doctor_duty_and_availability(doc_fri_night, current_dt=sat_early)["is_on_duty"] is True

    # Sunday 03:00 -> OFF DUTY (Saturday was not a configured working day)
    sun_early = datetime(2026, 11, 22, 3, 0, tzinfo=timezone.utc)
    assert compute_doctor_duty_and_availability(doc_fri_night, current_dt=sun_early)["is_on_duty"] is False

    # 3. Status Overrides (ON_LEAVE, BUSY, UNAVAILABLE)
    doc_leave = dict(doc_day, status="ON_LEAVE")
    assert compute_doctor_duty_and_availability(doc_leave, current_dt=wed_dt)["effective_status"] == "ON_LEAVE"

    doc_busy = dict(doc_day, status="BUSY")
    res_busy = compute_doctor_duty_and_availability(doc_busy, current_dt=wed_dt)
    assert res_busy["is_on_duty"] is True
    assert res_busy["is_available"] is False
    assert res_busy["effective_status"] == "BUSY"

def test_multitier_bed_capacity_calculation_and_enforcement(db: Session):
    hosp = db.query(Hospital).first()
    user = db.query(User).filter(User.hospital_id == hosp.id).first()

    # 1. Get initial bed capacity
    initial_cap = get_hospital_bed_capacity(hosp.id, db=db, current_user=user)
    assert "emergency" in initial_cap
    assert "icu" in initial_cap
    assert "hdu" in initial_cap
    assert "general_ward" in initial_cap
    assert "isolation" in initial_cap
    assert "pediatric" in initial_cap

    # 2. Rejection of invalid capacity: occupied + reserved + unavailable > total (422)
    with pytest.raises(HTTPException) as exc:
        update_hospital_bed_capacity(
            hosp.id,
            BedCapacityBreakdownUpdate(
                emergency=BedCategoryInput(total=10, occupied=7, reserved=2, unavailable=3),  # 7+2+3=12 > 10
            ),
            db=db,
            current_user=user,
        )
    assert exc.value.status_code == 422
    assert "exceeds total" in exc.value.detail

    # 3. Valid update with exact formula: Available = Total - Occupied - Reserved - Unavailable
    updated = update_hospital_bed_capacity(
        hosp.id,
        BedCapacityBreakdownUpdate(
            emergency=BedCategoryInput(total=20, occupied=5, reserved=2, unavailable=3),  # available = 20-5-2-3 = 10
            icu=BedCategoryInput(total=12, occupied=4, reserved=1, unavailable=1),        # available = 12-4-1-1 = 6
            hdu=BedCategoryInput(total=8, occupied=2, reserved=0, unavailable=1),         # available = 8-2-0-1 = 5
            general_ward=BedCategoryInput(total=50, occupied=20, reserved=0, unavailable=5), # available = 50-20-0-5 = 25
            isolation=BedCategoryInput(total=6, occupied=1, reserved=0, unavailable=1),   # available = 6-1-0-1 = 4
            pediatric=BedCategoryInput(total=10, occupied=3, reserved=0, unavailable=1),  # available = 10-3-0-1 = 6
        ),
        db=db,
        current_user=user,
    )

    assert updated["emergency"]["available"] == 10
    assert updated["emergency"]["total"] == 20
    assert updated["emergency"]["occupied"] == 5
    assert updated["emergency"]["reserved"] == 2
    assert updated["emergency"]["unavailable"] == 3

    assert updated["icu"]["available"] == 6
    assert updated["hdu"]["available"] == 5
    assert updated["general_ward"]["available"] == 25
    assert updated["isolation"]["available"] == 4
    assert updated["pediatric"]["available"] == 6

    # Verify synchronization with base columns on Hospital
    db.refresh(hosp)
    assert hosp.total_emergency_beds == 20
    assert hosp.available_emergency_beds == 10
    assert hosp.reserved_emergency_beds == 2
    assert hosp.total_icu_beds == 12
    assert hosp.available_icu_beds == 6

def test_departments_and_clinical_capabilities_management(db: Session):
    hosp = db.query(Hospital).first()
    user = db.query(User).filter(User.hospital_id == hosp.id).first()

    # 1. Departments listing
    depts = get_hospital_departments(hosp.id, db=db, current_user=user)
    assert len(depts) >= 8
    er_dept = next(d for d in depts if d["name"] == "Emergency Medicine")
    assert er_dept["operational_status"] == "ACTIVE"

    # 2. Update single department status to LIMITED
    updated_depts = update_single_department(
        hosp.id,
        er_dept["id"],
        DepartmentItemUpdate(
            operational_status="LIMITED",
            notes="Trauma Bay 2 temporarily closed for decontamination.",
        ),
        db=db,
        current_user=user,
    )
    upd_er = next(d for d in updated_depts if d["id"] == er_dept["id"])
    assert upd_er["operational_status"] == "LIMITED"
    assert "decontamination" in upd_er["notes"]

    # 3. Capabilities inspection & update
    caps = get_hospital_capabilities(hosp.id, db=db, current_user=user)
    assert "cardiac_emergency" in caps
    assert "trauma_capability" in caps

    # Update capability
    new_caps = update_hospital_capabilities(
        hosp.id,
        CapabilitiesUpdate(
            cardiac_emergency="AVAILABLE",
            operating_theatre="LIMITED",
            ventilator_availability="AVAILABLE",
        ),
        db=db,
        current_user=user,
    )
    assert new_caps["operating_theatre"] == "LIMITED"
    assert new_caps["cardiac_emergency"] == "AVAILABLE"

    # Reject invalid capability value (422)
    with pytest.raises(HTTPException) as exc:
        update_hospital_capabilities(
            hosp.id,
            CapabilitiesUpdate(cardiac_emergency="UNKNOWN_STATE"),
            db=db,
            current_user=user,
        )
    assert exc.value.status_code == 422

def test_hospital_profile_and_settings_validation(db: Session):
    hosp = db.query(Hospital).first()
    user = db.query(User).filter(User.hospital_id == hosp.id).first()

    # 1. Update valid profile fields
    prof = update_hospital_profile(
        hosp.id,
        HospitalProfileUpdate(
            facility_type="Apex Trauma & Emergency Medical Institute",
            emergency_department_hours="24/7 Priority Emergency Resuscitation",
            emergency_contact_person="Dr. K. Kamath (Clinical Director)",
            contact_number="+91 824 2444599",
            latitude=12.8750,
            longitude=74.8450,
            readiness_status="READY",
        ),
        db=db,
        current_user=user,
    )
    assert prof.facility_type == "Apex Trauma & Emergency Medical Institute"
    assert prof.emergency_department_hours == "24/7 Priority Emergency Resuscitation"
    assert prof.latitude == 12.8750
    assert prof.longitude == 74.8450

    # 2. Reject out-of-bounds coordinates (422)
    with pytest.raises(HTTPException) as exc:
        update_hospital_profile(
            hosp.id,
            HospitalProfileUpdate(latitude=95.0),
            db=db,
            current_user=user,
        )
    assert exc.value.status_code == 422
    assert "between -90.0 and +90.0" in exc.value.detail

    with pytest.raises(HTTPException) as exc:
        update_hospital_profile(
            hosp.id,
            HospitalProfileUpdate(longitude=-200.0),
            db=db,
            current_user=user,
        )
    assert exc.value.status_code == 422
    assert "between -180.0 and +180.0" in exc.value.detail

    # 3. Reject empty hospital name (422)
    with pytest.raises(HTTPException) as exc:
        update_hospital_profile(
            hosp.id,
            HospitalProfileUpdate(name="   "),
            db=db,
            current_user=user,
        )
    assert exc.value.status_code == 422

def test_sbar_handover_review_and_completion_lifecycle(db: Session):
    hospitals = db.query(Hospital).all()
    hosp_a = hospitals[0]
    hosp_b = hospitals[1]
    user_a = db.query(User).filter(User.hospital_id == hosp_a.id).first()
    user_b = db.query(User).filter(User.hospital_id == hosp_b.id).first()

    amb = db.query(Ambulance).first()
    inc = Incident(
        caller_name="Ananya Hegde",
        caller_phone="+91 98860 12345",
        location_address="Kadri Hills, Mangaluru",
        latitude=12.876,
        longitude=74.851,
        chief_complaint="Acute chest pressure radiating to left arm",
        triage_level="Priority 1",
        triage_color="RED",
        triage_score=85,
        chest_pain=True,
        status="DISPATCHED",
    )
    db.add(inc)
    db.commit()
    db.refresh(inc)

    disp = Dispatch(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp_a.id,
        coordination_status="CONFIRMED",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="ACCEPTED",
        status="EN_ROUTE_HOSPITAL",
        attempt_number=1,
    )
    db.add(disp)
    db.commit()
    db.refresh(disp)

    # 1. Clinical staff reviews handover packet
    reviewed_packet = review_handover_packet(
        disp.id,
        HandoverReviewRequest(
            reviewed_by="Dr. Aditi Shenoy",
            receiving_notes="Cath lab alerted. STEMI protocol active.",
        ),
        db=db,
        current_user=user_a,
    )
    assert reviewed_packet.status in ["REVIEWED", "SENT"]
    assert reviewed_packet.receiving_clinician == "Dr. Aditi Shenoy"
    assert "STEMI protocol" in (reviewed_packet.receiving_notes or "")

    # 2. Staff acknowledges handover packet
    ack_packet = acknowledge_handover_packet(
        disp.id,
        HandoverAcknowledgeRequest(
            acknowledged_by="Nurse In-Charge Preethi",
            receiving_notes="Trauma Bay 1 prepared. ECG machine connected.",
        ),
        db=db,
        current_user=user_a,
    )
    assert ack_packet.status == "ACKNOWLEDGED"
    assert ack_packet.acknowledged_at is not None

    # 3. Staff completes receiving workflow
    comp_packet = complete_handover_packet(
        disp.id,
        HandoverCompleteRequest(
            completed_by="Dr. Aditi Shenoy",
            receiving_notes="Patient formally received in Cath Lab. Clinical handover completed.",
        ),
        db=db,
        current_user=user_a,
    )
    assert comp_packet.status == "COMPLETED"
    assert comp_packet.completed_at is not None
    assert "Clinical handover completed" in comp_packet.receiving_notes

    # 4. Strict isolation: Hospital B cannot review or complete Hospital A's handover (403)
    with pytest.raises(HTTPException) as exc:
        review_handover_packet(
            disp.id,
            HandoverReviewRequest(reviewed_by="Dr. Intruder"),
            db=db,
            current_user=user_b,
        )
    assert exc.value.status_code == 403

    with pytest.raises(HTTPException) as exc:
        complete_handover_packet(
            disp.id,
            HandoverCompleteRequest(completed_by="Dr. Intruder"),
            db=db,
            current_user=user_b,
        )
    assert exc.value.status_code == 403
