import pytest
import uuid
from datetime import datetime, timezone
from fastapi import HTTPException
from pydantic import ValidationError

from backend.app.models.entities import Incident, Ambulance, Hospital, Dispatch, User, PatientVitals
from backend.app.schemas.incident import IncidentCreate
from backend.app.schemas.dispatch import DispatchRequest, ConfirmationDecision
from backend.app.schemas.vitals import VitalsCreate
from backend.app.api.incidents import create_incident
from backend.app.api.dispatch import (
    create_dispatch,
    confirm_ambulance,
    confirm_hospital,
    advance_dispatch_lifecycle,
    record_patient_vitals,
    list_patient_vitals,
    get_latest_patient_vitals,
)
from backend.app.core.auth import (
    ROLE_CITIZEN,
    ROLE_AMBULANCE_CREW,
    ROLE_HOSPITAL_STAFF,
    ROLE_DISPATCHER,
)


def _setup_confirmed_mission(db):
    """Helper to create and dual-confirm an active emergency mission with assigned crew."""
    inc_payload = IncidentCreate(
        caller_name="Rajesh Kumar",
        caller_phone="+91 98800 11223",
        location_address="Kankanady Junction, Mangaluru",
        latitude=12.8680,
        longitude=74.8560,
        chief_complaint="Severe shortness of breath and chest pressure",
        chest_pain=True,
        breathing_status="Difficult",
        consciousness_level="Alert",
        patient_age=55,
        patient_gender="Male",
    )
    incident = create_incident(payload=inc_payload, db=db)

    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.available_emergency_beds > 0).first()

    disp_req = DispatchRequest(
        incident_id=incident.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
    )
    dispatch = create_dispatch(payload=disp_req, db=db)

    # Dual confirm
    confirm_ambulance(dispatch_id=dispatch.id, payload=ConfirmationDecision(decision="ACCEPTED"), db=db)
    confirm_hospital(dispatch_id=dispatch.id, payload=ConfirmationDecision(decision="ACCEPTED"), db=db)

    db.refresh(dispatch)

    # Ensure assigned crew user exists
    crew = db.query(User).filter(User.ambulance_id == amb.id, User.role == ROLE_AMBULANCE_CREW).first()
    if not crew:
        crew = User(
            email=f"paramedic_{uuid.uuid4().hex[:6]}@lifelink.demo",
            password_hash="hashed",
            full_name=f"Paramedic Unit {amb.call_sign}",
            role=ROLE_AMBULANCE_CREW,
            ambulance_id=amb.id,
            is_active=True,
        )
        db.add(crew)
        db.commit()
        db.refresh(crew)

    return dispatch, amb, hosp, incident, crew


def test_vitals_model_and_persistence(db):
    """Verifies that patient vitals are correctly persisted and linked to active dispatch."""
    dispatch, amb, hosp, incident, crew_user = _setup_confirmed_mission(db)

    vitals_in = VitalsCreate(
        heart_rate=88,
        blood_pressure_systolic=126,
        blood_pressure_diastolic=82,
        oxygen_saturation=96,
        respiratory_rate=18,
        notes="Patient conscious, resting comfortably with supplemental oxygen.",
    )

    result = record_patient_vitals(
        dispatch_id=dispatch.id,
        payload=vitals_in,
        db=db,
        current_user=crew_user,
    )

    assert result.id is not None
    assert result.dispatch_id == dispatch.id
    assert result.incident_id == dispatch.incident_id
    assert result.heart_rate == 88
    assert result.blood_pressure_systolic == 126
    assert result.blood_pressure_diastolic == 82
    assert result.blood_pressure_display == "126/82"
    assert result.oxygen_saturation == 96
    assert result.respiratory_rate == 18
    assert "resting comfortably" in result.notes

    # Verify query from database and relationship on dispatch
    db.refresh(dispatch)
    assert len(dispatch.vitals) >= 1
    assert dispatch.latest_vitals.id == result.id
    assert dispatch.latest_vitals.heart_rate == 88


def test_vitals_validation_ranges():
    """Verifies Pydantic physiological validation rules."""
    # Valid vitals
    valid = VitalsCreate(
        heart_rate=72,
        blood_pressure_systolic=120,
        blood_pressure_diastolic=80,
        oxygen_saturation=99,
        respiratory_rate=16,
    )
    assert valid.heart_rate == 72

    # Heart rate out of bounds
    with pytest.raises(ValidationError):
        VitalsCreate(
            heart_rate=20,  # Below 30
            blood_pressure_systolic=120,
            blood_pressure_diastolic=80,
            oxygen_saturation=99,
            respiratory_rate=16,
        )

    with pytest.raises(ValidationError):
        VitalsCreate(
            heart_rate=300,  # Above 250
            blood_pressure_systolic=120,
            blood_pressure_diastolic=80,
            oxygen_saturation=99,
            respiratory_rate=16,
        )

    # Systolic <= Diastolic must be rejected
    with pytest.raises(ValidationError):
        VitalsCreate(
            heart_rate=80,
            blood_pressure_systolic=70,  # Less than diastolic
            blood_pressure_diastolic=90,
            oxygen_saturation=98,
            respiratory_rate=16,
        )

    with pytest.raises(ValidationError):
        VitalsCreate(
            heart_rate=80,
            blood_pressure_systolic=80,  # Equal to diastolic
            blood_pressure_diastolic=80,
            oxygen_saturation=98,
            respiratory_rate=16,
        )

    # SpO2 out of bounds
    with pytest.raises(ValidationError):
        VitalsCreate(
            heart_rate=80,
            blood_pressure_systolic=120,
            blood_pressure_diastolic=80,
            oxygen_saturation=40,  # Below 50
            respiratory_rate=16,
        )

    with pytest.raises(ValidationError):
        VitalsCreate(
            heart_rate=80,
            blood_pressure_systolic=120,
            blood_pressure_diastolic=80,
            oxygen_saturation=105,  # Above 100
            respiratory_rate=16,
        )

    # Respiratory rate out of bounds
    with pytest.raises(ValidationError):
        VitalsCreate(
            heart_rate=80,
            blood_pressure_systolic=120,
            blood_pressure_diastolic=80,
            oxygen_saturation=98,
            respiratory_rate=4,  # Below 5
        )

    with pytest.raises(ValidationError):
        VitalsCreate(
            heart_rate=80,
            blood_pressure_systolic=120,
            blood_pressure_diastolic=80,
            oxygen_saturation=98,
            respiratory_rate=75,  # Above 60
        )


def test_vitals_authorization_and_rbac(db):
    """Verifies that only authenticated ambulance users (or authorized roles) can record vitals."""
    dispatch, amb, hosp, incident, assigned_paramedic = _setup_confirmed_mission(db)

    valid_payload = VitalsCreate(
        heart_rate=80,
        blood_pressure_systolic=120,
        blood_pressure_diastolic=80,
        oxygen_saturation=98,
        respiratory_rate=16,
    )

    # 1. Unauthenticated request -> HTTP 401
    with pytest.raises(HTTPException) as exc:
        record_patient_vitals(
            dispatch_id=dispatch.id,
            payload=valid_payload,
            db=db,
            current_user=None,
        )
    assert exc.value.status_code == 401

    # 2. Citizen user -> HTTP 403
    citizen = db.query(User).filter(User.role == ROLE_CITIZEN).first()
    if not citizen:
        citizen = User(
            email=f"citizen_{uuid.uuid4().hex[:6]}@gmail.com",
            password_hash="hashed",
            full_name="Citizen Tester",
            role=ROLE_CITIZEN,
            is_active=True,
        )
        db.add(citizen)
        db.commit()
    with pytest.raises(HTTPException) as exc:
        record_patient_vitals(
            dispatch_id=dispatch.id,
            payload=valid_payload,
            db=db,
            current_user=citizen,
        )
    assert exc.value.status_code == 403
    assert "Citizens cannot record" in exc.value.detail

    # 3. Hospital staff user -> HTTP 403
    hospital_staff = db.query(User).filter(User.role == ROLE_HOSPITAL_STAFF).first()
    if not hospital_staff:
        hospital_staff = User(
            email=f"nurse_{uuid.uuid4().hex[:6]}@hospital.in",
            password_hash="hashed",
            full_name="Nurse ER",
            role=ROLE_HOSPITAL_STAFF,
            hospital_id=hosp.id,
            is_active=True,
        )
        db.add(hospital_staff)
        db.commit()
    with pytest.raises(HTTPException) as exc:
        record_patient_vitals(
            dispatch_id=dispatch.id,
            payload=valid_payload,
            db=db,
            current_user=hospital_staff,
        )
    assert exc.value.status_code == 403
    assert "Hospital staff cannot record" in exc.value.detail

    # 4. Paramedic of a DIFFERENT ambulance -> HTTP 403
    other_amb = db.query(Ambulance).filter(Ambulance.id != amb.id).first()
    other_paramedic = User(
        email=f"paramedic_other_{uuid.uuid4().hex[:6]}@resqflow.in",
        password_hash="hashed",
        full_name="Paramedic Other",
        role=ROLE_AMBULANCE_CREW,
        ambulance_id=other_amb.id if other_amb else 9999,
        is_active=True,
    )
    db.add(other_paramedic)
    db.commit()
    with pytest.raises(HTTPException) as exc:
        record_patient_vitals(
            dispatch_id=dispatch.id,
            payload=valid_payload,
            db=db,
            current_user=other_paramedic,
        )
    assert exc.value.status_code == 403
    assert "their own assigned ambulance unit" in exc.value.detail

    # 5. Assigned paramedic crew -> SUCCESS (HTTP 201)
    res = record_patient_vitals(
        dispatch_id=dispatch.id,
        payload=valid_payload,
        db=db,
        current_user=assigned_paramedic,
    )
    assert res.id is not None
    assert res.recorded_by_user_id == assigned_paramedic.id


def test_vitals_mission_status_guards(db):
    """Verifies that vitals cannot be recorded on unconfirmed or terminal missions."""
    inc_payload = IncidentCreate(
        caller_name="Pooja Rai",
        caller_phone="+91 98800 22334",
        location_address="State Bank Circle, Mangaluru",
        latitude=12.8610,
        longitude=74.8420,
        chief_complaint="Dizziness and palpitations",
        patient_age=40,
        patient_gender="Female",
    )
    incident = create_incident(payload=inc_payload, db=db)
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    disp_req = DispatchRequest(incident_id=incident.id, ambulance_id=amb.id)
    dispatch = create_dispatch(payload=disp_req, db=db)

    crew_user = db.query(User).filter(User.ambulance_id == amb.id, User.role == ROLE_AMBULANCE_CREW).first()
    if not crew_user:
        crew_user = User(
            email=f"crew_guards_{uuid.uuid4().hex[:6]}@resqflow.in",
            password_hash="hashed",
            full_name="Crew Guard",
            role=ROLE_AMBULANCE_CREW,
            ambulance_id=amb.id,
            is_active=True,
        )
        db.add(crew_user)
        db.commit()
        db.refresh(crew_user)

    vitals_in = VitalsCreate(
        heart_rate=92,
        blood_pressure_systolic=118,
        blood_pressure_diastolic=76,
        oxygen_saturation=98,
        respiratory_rate=18,
    )

    # 1. Unconfirmed dispatch -> HTTP 400
    with pytest.raises(HTTPException) as exc:
        record_patient_vitals(dispatch_id=dispatch.id, payload=vitals_in, db=db, current_user=crew_user)
    assert exc.value.status_code == 400
    assert "must be dual-confirmed" in exc.value.detail

    # Confirm dispatch and advance through lifecycle
    confirm_ambulance(dispatch_id=dispatch.id, payload=ConfirmationDecision(decision="ACCEPTED"), db=db)
    # Hospital is None so ambulance confirmation confirms it
    db.refresh(dispatch)
    assert dispatch.coordination_status == "CONFIRMED"

    # Can record vitals on active mission (EN_ROUTE, ON_SCENE, EN_ROUTE_HOSPITAL)
    advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db)  # ASSIGNED -> EN_ROUTE_INCIDENT
    v1 = record_patient_vitals(dispatch_id=dispatch.id, payload=vitals_in, db=db, current_user=crew_user)
    assert v1.id is not None

    advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db)  # EN_ROUTE_INCIDENT -> ON_SCENE
    advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db)  # ON_SCENE -> EN_ROUTE_HOSPITAL
    advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db)  # EN_ROUTE_HOSPITAL -> COMPLETED

    db.refresh(dispatch)
    assert dispatch.status == "COMPLETED"

    # 2. Terminal stage (COMPLETED) -> HTTP 400
    with pytest.raises(HTTPException) as exc:
        record_patient_vitals(dispatch_id=dispatch.id, payload=vitals_in, db=db, current_user=crew_user)
    assert exc.value.status_code == 400
    assert "terminal stage" in exc.value.detail


def test_vitals_duplicate_prevention_and_listing(db):
    """Verifies that rapid duplicate submissions return existing record and list endpoint works."""
    dispatch, amb, hosp, incident, crew_user = _setup_confirmed_mission(db)

    # Clear any leftover vitals on this fresh dispatch
    db.query(PatientVitals).filter(PatientVitals.dispatch_id == dispatch.id).delete()
    db.commit()

    vitals_1 = VitalsCreate(
        heart_rate=80,
        blood_pressure_systolic=120,
        blood_pressure_diastolic=80,
        oxygen_saturation=98,
        respiratory_rate=16,
        notes="Initial reading",
    )

    # First submission
    rec1 = record_patient_vitals(dispatch_id=dispatch.id, payload=vitals_1, db=db, current_user=crew_user)

    # Immediate second identical submission (simulating accidental double click)
    rec2 = record_patient_vitals(dispatch_id=dispatch.id, payload=vitals_1, db=db, current_user=crew_user)

    # Must return the identical record ID without adding another row to the database
    assert rec1.id == rec2.id

    all_vitals = list_patient_vitals(dispatch_id=dispatch.id, db=db, current_user=crew_user)
    assert len(all_vitals) == 1

    # Now submit an updated reading with different vitals (e.g., patient condition changes en route)
    vitals_2 = VitalsCreate(
        heart_rate=95,
        blood_pressure_systolic=135,
        blood_pressure_diastolic=88,
        oxygen_saturation=95,
        respiratory_rate=22,
        notes="En route update: heart rate elevated",
    )
    rec3 = record_patient_vitals(dispatch_id=dispatch.id, payload=vitals_2, db=db, current_user=crew_user)

    assert rec3.id != rec1.id

    # Verify listing returns both, newest first
    updated_list = list_patient_vitals(dispatch_id=dispatch.id, db=db, current_user=crew_user)
    assert len(updated_list) == 2
    assert updated_list[0].id == rec3.id
    assert updated_list[0].heart_rate == 95
    assert updated_list[1].id == rec1.id
    assert updated_list[1].heart_rate == 80

    # Verify latest vitals endpoint
    latest = get_latest_patient_vitals(dispatch_id=dispatch.id, db=db, current_user=crew_user)
    assert latest is not None
    assert latest.id == rec3.id
    assert latest.heart_rate == 95
