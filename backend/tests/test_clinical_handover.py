import pytest
from datetime import datetime
from fastapi import HTTPException
from sqlalchemy.orm import Session
from backend.app.core.auth import ROLE_CITIZEN, ROLE_AMBULANCE_CREW, ROLE_HOSPITAL_STAFF
from backend.app.core.database import SessionLocal, Base, engine, upgrade_schema
from backend.app.models.entities import Incident, Ambulance, Hospital, Dispatch, HandoverPacket, User, PatientVitals
from backend.app.services.seed_service import seed_database
from backend.app.api.dispatch import (
    create_dispatch,
    confirm_ambulance,
    confirm_hospital,
    advance_dispatch_lifecycle,
    get_handover_packet,
    acknowledge_handover_packet,
    review_handover_packet,
    complete_handover_packet,
    confirm_patient_arrival_at_hospital,
    record_patient_vitals,
)
from backend.app.schemas.dispatch import (
    DispatchRequest,
    ConfirmationDecision,
    HandoverAcknowledgeRequest,
    HandoverReviewRequest,
    HandoverCompleteRequest,
)
from backend.app.schemas.vitals import VitalsCreate


@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.create_all(bind=engine)
    upgrade_schema()
    session = SessionLocal()
    # Clean up test vitals before re-seeding
    session.query(PatientVitals).delete()
    session.query(HandoverPacket).delete()
    session.commit()
    seed_database(session, force=True)
    yield session
    session.close()


def _setup_active_mission(db: Session):
    """Helper to set up a dual-confirmed mission with assigned ambulance and receiving hospital."""
    inc = db.query(Incident).filter(Incident.status.in_(["REPORTED", "TRIAGED"])).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hospitals = db.query(Hospital).filter(Hospital.accepting_emergencies == True).all()
    assert len(hospitals) >= 2, "Need at least 2 hospitals for RBAC tests"
    hosp_assigned = hospitals[0]
    hosp_other = hospitals[1]

    # Get authorized crew user
    crew_user = db.query(User).filter(User.ambulance_id == amb.id).first()
    if not crew_user:
        crew_user = User(
            email=f"crew_{amb.id}@lifelink.demo",
            password_hash="hash",
            full_name="Paramedic Test",
            role=ROLE_AMBULANCE_CREW,
            ambulance_id=amb.id,
        )
        db.add(crew_user)
        db.commit()
        db.refresh(crew_user)

    # Get hospital staff user for assigned hospital
    hosp_user = db.query(User).filter(User.hospital_id == hosp_assigned.id).first()
    if not hosp_user:
        hosp_user = User(
            email=f"hosp_{hosp_assigned.id}@lifelink.demo",
            password_hash="hash",
            full_name="Hospital ER Doctor",
            role=ROLE_HOSPITAL_STAFF,
            hospital_id=hosp_assigned.id,
        )
        db.add(hosp_user)
        db.commit()
        db.refresh(hosp_user)

    # Get hospital staff user for OTHER hospital
    other_hosp_user = db.query(User).filter(User.hospital_id == hosp_other.id).first()
    if not other_hosp_user:
        other_hosp_user = User(
            email=f"hosp_{hosp_other.id}@lifelink.demo",
            password_hash="hash",
            full_name="Other Hospital ER",
            role=ROLE_HOSPITAL_STAFF,
            hospital_id=hosp_other.id,
        )
        db.add(other_hosp_user)
        db.commit()
        db.refresh(other_hosp_user)

    # Dispatcher creates mission
    disp = create_dispatch(DispatchRequest(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp_assigned.id,
    ), db=db)

    # Dual confirm
    confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db, current_user=crew_user)
    confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db, current_user=hosp_user)

    db.refresh(disp)
    return disp, inc, amb, hosp_assigned, hosp_other, crew_user, hosp_user, other_hosp_user


def test_handover_packet_includes_patient_vitals_and_status(fresh_db):
    """
    Test that the clinical handover packet includes the latest patient vitals,
    recording timestamp, paramedic notes, and current mission/incident status.
    """
    db = fresh_db
    disp, inc, amb, hosp_assigned, _, crew_user, hosp_user, _ = _setup_active_mission(db)

    # Initially before vitals are logged, handover packet exists but latest_vitals is None
    pkt_initial = get_handover_packet(disp.id, db=db, current_user=hosp_user)
    assert pkt_initial.dispatch_id == disp.id
    assert pkt_initial.latest_vitals is None
    assert pkt_initial.mission_status == "ASSIGNED"

    # Paramedic records physiological vitals
    vitals_payload = VitalsCreate(
        heart_rate=88,
        blood_pressure_systolic=126,
        blood_pressure_diastolic=82,
        oxygen_saturation=97,
        respiratory_rate=18,
        notes="Patient conscious, mild pain on palpation",
    )
    v1 = record_patient_vitals(disp.id, vitals_payload, db=db, current_user=crew_user)
    assert v1.heart_rate == 88

    # Paramedic steps mission to EN_ROUTE_HOSPITAL
    advance_dispatch_lifecycle(disp.id, db=db, current_user=crew_user)  # EN_ROUTE_INCIDENT
    advance_dispatch_lifecycle(disp.id, db=db, current_user=crew_user)  # ON_SCENE
    advance_dispatch_lifecycle(disp.id, db=db, current_user=crew_user)  # EN_ROUTE_HOSPITAL

    # Hospital fetches handover packet
    pkt = get_handover_packet(disp.id, db=db, current_user=hosp_user)

    assert pkt.dispatch_id == disp.id
    assert pkt.incident_id == inc.id
    assert pkt.ambulance_call_sign == amb.call_sign
    assert pkt.receiving_hospital_id == hosp_assigned.id

    # Verify clinical vitals in handover packet
    assert pkt.latest_vitals is not None
    assert pkt.latest_vitals.heart_rate == 88
    assert pkt.latest_vitals.blood_pressure_systolic == 126
    assert pkt.latest_vitals.blood_pressure_diastolic == 82
    assert pkt.latest_vitals.oxygen_saturation == 97
    assert pkt.latest_vitals.respiratory_rate == 18
    assert pkt.latest_vitals.notes == "Patient conscious, mild pain on palpation"
    assert pkt.latest_vitals.recorded_at is not None

    # Verify mission and incident status
    assert pkt.mission_status == "EN_ROUTE_HOSPITAL"
    assert pkt.incident_status == "TRANSPORTING"
    assert len(pkt.vitals) == 1


def test_hospital_arrival_confirmation_and_bed_synchronization(fresh_db):
    """
    Test hospital receiving workflow:
    - ER arrival confirmation sets patient_arrived_hospital_confirmed_at.
    - Transitions dispatch and incident status to AT_HOSPITAL.
    - Synchronizes reserved bed capacity.
    - Allows subsequent clean mission completion by ambulance crew.
    """
    db = fresh_db
    disp, inc, amb, hosp_assigned, _, crew_user, hosp_user, _ = _setup_active_mission(db)

    # Step to EN_ROUTE_HOSPITAL
    advance_dispatch_lifecycle(disp.id, db=db, current_user=crew_user)
    advance_dispatch_lifecycle(disp.id, db=db, current_user=crew_user)
    advance_dispatch_lifecycle(disp.id, db=db, current_user=crew_user)

    # Hospital bed was reserved
    initial_reserved = hosp_assigned.reserved_emergency_beds or 0

    # Hospital staff confirms patient arrival at ER bay
    confirmed_disp = confirm_patient_arrival_at_hospital(disp.id, db=db, current_user=hosp_user)

    assert confirmed_disp.status == "AT_HOSPITAL"
    assert confirmed_disp.patient_arrived_hospital_confirmed_at is not None
    assert confirmed_disp.arrived_hospital_at is not None

    # Incident status synchronized
    db.refresh(inc)
    assert inc.status == "AT_HOSPITAL"

    # Bed reservation synchronized
    db.refresh(hosp_assigned)
    assert hosp_assigned.reserved_emergency_beds <= initial_reserved

    # Ambulance crew can complete handover and finish mission from AT_HOSPITAL
    completed_disp = advance_dispatch_lifecycle(disp.id, db=db, current_user=crew_user)
    assert completed_disp.status == "COMPLETED"

    db.refresh(amb)
    assert amb.status == "AVAILABLE"
    db.refresh(inc)
    assert inc.status == "RESOLVED"


def test_hospital_data_isolation_and_rbac(fresh_db):
    """
    Strict Hospital Data Isolation:
    - Unauthorized hospital staff from another hospital CANNOT access or confirm mission.
    - Citizens CANNOT access or confirm mission.
    - Authorized hospital staff CAN view, review, acknowledge, and confirm arrival.
    """
    db = fresh_db
    disp, inc, amb, hosp_assigned, hosp_other, crew_user, hosp_user, other_hosp_user = _setup_active_mission(db)

    citizen_user = db.query(User).filter(User.role == ROLE_CITIZEN).first()
    if not citizen_user:
        citizen_user = User(
            email="citizen_test@lifelink.demo",
            password_hash="hash",
            full_name="Citizen User",
            role=ROLE_CITIZEN,
        )
        db.add(citizen_user)
        db.commit()
        db.refresh(citizen_user)

    # 1. Other hospital staff attempts to view handover packet -> 403 Forbidden
    with pytest.raises(HTTPException) as exc1:
        get_handover_packet(disp.id, db=db, current_user=other_hosp_user)
    assert exc1.value.status_code == 403
    assert "routed to their own facility" in exc1.value.detail

    # 2. Other hospital staff attempts to acknowledge handover -> 403 Forbidden
    with pytest.raises(HTTPException) as exc2:
        acknowledge_handover_packet(
            disp.id,
            payload=HandoverAcknowledgeRequest(acknowledged_by="Dr. Impostor"),
            db=db,
            current_user=other_hosp_user,
        )
    assert exc2.value.status_code == 403

    # 3. Other hospital staff attempts to confirm patient arrival -> 403 Forbidden
    with pytest.raises(HTTPException) as exc3:
        confirm_patient_arrival_at_hospital(disp.id, db=db, current_user=other_hosp_user)
    assert exc3.value.status_code == 403
    assert "another hospital facility" in exc3.value.detail

    # 4. Citizen attempts to confirm arrival or view handover -> 403 Forbidden
    with pytest.raises(HTTPException) as exc4:
        get_handover_packet(disp.id, db=db, current_user=citizen_user)
    assert exc4.value.status_code == 403

    with pytest.raises(HTTPException) as exc5:
        confirm_patient_arrival_at_hospital(disp.id, db=db, current_user=citizen_user)
    assert exc5.value.status_code == 403

    # 5. Authorized hospital staff succeeds in full handover workflow
    # Acknowledge
    ack = acknowledge_handover_packet(
        disp.id,
        payload=HandoverAcknowledgeRequest(acknowledged_by="Dr. Authorized KMC Staff"),
        db=db,
        current_user=hosp_user,
    )
    assert ack.status == "ACKNOWLEDGED"

    # Review
    rev = review_handover_packet(
        disp.id,
        payload=HandoverReviewRequest(reviewed_by="Dr. Authorized KMC Staff", receiving_notes="Triage bay 2 prepared"),
        db=db,
        current_user=hosp_user,
    )
    assert rev.receiving_clinician == "Dr. Authorized KMC Staff"

    # Confirm arrival
    arrival = confirm_patient_arrival_at_hospital(disp.id, db=db, current_user=hosp_user)
    assert arrival.status == "AT_HOSPITAL"

    # Complete handover
    comp = complete_handover_packet(
        disp.id,
        payload=HandoverCompleteRequest(completed_by="Dr. Authorized KMC Staff"),
        db=db,
        current_user=hosp_user,
    )
    assert comp.status == "COMPLETED"
