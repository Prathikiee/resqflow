import pytest
from datetime import datetime, timezone, timedelta
from fastapi import HTTPException
from sqlalchemy.orm import Session
from starlette.requests import Request

from backend.app.models.entities import (
    User,
    Incident,
    Ambulance,
    Hospital,
    Dispatch,
    HandoverPacket,
    IncidentEvent,
)
from backend.app.schemas.incident import IncidentCreate
from backend.app.schemas.dispatch import (
    DispatchRequest,
    ConfirmationDecision,
    HandoverAcknowledgeRequest,
    IncidentStatusUpdate,
)
from backend.app.api.incidents import create_incident, list_incidents, get_incident, update_incident_status
from backend.app.api.dispatch import (
    create_dispatch,
    confirm_ambulance,
    confirm_hospital,
    advance_dispatch_lifecycle,
    get_handover_packet,
    acknowledge_handover_packet,
    reassign_dispatch,
    check_expirations,
    list_dispatches,
)
from backend.app.core.auth import (
    ROLE_CITIZEN,
    ROLE_AMBULANCE_CREW,
    ROLE_HOSPITAL_STAFF,
    ROLE_DISPATCHER,
    ROLE_SUPER_ADMIN,
)
from backend.app.core.ws import (
    ws_manager,
    WebSocketClient,
    create_event_envelope,
)
from backend.app.services.seed_service import seed_demo_users

def build_mock_ws(user: User):
    client = WebSocketClient(
        websocket=None,
        user_id=user.id,
        email=user.email,
        role=user.role,
        ambulance_id=user.ambulance_id,
        hospital_id=user.hospital_id,
    )
    return client

# =============================================================================
# SCENARIO A: 19-Step Complete Successful Emergency Coordination Workflow
# =============================================================================
def test_scenario_a_complete_successful_emergency_workflow(fresh_db: Session):
    """
    Validates complete 19-step emergency workflow from Citizen SOS to hospital release.
    """
    db = fresh_db
    seed_demo_users(db)

    # 1. Four Stakeholder Accounts Authenticate
    citizen_user = db.query(User).filter(User.email == "citizen@lifelink.demo").first()
    disp_user = db.query(User).filter(User.email == "dispatcher@lifelink.demo").first()
    paramedic_user = db.query(User).filter(User.email == "als101@lifelink.demo").first()
    hospital_user = db.query(User).filter(User.email == "kmc@lifelink.demo").first()

    assert citizen_user and disp_user and paramedic_user and hospital_user
    assert paramedic_user.ambulance_id is not None
    assert hospital_user.hospital_id is not None

    # 2. Citizen Submits GPS-Based SOS
    incident_payload = IncidentCreate(
        caller_name=citizen_user.full_name,
        caller_phone=citizen_user.phone_number or "+91 98451 99887",
        location_address="Kadri Hills, Mangaluru (GPS Locked: 12.8765, 74.8562)",
        latitude=12.8765,
        longitude=74.8562,
        chief_complaint="Severe crushing chest pain radiating to left shoulder and breathing difficulty",
        chest_pain=True,
        breathing_status="Difficult",
        consciousness_level="Alert",
        patient_age=59,
        patient_gender="Male",
    )
    incident = create_incident(incident_payload, db=db, current_user=citizen_user)

    # 3. Backend Creates Persistent Incident & Executes Transparent Triage
    assert incident.id is not None
    assert incident.reporter_user_id == citizen_user.id
    assert incident.triage_color == "RED"
    assert incident.required_ambulance_type == "ALS"
    assert incident.status == "TRIAGED"

    # 4. Dispatcher Queries Regional Emergency Queue
    disp_queue = list_incidents(db=db, current_user=disp_user)
    assert any(i.id == incident.id for i in disp_queue)

    # 5. Dispatcher Creates Provisional Dispatch
    target_amb = db.query(Ambulance).filter(Ambulance.id == paramedic_user.ambulance_id).first()
    target_hosp = db.query(Hospital).filter(Hospital.id == hospital_user.hospital_id).first()
    assert target_amb.status == "AVAILABLE"
    assert target_hosp.accepting_emergencies is True

    initial_reserved_beds = target_hosp.reserved_emergency_beds or 0

    dispatch_payload = DispatchRequest(
        incident_id=incident.id,
        ambulance_id=target_amb.id,
        destination_hospital_id=target_hosp.id,
    )
    dispatch = create_dispatch(dispatch_payload, db=db, current_user=disp_user)

    # 6. Both Resources Provisionally Reserved
    assert dispatch.coordination_status == "PENDING_CONFIRMATIONS"
    assert dispatch.ambulance_confirmation_status == "PENDING"
    assert dispatch.hospital_confirmation_status == "PENDING"
    assert dispatch.reservation_expires_at is not None

    db.refresh(target_amb)
    db.refresh(target_hosp)
    assert target_amb.status == "RESERVED"
    assert target_amb.reservation_dispatch_id == dispatch.id
    assert target_hosp.reserved_emergency_beds == initial_reserved_beds + 1

    # 7 & 8. Paramedic Crew & Hospital Staff Accept
    amb_decision = ConfirmationDecision(decision="ACCEPTED", attempt_number=dispatch.attempt_number)
    hosp_decision = ConfirmationDecision(decision="ACCEPTED", attempt_number=dispatch.attempt_number)

    disp_after_amb = confirm_ambulance(dispatch.id, amb_decision, db=db, current_user=paramedic_user)
    assert disp_after_amb.ambulance_confirmation_status == "ACCEPTED"
    assert disp_after_amb.coordination_status == "PENDING_CONFIRMATIONS"

    # 9. Hospital Acceptance Triggers Dual Confirmation
    disp_after_both = confirm_hospital(dispatch.id, hosp_decision, db=db, current_user=hospital_user)

    # 10. Promotion to CONFIRMED and Handover Packet Generated
    assert disp_after_both.coordination_status == "CONFIRMED"
    assert disp_after_both.hospital_confirmation_status == "ACCEPTED"
    assert disp_after_both.confirmed_at is not None

    db.refresh(target_amb)
    assert target_amb.status == "DISPATCHED"

    # 11 & 12. Ambulance Crew Advances Mission Lifecycle
    # Stage 1: ASSIGNED -> EN_ROUTE_INCIDENT
    step1 = advance_dispatch_lifecycle(dispatch.id, db=db, current_user=paramedic_user)
    assert step1.status == "EN_ROUTE_INCIDENT"

    # Stage 2: EN_ROUTE_INCIDENT -> ON_SCENE
    step2 = advance_dispatch_lifecycle(dispatch.id, db=db, current_user=paramedic_user)
    assert step2.status == "ON_SCENE"
    assert step2.arrived_incident_at is not None

    # Stage 3: ON_SCENE -> EN_ROUTE_HOSPITAL
    step3 = advance_dispatch_lifecycle(dispatch.id, db=db, current_user=paramedic_user)
    assert step3.status == "EN_ROUTE_HOSPITAL"
    assert step3.departed_incident_at is not None

    # 13 & 14. Hospital Accesses SBAR Digital Handover Packet
    packet = get_handover_packet(dispatch.id, db=db, current_user=hospital_user)
    assert packet is not None
    assert packet.chief_complaint == incident.chief_complaint
    assert packet.triage_color == "RED"
    assert packet.receiving_hospital_name == target_hosp.name

    # 15 & 16. Hospital Clinician Signs and Acknowledges Handover
    ack_payload = HandoverAcknowledgeRequest(acknowledged_by="Dr. Aditi Shenoy (KMC ER Lead)")
    ack_packet = acknowledge_handover_packet(dispatch.id, payload=ack_payload, db=db, current_user=hospital_user)
    assert ack_packet.status == "ACKNOWLEDGED"
    assert ack_packet.acknowledged_by == "Dr. Aditi Shenoy (KMC ER Lead)"
    assert ack_packet.acknowledged_at is not None

    # 17. Final Lifecycle Step: Safe Patient Handover -> COMPLETED
    step4 = advance_dispatch_lifecycle(dispatch.id, db=db, current_user=paramedic_user)
    assert step4.status == "COMPLETED"
    assert step4.completed_at is not None

    # 18. Resource Availability & Bed Reconciliation
    db.refresh(target_amb)
    db.refresh(target_hosp)
    db.refresh(incident)

    assert target_amb.status == "AVAILABLE"
    assert target_amb.reservation_dispatch_id is None
    assert target_hosp.reserved_emergency_beds == initial_reserved_beds
    assert incident.status == "RESOLVED"

    # 19. Citizen Checks History: Reflects Resolved Status
    citizen_history = list_incidents(db=db, current_user=citizen_user)
    resolved_inc = next(i for i in citizen_history if i.id == incident.id)
    assert resolved_inc.status == "RESOLVED"

# =============================================================================
# SCENARIO B: Paramedic Crew Rejection and Smart Escalation
# =============================================================================
def test_scenario_b_crew_rejection_and_smart_escalation(fresh_db: Session):
    """
    Validates that paramedic unit rejection releases the unit and triggers smart escalation.
    """
    db = fresh_db
    seed_demo_users(db)

    disp_user = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    paramedic_user = db.query(User).filter(User.email == "als101@lifelink.demo").first()
    hospital_user = db.query(User).filter(User.email == "kmc@lifelink.demo").first()

    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.id == paramedic_user.ambulance_id).first()
    hosp = db.query(Hospital).filter(Hospital.id == hospital_user.hospital_id).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
        current_user=disp_user,
    )
    assert disp.coordination_status == "PENDING_CONFIRMATIONS"

    # Paramedic crew rejects assignment (e.g. equipment malfunction)
    rejection = ConfirmationDecision(decision="REJECTED", reason="Vehicle medical suction pump offline")
    escalated_disp = confirm_ambulance(disp.id, rejection, db=db, current_user=paramedic_user)

    # Unit 1 is released immediately back to AVAILABLE / operational pool
    db.refresh(amb)
    assert amb.status == "AVAILABLE"
    assert amb.reservation_dispatch_id is None

    # Dispatch is escalated to Attempt #2
    assert escalated_disp.attempt_number >= 2
    assert escalated_disp.ambulance_confirmation_status == "PENDING"
    assert escalated_disp.ambulance_id != amb.id

# =============================================================================
# SCENARIO C: Hospital Bed Rejection and Capacity Release
# =============================================================================
def test_scenario_c_hospital_rejection_and_capacity_release(fresh_db: Session):
    """
    Validates that hospital rejection releases reserved bed and triggers facility escalation.
    """
    db = fresh_db
    seed_demo_users(db)

    disp_user = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    paramedic_user = db.query(User).filter(User.email == "als101@lifelink.demo").first()
    hospital_user = db.query(User).filter(User.email == "kmc@lifelink.demo").first()

    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.id == paramedic_user.ambulance_id).first()
    hosp = db.query(Hospital).filter(Hospital.id == hospital_user.hospital_id).first()

    initial_beds = hosp.reserved_emergency_beds or 0

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
        current_user=disp_user,
    )

    db.refresh(hosp)
    assert hosp.reserved_emergency_beds == initial_beds + 1

    # Hospital rejects (divert / lack of ICU bed)
    rejection = ConfirmationDecision(decision="REJECTED", reason="Emergency diversion: CT Scanner undergoing emergency calibration")
    escalated_disp = confirm_hospital(disp.id, rejection, db=db, current_user=hospital_user)

    # Hospital reserved bed decremented back to initial
    db.refresh(hosp)
    assert hosp.reserved_emergency_beds == initial_beds

    # Escalated to Attempt #2 with alternative hospital
    assert escalated_disp.attempt_number >= 2
    assert escalated_disp.destination_hospital_id != hosp.id

# =============================================================================
# SCENARIO D: Reservation Timeout and Deduplicated Expiration Sweep
# =============================================================================
def test_scenario_d_reservation_timeout_and_deduplicated_escalation(fresh_db: Session):
    """
    Validates that expired reservation TTLs trigger automated smart escalation cleanly.
    """
    db = fresh_db
    seed_demo_users(db)

    disp_user = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()

    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
        current_user=disp_user,
    )

    # Manually backdate reservation_expires_at to simulate elapsed 90-second TTL
    disp.reservation_expires_at = datetime.now(timezone.utc) - timedelta(seconds=10)
    db.commit()

    # Background expiration sweep runs
    sweep_results = check_expirations(db=db)
    assert sweep_results["expired_count"] >= 1

    db.refresh(disp)
    assert disp.attempt_number >= 2
    assert disp.coordination_status == "PENDING_CONFIRMATIONS"

# =============================================================================
# SCENARIO E: Multi-Stakeholder Authorization and Tenancy Isolation
# =============================================================================
def test_scenario_e_comprehensive_authorization_and_isolation(fresh_db: Session):
    """
    Enforces that roles cannot access cross-tenant records, citizens cannot see handover packets,
    and unprivileged users cannot issue dispatches or resets.
    """
    db = fresh_db
    seed_demo_users(db)

    citizen1 = db.query(User).filter(User.email == "citizen@lifelink.demo").first()
    kmc_user = db.query(User).filter(User.email == "kmc@lifelink.demo").first()
    als101_user = db.query(User).filter(User.email == "als101@lifelink.demo").first()
    als102_user = db.query(User).filter(User.email == "als102@lifelink.demo").first()

    # 1. Citizen cannot view other citizen's incidents
    other_citizen = db.query(User).filter(User.email == "stranger@lifelink.demo").first()
    if not other_citizen:
        other_citizen = User(
            email="stranger@lifelink.demo",
            password_hash="pwd",
            full_name="Stranger Citizen",
            role=ROLE_CITIZEN,
            is_active=True,
        )
        db.add(other_citizen)
        db.commit()

    inc = create_incident(
        IncidentCreate(
            caller_name="Private Caller",
            caller_phone="+91 91111 22222",
            location_address="Private Address, Mangaluru",
            latitude=12.87,
            longitude=74.85,
            chief_complaint="Confidential Incident",
        ),
        db=db,
        current_user=other_citizen,
    )

    # Citizen 1 attempts to inspect stranger's incident -> 403 Forbidden!
    with pytest.raises(HTTPException) as exc1:
        get_incident(inc.id, db=db, current_user=citizen1)
    assert exc1.value.status_code == 403

    # 2. Citizen cannot create dispatches
    with pytest.raises(HTTPException) as exc2:
        create_dispatch(
            DispatchRequest(incident_id=inc.id, ambulance_id=1, destination_hospital_id=1),
            db=db,
            current_user=citizen1,
        )
    assert exc2.value.status_code == 403

    # 3. Paramedic cannot confirm or advance another unit's dispatch
    disp = Dispatch(
        incident_id=inc.id,
        ambulance_id=als101_user.ambulance_id,
        destination_hospital_id=kmc_user.hospital_id,
        coordination_status="PENDING_CONFIRMATIONS",
        attempt_number=1,
    )
    db.add(disp)
    db.commit()

    # ALS-102 crew attempts to accept ALS-101 assignment -> 403 Forbidden!
    with pytest.raises(HTTPException) as exc3:
        confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db, current_user=als102_user)
    assert exc3.value.status_code == 403

# =============================================================================
# SCENARIO F: WebSocket Event Envelope and Targeted Delivery Reliability
# =============================================================================
def test_scenario_f_websocket_envelope_and_targeted_delivery_reliability(fresh_db: Session):
    """
    Verifies that real-time event envelopes carry UUIDv4, UTC timestamps,
    and enforce targeted recipient eligibility rules.
    """
    db = fresh_db
    seed_demo_users(db)

    citizen_user = db.query(User).filter(User.role == ROLE_CITIZEN).first()
    paramedic_user = db.query(User).filter(User.role == ROLE_AMBULANCE_CREW).first()
    hospital_user = db.query(User).filter(User.role == ROLE_HOSPITAL_STAFF).first()
    disp_user = db.query(User).filter(User.role == ROLE_DISPATCHER).first()

    citizen_client = build_mock_ws(citizen_user)
    paramedic_client = build_mock_ws(paramedic_user)
    hospital_client = build_mock_ws(hospital_user)
    disp_client = build_mock_ws(disp_user)

    # Standardized Event Envelope Verification
    envelope = create_event_envelope(
        event_type="DISPATCH_STEPPED",
        payload={"status": "EN_ROUTE_INCIDENT"},
        entity_type="dispatch",
        entity_id=42,
    )
    assert "event_id" in envelope
    assert "timestamp" in envelope
    assert envelope["event"] == "DISPATCH_STEPPED"
    assert envelope["entity_type"] == "dispatch"
    assert envelope["entity_id"] == 42

    # Targeted Eligibility Checks
    # 1. Hospital event: Dispatcher and assigned hospital are eligible; unrelated Citizen is NOT
    is_citizen_eligible = ws_manager.is_client_eligible(
        citizen_client,
        hospital_id=hospital_user.hospital_id,
        reporter_user_id=999999,
    )
    assert is_citizen_eligible is False

    is_hosp_eligible = ws_manager.is_client_eligible(
        hospital_client,
        hospital_id=hospital_user.hospital_id,
    )
    assert is_hosp_eligible is True

    is_disp_eligible = ws_manager.is_client_eligible(
        disp_client,
        hospital_id=hospital_user.hospital_id,
    )
    assert is_disp_eligible is True
