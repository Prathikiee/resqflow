import pytest
from datetime import datetime, timezone
from fastapi import HTTPException
from starlette.responses import Response
from sqlalchemy.orm import Session

from backend.app.models.entities import Hospital, User, Dispatch, Incident, Ambulance, CrashAlert
from backend.app.services.seed_service import seed_database
from backend.app.core.security import verify_password
from backend.app.schemas.auth import LoginRequest
from backend.app.api.auth import login
from backend.app.schemas.hospital import (
    HospitalBedsUpdate,
    HospitalReadinessUpdate,
    DoctorCreate,
    DoctorUpdate,
    HospitalCapacityUpdate,
)
from backend.app.schemas.dispatch import HospitalPreparationUpdate
from backend.app.schemas.crash_alert import CrashAlertSimulate, CrashAlertIngest, CrashAlertResponseUpdate
from backend.app.api.hospitals import (
    list_hospitals,
    get_hospital,
    update_hospital_beds,
    update_hospital_readiness,
    list_hospital_doctors,
    add_hospital_doctor,
    update_hospital_doctor,
    delete_hospital_doctor,
    get_allocated_incidents,
)
from backend.app.api.dispatch import (
    update_hospital_preparation,
    confirm_patient_arrival_at_hospital,
    list_dispatches,
)
from backend.app.api.crash_alerts import (
    ingest_crash_alert,
    simulate_crash_alert,
    list_crash_alerts,
    get_crash_alert,
    respond_to_crash_alert,
)

def test_10_mangaluru_hospitals_seeded_and_unique_credentials(db: Session):
    hospitals = db.query(Hospital).all()
    assert len(hospitals) >= 10, f"Expected at least 10 hospitals, found {len(hospitals)}"

    hospital_names = [h.name for h in hospitals]
    assert any("KMC" in name for name in hospital_names)
    assert any("A.J." in name or "AJ" in name for name in hospital_names)
    assert any("Unity" in name for name in hospital_names)
    assert any("Indiana" in name for name in hospital_names)
    assert any("Yenepoya" in name for name in hospital_names)
    assert any("Father Muller" in name for name in hospital_names)
    assert any("City Hospital" in name for name in hospital_names)
    assert any("Highland" in name for name in hospital_names)
    assert any("Tejasvini" in name for name in hospital_names)
    assert any("Mangala" in name for name in hospital_names)

    # Check each hospital has a distinct user account with matching first letter password
    expected_accounts = [
        ("kmc@lifelink.demo", "Kmc#HospitalPass2026!Mangaluru", "K"),
        ("aj@lifelink.demo", "Aj#HospitalPass2026!Mangaluru", "A"),
        ("unity@lifelink.demo", "Unity#HospitalPass2026!Mangaluru", "U"),
        ("indiana@lifelink.demo", "Indiana#HospitalPass2026!Mangaluru", "I"),
        ("yenepoya@lifelink.demo", "Yenepoya#HospitalPass2026!Mangaluru", "Y"),
        ("fathermuller@lifelink.demo", "FatherMuller#HospitalPass2026!Mangaluru", "F"),
        ("cityhospital@lifelink.demo", "CityHospital#HospitalPass2026!Mangaluru", "C"),
        ("highland@lifelink.demo", "Highland#HospitalPass2026!Mangaluru", "H"),
        ("tejasvini@lifelink.demo", "Tejasvini#HospitalPass2026!Mangaluru", "T"),
        ("mangala@lifelink.demo", "Mangala#HospitalPass2026!Mangaluru", "M"),
    ]

    for email, password, initial in expected_accounts:
        assert password[0] == initial
        user = db.query(User).filter(User.email == email).first()
        assert user is not None, f"Account {email} not found"
        assert verify_password(password, user.password_hash)

        # Also verify authentication endpoint accepts both email and username
        resp_obj = Response()
        token_out = login(LoginRequest(email=email, password=password), response=resp_obj, db=db)
        assert token_out.access_token is not None

        username = email.split("@")[0]
        user_out = login(LoginRequest(email=username, password=password), response=resp_obj, db=db)
        assert user_out.access_token is not None

def test_strict_cross_hospital_data_isolation(db: Session):
    hospitals = db.query(Hospital).order_by(Hospital.id).all()
    hosp_a = hospitals[0]
    hosp_b = hospitals[1]

    user_a = db.query(User).filter(User.hospital_id == hosp_a.id).first()
    user_b = db.query(User).filter(User.hospital_id == hosp_b.id).first()

    # 1. Hospital A can inspect own profile
    own = get_hospital(hosp_a.id, db=db, current_user=user_a)
    assert own.id == hosp_a.id

    # 2. Hospital A cannot inspect Hospital B's profile (403 Forbidden)
    with pytest.raises(HTTPException) as exc:
        get_hospital(hosp_b.id, db=db, current_user=user_a)
    assert exc.value.status_code == 403

    # 3. In list_hospitals, Hospital A only sees Hospital A
    hosp_list = list_hospitals(db=db, current_user=user_a)
    assert len(hosp_list) == 1
    assert hosp_list[0].id == hosp_a.id

    # 4. Hospital A cannot list or add doctors to Hospital B (403)
    with pytest.raises(HTTPException) as exc:
        list_hospital_doctors(hosp_b.id, db=db, current_user=user_a)
    assert exc.value.status_code == 403

    with pytest.raises(HTTPException) as exc:
        add_hospital_doctor(
            hosp_b.id,
            DoctorCreate(name="Dr. Intruder", specialty="Surgery", department="ER"),
            db=db,
            current_user=user_a,
        )
    assert exc.value.status_code == 403

    # 5. Hospital A cannot update Hospital B's bed capacity (403)
    with pytest.raises(HTTPException) as exc:
        update_hospital_beds(
            hosp_b.id,
            HospitalBedsUpdate(total_emergency_beds=20, occupied_emergency_beds=5),
            db=db,
            current_user=user_a,
        )
    assert exc.value.status_code == 403

    # 6. Hospital A cannot update Hospital B's readiness (403)
    with pytest.raises(HTTPException) as exc:
        update_hospital_readiness(
            hosp_b.id,
            HospitalReadinessUpdate(readiness_status="DIVERT"),
            db=db,
            current_user=user_a,
        )
    assert exc.value.status_code == 403

    # 7. Hospital A cannot view Hospital B's allocated incidents (403)
    with pytest.raises(HTTPException) as exc:
        get_allocated_incidents(hosp_b.id, db=db, current_user=user_a)
    assert exc.value.status_code == 403

def test_bed_capacity_validation_and_calculation(db: Session):
    hosp = db.query(Hospital).first()
    user = db.query(User).filter(User.hospital_id == hosp.id).first()

    # 1. Negative numbers rejected (422)
    with pytest.raises(HTTPException) as exc:
        update_hospital_beds(
            hosp.id,
            HospitalBedsUpdate(total_emergency_beds=-5, occupied_emergency_beds=2),
            db=db,
            current_user=user,
        )
    assert exc.value.status_code == 422

    # 2. Occupied > Total rejected (422)
    with pytest.raises(HTTPException) as exc:
        update_hospital_beds(
            hosp.id,
            HospitalBedsUpdate(total_emergency_beds=10, occupied_emergency_beds=15),
            db=db,
            current_user=user,
        )
    assert exc.value.status_code == 422
    assert "cannot exceed total" in exc.value.detail

    # 3. Valid update computes available = total - occupied
    res = update_hospital_beds(
        hosp.id,
        HospitalBedsUpdate(
            total_emergency_beds=14,
            occupied_emergency_beds=4,
            total_icu_beds=10,
            occupied_icu_beds=3,
            total_ward_beds=50,
            occupied_ward_beds=20,
            total_pediatric_beds=8,
            occupied_pediatric_beds=2,
        ),
        db=db,
        current_user=user,
    )
    assert res.total_emergency_beds == 14
    assert res.available_emergency_beds == 10
    assert res.total_icu_beds == 10
    assert res.available_icu_beds == 7
    assert res.total_ward_beds == 50
    assert res.available_ward_beds == 30
    assert res.pediatric_beds_total == 8
    assert res.pediatric_beds_available == 6

def test_doctor_management_crud(db: Session):
    hosp = db.query(Hospital).first()
    user = db.query(User).filter(User.hospital_id == hosp.id).first()

    # 1. Add doctor
    added_docs = add_hospital_doctor(
        hosp.id,
        DoctorCreate(
            name="Dr. Prathima Shenoy",
            specialty="Interventional Cardiology",
            department="Cardiology & Cath Lab",
            shift="Morning (08:00 - 16:00)",
            status="AVAILABLE",
            contact_number="+91 824 2444591",
        ),
        db=db,
        current_user=user,
    )
    doc = next(d for d in added_docs if d["name"] == "Dr. Prathima Shenoy")
    assert doc["specialty"] == "Interventional Cardiology"
    doc_id = doc["id"]

    # 2. Update doctor status
    upd_docs = update_hospital_doctor(
        hosp.id,
        doc_id,
        DoctorUpdate(status="BUSY"),
        db=db,
        current_user=user,
    )
    doc_after = next(d for d in upd_docs if d["id"] == doc_id)
    assert doc_after["status"] == "BUSY"

    # 3. Delete doctor
    del_docs = delete_hospital_doctor(
        hosp.id,
        doc_id,
        db=db,
        current_user=user,
    )
    assert not any(d["id"] == doc_id for d in del_docs)

def test_hospital_readiness_update(db: Session):
    hosp = db.query(Hospital).first()
    user = db.query(User).filter(User.hospital_id == hosp.id).first()

    res = update_hospital_readiness(
        hosp.id,
        HospitalReadinessUpdate(
            readiness_status="BUSY",
            oxygen_status="NORMAL",
            ventilators_total=12,
            ventilators_available=8,
            blood_bank={
                "prbc_units": 45,
                "o_neg_emergency_units": 15,
                "platelets_units": 20,
                "plasma_units": 25,
            },
            equipment_readiness={
                "ct_scanner": "READY",
                "mri": "MAINTENANCE",
                "cath_lab": "READY",
            },
            emergency_contact_person="Dr. K. Kamath (CMO)",
            emergency_contact_phone="+91 824 2444591",
        ),
        db=db,
        current_user=user,
    )
    assert res.readiness_status == "BUSY"
    assert res.oxygen_status == "NORMAL"
    assert res.ventilators_total == 12
    assert res.ventilators_available == 8
    assert res.blood_bank_status["o_neg_emergency_units"] == 15
    assert res.equipment_readiness["mri"] == "MAINTENANCE"
    assert res.emergency_contact_person == "Dr. K. Kamath (CMO)"

def test_hospital_preparation_and_arrival_workflow(db: Session):
    hospitals = db.query(Hospital).order_by(Hospital.id).all()
    kmc = hospitals[0]
    aj = hospitals[1]
    amb = db.query(Ambulance).first()
    incident = db.query(Incident).first()

    dispatch = Dispatch(
        incident_id=incident.id,
        ambulance_id=amb.id,
        destination_hospital_id=kmc.id,
        status="TRANSPORTING",
        coordination_status="CONFIRMED",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="ACCEPTED",
    )
    db.add(dispatch)
    db.commit()
    db.refresh(dispatch)

    kmc_user = db.query(User).filter(User.hospital_id == kmc.id).first()
    aj_user = db.query(User).filter(User.hospital_id == aj.id).first()

    # 1. In list dispatches, AJ staff cannot see KMC dispatch
    disp_aj = list_dispatches(db=db, current_user=aj_user)
    assert not any(d.id == dispatch.id for d in disp_aj)

    # 2. In allocated-incidents, AJ cannot see KMC
    alloc_aj = get_allocated_incidents(aj.id, db=db, current_user=aj_user)
    assert not any(d.id == dispatch.id for d in alloc_aj)

    # 3. KMC updates preparation status: TEAM_NOTIFIED -> BAY_PREPARED -> READY_FOR_ARRIVAL
    stages = ["TEAM_NOTIFIED", "BAY_PREPARED", "SPECIALISTS_STANDBY", "READY_FOR_ARRIVAL"]
    for stage in stages:
        prep_res = update_hospital_preparation(
            dispatch.id,
            HospitalPreparationUpdate(preparation_status=stage, preparation_notes=f"Completed {stage}"),
            db=db,
            current_user=kmc_user,
        )
        assert prep_res.hospital_preparation_status == stage

    # 4. AJ staff cannot update KMC dispatch preparation (403)
    with pytest.raises(HTTPException) as exc:
        update_hospital_preparation(
            dispatch.id,
            HospitalPreparationUpdate(preparation_status="NOT_STARTED"),
            db=db,
            current_user=aj_user,
        )
    assert exc.value.status_code == 403

    # 5. KMC confirms patient arrival
    arrival_res = confirm_patient_arrival_at_hospital(
        dispatch.id,
        db=db,
        current_user=kmc_user,
    )
    assert arrival_res.status == "AT_HOSPITAL"
    assert arrival_res.patient_arrived_hospital_confirmed_at is not None

def test_ambulance_crash_alert_simulation_and_hospital_response(db: Session):
    hospitals = db.query(Hospital).order_by(Hospital.id).all()
    kmc = hospitals[0]
    aj = hospitals[1]
    amb = db.query(Ambulance).first()

    kmc_user = db.query(User).filter(User.hospital_id == kmc.id).first()
    aj_user = db.query(User).filter(User.hospital_id == aj.id).first()

    # 1. KMC simulates crash alert
    alert = simulate_crash_alert(
        CrashAlertSimulate(
            ambulance_id=amb.id,
            severity="CRITICAL",
            location_description="Ambedkar Circle near KMC ER entrance",
        ),
        db=db,
        current_user=kmc_user,
    )
    assert alert.hospital_id == kmc.id
    assert alert.severity == "CRITICAL"
    alert_id = alert.id

    # 2. In list crash alerts: KMC sees the alert, AJ cannot see it
    kmc_alerts = list_crash_alerts(db=db, current_user=kmc_user)
    assert any(a.id == alert_id for a in kmc_alerts)

    aj_alerts = list_crash_alerts(db=db, current_user=aj_user)
    assert not any(a.id == alert_id for a in aj_alerts)

    # 3. AJ cannot inspect KMC crash alert directly (403)
    with pytest.raises(HTTPException) as exc:
        get_crash_alert(alert_id, db=db, current_user=aj_user)
    assert exc.value.status_code == 403

    # 4. AJ cannot respond to KMC crash alert (403)
    with pytest.raises(HTTPException) as exc:
        respond_to_crash_alert(
            alert_id,
            CrashAlertResponseUpdate(status="RESOLVED"),
            db=db,
            current_user=aj_user,
        )
    assert exc.value.status_code == 403

    # 5. KMC responds to crash alert: ACKNOWLEDGED -> TEAM_NOTIFIED -> RESOLVED
    res_ack = respond_to_crash_alert(
        alert_id,
        CrashAlertResponseUpdate(status="ACKNOWLEDGED", response_notes="ER Triage acknowledged collision telemetry"),
        db=db,
        current_user=kmc_user,
    )
    assert res_ack.status == "ACKNOWLEDGED"

    res_res = respond_to_crash_alert(
        alert_id,
        CrashAlertResponseUpdate(status="RESOLVED", response_notes="Backup ALS arrived, patient transferred to trauma bay"),
        db=db,
        current_user=kmc_user,
    )
    assert res_res.status == "RESOLVED"
    assert "Backup ALS arrived" in res_res.response_notes
