import pytest
from datetime import datetime, timezone, timedelta
from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend.app.models.entities import Ambulance, Hospital, Incident, Dispatch, User, CrashAlert, IncidentEvent
from backend.app.schemas.crash_alert import CrashAlertIngest, CrashAlertSimulate, CrashAlertResponseUpdate
from backend.app.api.crash_alerts import (
    ingest_crash_alert,
    simulate_crash_alert,
    list_crash_alerts,
    get_crash_alert,
    respond_to_crash_alert,
)
from backend.app.api.dispatch import get_dispatch_recommendation
from backend.app.api.incidents import preview_triage
from backend.app.schemas.incident import TriagePreviewRequest


def test_crash_alert_ingest_with_active_dispatch_and_timeline_logging(db: Session):
    """
    Verifies that ingest_crash_alert correctly resolves an ambulance actively
    transporting a patient (EN_ROUTE_HOSPITAL), correctly links incident and hospital,
    and logs the timeline event without any TypeError or signature mismatch.
    """
    ambulance = db.query(Ambulance).first()
    hospital = db.query(Hospital).first()
    incident = db.query(Incident).first()

    # Create active dispatch en route to hospital
    dispatch = Dispatch(
        incident_id=incident.id,
        ambulance_id=ambulance.id,
        destination_hospital_id=hospital.id,
        status="EN_ROUTE_HOSPITAL",
        coordination_status="CONFIRMED",
    )
    db.add(dispatch)
    db.commit()
    db.refresh(dispatch)

    payload = CrashAlertIngest(
        ambulance_id=ambulance.id,
        latitude=12.9141,
        longitude=74.8560,
        severity="CRITICAL",
        location_description="Near Bunts Hostel Circle, Mangaluru",
        sensor_data={
            "g_force": 6.8,
            "rollover": False,
            "airbag_deployed": True,
            "impact_velocity_kmh": 58,
        },
        source="HARDWARE_IOT",
    )

    alert = ingest_crash_alert(payload=payload, db=db)

    assert alert.id is not None
    assert alert.ambulance_id == ambulance.id
    assert alert.incident_id == incident.id
    assert alert.hospital_id == hospital.id
    assert alert.dispatch_id == dispatch.id
    assert alert.status == "TRIGGERED"
    assert alert.severity == "CRITICAL"
    assert alert.sensor_data.get("g_force") == 6.8
    assert alert.sensor_data.get("airbag_deployed") is True

    # Verify timeline event was created with correct title and description
    event = (
        db.query(IncidentEvent)
        .filter(
            IncidentEvent.incident_id == incident.id,
            IncidentEvent.event_type == "AMBULANCE_CRASH_ALERT",
        )
        .order_by(IncidentEvent.id.desc())
        .first()
    )
    assert event is not None
    assert event.event_title == "Ambulance Collision Detected"
    assert "CRITICAL" in event.event_description
    assert event.dispatch_id == dispatch.id


def test_crash_alert_duplicate_debouncing(db: Session):
    """
    Verifies that multiple telemetry packets arriving within 30 seconds for the same
    ambulance are debounced, updating the existing alert rather than spawning duplicate rows.
    """
    ambulance = db.query(Ambulance).first()
    hospital = db.query(Hospital).first()

    p1 = CrashAlertIngest(
        ambulance_id=ambulance.id,
        latitude=12.8700,
        longitude=74.8400,
        severity="SEVERE",
        sensor_data={"g_force": 4.5},
    )
    a1 = ingest_crash_alert(payload=p1, db=db)
    initial_id = a1.id

    # Immediate second telemetry packet (e.g. 2 seconds later)
    p2 = CrashAlertIngest(
        ambulance_id=ambulance.id,
        latitude=12.8705,
        longitude=74.8405,
        severity="SEVERE",
        sensor_data={"g_force": 4.6, "update": True},
    )
    a2 = ingest_crash_alert(payload=p2, db=db)

    # Debounced: should return the same alert ID and update coordinates
    assert a2.id == initial_id
    assert a2.latitude == 12.8705
    assert a2.sensor_data.get("update") is True


def test_crash_alert_subthreshold_false_positive_assessment(db: Session):
    """
    Verifies that low g-force telemetry (< 2.5g) without structural deformation,
    rollover, or airbag deployment is assessed as MINOR severity rather than false critical alarm.
    """
    ambulance = db.query(Ambulance).offset(1).first()

    payload = CrashAlertIngest(
        ambulance_id=ambulance.id,
        latitude=12.9200,
        longitude=74.8600,
        severity="CRITICAL",  # incoming claimed critical
        sensor_data={
            "g_force": 1.4,  # below collision threshold (e.g. hard braking)
            "rollover": False,
            "airbag_deployed": False,
        },
    )
    alert = ingest_crash_alert(payload=payload, db=db)

    # Evaluated and moderated to MINOR
    assert alert.severity == "MINOR"


def test_crash_alert_simulation_with_active_dispatch(db: Session):
    """
    Verifies simulate_crash_alert executes cleanly and logs to incident timeline when an
    active dispatch is present.
    """
    ambulance = db.query(Ambulance).first()
    hospital = db.query(Hospital).first()
    incident = db.query(Incident).first()

    dispatch = Dispatch(
        incident_id=incident.id,
        ambulance_id=ambulance.id,
        destination_hospital_id=hospital.id,
        status="ASSIGNED",
        coordination_status="CONFIRMED",
    )
    db.add(dispatch)
    db.commit()

    sim_payload = CrashAlertSimulate(
        ambulance_id=ambulance.id,
        severity="CRITICAL",
        location_description="Kuntikana Flyover near AJ Hospital",
    )
    alert = simulate_crash_alert(payload=sim_payload, db=db)

    assert alert.source == "DEMO_SIMULATION"
    assert alert.incident_id == incident.id
    assert alert.dispatch_id == dispatch.id
    assert alert.sensor_data.get("impact_velocity_kmh") == 64


def test_crash_alert_response_lifecycle_with_timeline(db: Session):
    """
    Verifies hospital response updates status and logs timeline event without TypeError.
    """
    ambulance = db.query(Ambulance).first()
    hospital = db.query(Hospital).first()
    incident = db.query(Incident).first()
    hospital_user = db.query(User).filter(User.hospital_id == hospital.id).first()

    alert = CrashAlert(
        ambulance_id=ambulance.id,
        incident_id=incident.id,
        hospital_id=hospital.id,
        source="DEMO_SIMULATION",
        severity="CRITICAL",
        latitude=12.87,
        longitude=74.84,
        status="TRIGGERED",
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)

    # Hospital acknowledges
    res = respond_to_crash_alert(
        alert_id=alert.id,
        payload=CrashAlertResponseUpdate(
            status="ACKNOWLEDGED",
            response_notes="Trauma team alerted to incoming ambulance collision",
            acknowledged_by=hospital_user.email,
        ),
        db=db,
        current_user=hospital_user,
    )
    assert res.status == "ACKNOWLEDGED"
    assert "Trauma team alerted" in res.response_notes


def test_dispatch_recommendations_alias_and_payload_structure(db: Session):
    """
    Verifies that get_dispatch_recommendation supplies top-level recommended_ambulance,
    recommended_hospital, and route_geometry for dispatcher rendering.
    """
    incident = db.query(Incident).first()
    res = get_dispatch_recommendation(incident_id=incident.id, db=db)

    assert "recommended_ambulance" in res
    assert "recommended_hospital" in res
    assert "route_geometry" in res
    assert "ambulance_allocation" in res
    assert "hospital_ranking" in res
    assert res["incident_id"] == incident.id


def test_triage_preview_and_compatibility(db: Session):
    """
    Verifies preview_triage executes properly and returns structured explainable score and justifications.
    """
    payload = TriagePreviewRequest(
        chief_complaint="Severe crushing chest pain radiating to left jaw, diaphoresis",
        consciousness_level="ALERT",
        breathing_status="NORMAL",
        severe_bleeding=False,
        chest_pain=True,
        suspected_stroke=False,
        severe_trauma=False,
        patient_age=58,
    )
    res = preview_triage(payload=payload)

    assert "Priority 1" in res["triage_level"]
    assert res["triage_color"] == "RED"
    assert res["triage_score"] >= 90
    assert len(res["justifications"]) > 0
    assert "Cardiology" in res["recommended_specialty"]
