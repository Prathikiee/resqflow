import pytest
from datetime import datetime, timezone
from fastapi import HTTPException
from backend.app.core.database import SessionLocal, Base, engine, upgrade_schema
from backend.app.models.entities import Incident, Ambulance, Hospital, Dispatch, IncidentEvent
from backend.app.services.seed_service import seed_database
from backend.app.api.incidents import create_incident, get_incident_timeline
from backend.app.schemas.incident import IncidentCreate
from backend.app.api.dispatch import (
    create_dispatch,
    confirm_ambulance,
    confirm_hospital,
    advance_dispatch_lifecycle,
    acknowledge_handover_packet,
)
from backend.app.schemas.dispatch import DispatchRequest, ConfirmationDecision, HandoverAcknowledgeRequest
from backend.app.api.witness_reports import create_witness_report, link_witness_report
from backend.app.schemas.witness_report import WitnessReportCreate, WitnessReportLinkRequest

@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.create_all(bind=engine)
    upgrade_schema()
    session = SessionLocal()
    seed_database(session, force=True)
    yield session
    session.close()

def test_incident_registration_logs_initial_timeline_events(fresh_db):
    """
    Creating an incident automatically logs EMERGENCY_REGISTERED and TRIAGE_COMPLETED.
    GET /api/incidents/{id}/timeline returns chronological events.
    """
    db = fresh_db
    inc = create_incident(IncidentCreate(
        caller_name="Meera Nayak",
        caller_phone="9845012345",
        location_address="KSRTC Bus Stand, Bejai, Mangaluru",
        latitude=12.8870,
        longitude=74.8480,
        chief_complaint="Severe crushing chest pain radiating to left arm",
        consciousness_level="Alert",
        breathing_status="Difficult",
        chest_pain=True,
        patient_age=58,
    ), db=db)

    timeline = get_incident_timeline(inc.id, db=db)
    assert len(timeline) >= 2

    types = [e.event_type for e in timeline]
    assert "EMERGENCY_REGISTERED" in types
    assert "TRIAGE_COMPLETED" in types

    reg_event = next(e for e in timeline if e.event_type == "EMERGENCY_REGISTERED")
    assert reg_event.actor_type == "CALLER"
    assert "Meera Nayak" in reg_event.actor_reference

    triage_event = next(e for e in timeline if e.event_type == "TRIAGE_COMPLETED")
    assert triage_event.actor_type == "SYSTEM"
    assert "Priority 1" in triage_event.event_title

def test_full_operational_coordination_timeline(fresh_db):
    """
    Verifies that the timeline records every key lifecycle event:
    Registration -> Witness correlation & linking -> Reservation -> Confirmations
    -> Handover compilation -> Hospital acknowledgment -> Lifecycle completion.
    """
    db = fresh_db

    # 1. Register master incident
    inc = create_incident(IncidentCreate(
        caller_name="Ramesh Rao",
        caller_phone="9876543210",
        location_address="Hampankatta Junction",
        latitude=12.8650,
        longitude=74.8420,
        chief_complaint="Road accident with bike skid",
        severe_bleeding=True,
    ), db=db)

    # 2. Ingest duplicate witness report
    rep = create_witness_report(WitnessReportCreate(
        reporter_identifier="Citizen Eyewitness",
        incident_description="Motorcycle accident on wet asphalt at Hampankatta",
        incident_type="Road Traffic Accident",
        latitude=12.8655,
        longitude=74.8423,
    ), db=db)

    # 3. Link witness report
    link_witness_report(rep.id, WitnessReportLinkRequest(master_incident_id=inc.id), db=db)

    # 4. Dispatch resources
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).filter(Hospital.accepting_emergencies == True).first()
    disp = create_dispatch(DispatchRequest(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
    ), db=db)

    # 5. Dual confirmation
    confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)

    # 6. Handover acknowledgment
    acknowledge_handover_packet(disp.id, HandoverAcknowledgeRequest(acknowledged_by="Dr. Shenoy"), db=db)

    # 7. Advance lifecycle to completion
    advance_dispatch_lifecycle(disp.id, db=db)  # EN_ROUTE_INCIDENT
    advance_dispatch_lifecycle(disp.id, db=db)  # ON_SCENE
    advance_dispatch_lifecycle(disp.id, db=db)  # EN_ROUTE_HOSPITAL
    advance_dispatch_lifecycle(disp.id, db=db)  # COMPLETED

    # Fetch complete timeline
    timeline = get_incident_timeline(inc.id, db=db)
    types = [e.event_type for e in timeline]

    expected_types = [
        "EMERGENCY_REGISTERED",
        "TRIAGE_COMPLETED",
        "WITNESS_REPORT_RECEIVED",
        "WITNESS_REPORT_LINKED",
        "RESOURCES_RESERVED",
        "AMBULANCE_ACCEPTED",
        "HOSPITAL_ACCEPTED",
        "DUAL_CONFIRMATION_COMPLETED",
        "HANDOVER_PACKET_GENERATED",
        "HANDOVER_ACKNOWLEDGED",
        "LIFECYCLE_STEPPED",
        "EMERGENCY_COMPLETED",
    ]

    for expected in expected_types:
        assert expected in types, f"Expected event {expected} to be recorded in timeline"

    # Verify chronological ascending order
    for i in range(len(timeline) - 1):
        assert timeline[i].created_at <= timeline[i + 1].created_at

def test_escalation_timeline_events(fresh_db):
    """
    Verifies that ambulance rejection logs AMBULANCE_REJECTED, ESCALATION_TRIGGERED,
    and RESOURCE_REASSIGNED with attempt numbers in the timeline.
    """
    db = fresh_db
    inc = create_incident(IncidentCreate(
        caller_name="Pooja",
        caller_phone="9988776655",
        location_address="Kadri Park, Mangaluru",
        latitude=12.8850,
        longitude=74.8550,
        chief_complaint="Pedestrian hit by car",
    ), db=db)

    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).first()
    disp = create_dispatch(DispatchRequest(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
    ), db=db)

    # Ambulance rejects -> triggers smart escalation
    confirm_ambulance(disp.id, ConfirmationDecision(decision="REJECTED", reason="Flat tire on en-route vehicle"), db=db)

    timeline = get_incident_timeline(inc.id, db=db)
    types = [e.event_type for e in timeline]

    assert "AMBULANCE_REJECTED" in types
    assert "ESCALATION_TRIGGERED" in types
    assert "RESOURCE_REASSIGNED" in types

    reassign_event = next(e for e in timeline if e.event_type == "RESOURCE_REASSIGNED")
    assert reassign_event.event_metadata.get("attempt_number") == 2
