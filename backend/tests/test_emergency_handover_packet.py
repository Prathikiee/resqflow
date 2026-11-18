import pytest
from fastapi import HTTPException
from backend.app.core.database import SessionLocal, Base, engine, upgrade_schema
from backend.app.models.entities import Incident, Ambulance, Hospital, Dispatch, HandoverPacket
from backend.app.services.seed_service import seed_database
from backend.app.api.dispatch import (
    create_dispatch,
    confirm_ambulance,
    confirm_hospital,
    advance_dispatch_lifecycle,
    reassign_dispatch,
    get_handover_packet,
    acknowledge_handover_packet,
)
from backend.app.schemas.dispatch import (
    DispatchRequest,
    ConfirmationDecision,
    HandoverAcknowledgeRequest,
)

@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.create_all(bind=engine)
    upgrade_schema()
    session = SessionLocal()
    seed_database(session, force=True)
    yield session
    session.close()

def test_handover_packet_not_generated_before_dual_confirmation(fresh_db):
    """
    Emergency Handover Packet must NOT be generated while confirmations are PENDING.
    get_handover_packet raises 404 before dual acceptance.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()

    disp = create_dispatch(DispatchRequest(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
    ), db=db)

    assert disp.coordination_status == "PENDING_CONFIRMATIONS"
    assert disp.handover_packet is None

    # Database check: no packet exists
    packet = db.query(HandoverPacket).filter(HandoverPacket.dispatch_id == disp.id).first()
    assert packet is None

    # Endpoint check: raises 404
    with pytest.raises(HTTPException) as exc_info:
        get_handover_packet(disp.id, db=db)
    assert exc_info.value.status_code == 404
    assert "dual confirmation" in exc_info.value.detail.lower()

def test_handover_packet_generated_on_dual_acceptance(fresh_db):
    """
    Emergency Handover Packet is generated automatically once BOTH ambulance and hospital accept.
    Verifies clinical assessment, triage rationale, resources, and privacy fields.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()

    disp = create_dispatch(DispatchRequest(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
    ), db=db)

    # 1. Ambulance accepts only -> still PENDING_CONFIRMATIONS, no packet
    confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    with pytest.raises(HTTPException) as exc_info:
        get_handover_packet(disp.id, db=db)
    assert exc_info.value.status_code == 404

    # 2. Hospital accepts -> Dual confirmation CONFIRMED -> packet generated
    disp_confirmed = confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    assert disp_confirmed.coordination_status == "CONFIRMED"

    # 3. get_handover_packet now returns complete packet
    pkt = get_handover_packet(disp.id, db=db)

    assert pkt.dispatch_id == disp.id
    assert pkt.incident_id == inc.id
    assert pkt.status == "SENT"
    assert pkt.patient_age == inc.patient_age
    assert pkt.patient_gender == (inc.patient_gender or "Unknown")
    assert pkt.chief_complaint == inc.chief_complaint
    assert isinstance(pkt.reported_symptoms, list)
    assert pkt.triage_priority == inc.triage_level
    assert pkt.triage_color == inc.triage_color
    assert pkt.triage_score == inc.triage_score
    assert len(pkt.triage_justifications) > 0

    assert pkt.ambulance_call_sign == amb.call_sign
    assert pkt.ambulance_vehicle_type == amb.vehicle_type
    assert isinstance(pkt.required_equipment, list)
    assert pkt.receiving_hospital_id == hosp.id
    assert pkt.receiving_hospital_name == hosp.name
    assert pkt.estimated_arrival_eta_seconds is not None

def test_handover_packet_hospital_acknowledgement(fresh_db):
    """
    acknowledge_handover_packet persists acknowledgment, timestamp, and staff details.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()

    disp = create_dispatch(DispatchRequest(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
    ), db=db)

    # Dual confirm
    confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)

    # Hospital acknowledges packet
    ack_res = acknowledge_handover_packet(
        disp.id,
        payload=HandoverAcknowledgeRequest(acknowledged_by="Dr. V. Shenoy (Emergency Department Chief)"),
        db=db,
    )
    assert ack_res.status == "ACKNOWLEDGED"
    assert ack_res.acknowledged_by == "Dr. V. Shenoy (Emergency Department Chief)"
    assert ack_res.acknowledged_at is not None

    # Verify database persistence
    db.expire_all()
    db_pkt = db.query(HandoverPacket).filter(HandoverPacket.dispatch_id == disp.id).first()
    assert db_pkt.status == "ACKNOWLEDGED"
    assert db_pkt.acknowledged_by == "Dr. V. Shenoy (Emergency Department Chief)"
    assert db_pkt.acknowledged_at is not None

def test_handover_packet_idempotency(fresh_db):
    """
    Repeated confirmation calls and multiple handover fetches do not duplicate records.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()

    disp = create_dispatch(DispatchRequest(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
    ), db=db)

    confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)

    # Repeated confirmations
    confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)

    # Multiple gets
    get_handover_packet(disp.id, db=db)
    get_handover_packet(disp.id, db=db)

    # Exactly one HandoverPacket record in DB
    packets = db.query(HandoverPacket).filter(HandoverPacket.dispatch_id == disp.id).all()
    assert len(packets) == 1

def test_handover_packet_survives_reassignment(fresh_db):
    """
    When a confirmed dispatch is reassigned, the handover packet is preserved
    and updated with the new ambulance unit, hospital, and routing ETA.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    ambs = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").all()
    assert len(ambs) >= 2
    amb1 = ambs[0]
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()

    disp = create_dispatch(DispatchRequest(
        incident_id=inc.id,
        ambulance_id=amb1.id,
        destination_hospital_id=hosp.id,
    ), db=db)

    # Dual confirm
    confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)

    # Hospital acknowledges
    acknowledge_handover_packet(
        disp.id,
        payload=HandoverAcknowledgeRequest(acknowledged_by="Nurse Incharge"),
        db=db,
    )

    orig_pkt = get_handover_packet(disp.id, db=db)
    assert orig_pkt.ambulance_call_sign == amb1.call_sign
    orig_pkt_id = orig_pkt.id

    # Reassign dispatch to next resource
    reassigned_disp = reassign_dispatch(disp.id, db=db)
    assert reassigned_disp.attempt_number == 2

    # Verify handover packet survived and updated
    survived_pkt = get_handover_packet(disp.id, db=db)
    assert survived_pkt.id == orig_pkt_id  # Same persistent record
    assert survived_pkt.dispatch_id == disp.id
    assert survived_pkt.ambulance_call_sign != amb1.call_sign  # Updated to replacement unit

def test_handover_packet_eta_updates_on_lifecycle_step(fresh_db):
    """
    When routing data changes (e.g. stepping to EN_ROUTE_HOSPITAL where route to hospital is calculated),
    the packet's ETA and distance are automatically updated.
    """
    db = fresh_db
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()

    disp = create_dispatch(DispatchRequest(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
    ), db=db)

    # Dual confirm
    confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)

    # Step to EN_ROUTE_INCIDENT
    advance_dispatch_lifecycle(disp.id, db=db)
    # Step to ON_SCENE
    advance_dispatch_lifecycle(disp.id, db=db)
    # Step to EN_ROUTE_HOSPITAL (calculates route to hospital)
    step3_disp = advance_dispatch_lifecycle(disp.id, db=db)

    # Handover packet should match dispatch's new estimated ETA and route distance
    pkt = get_handover_packet(disp.id, db=db)
    assert pkt.estimated_arrival_eta_seconds == step3_disp.estimated_eta_seconds
    assert pkt.route_distance_meters == step3_disp.route_distance_meters
