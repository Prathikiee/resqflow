from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.models.entities import Incident
from backend.app.schemas.incident import (
    IncidentCreate,
    IncidentOut,
    TriagePreviewRequest,
    TriageAssessmentOut,
)
from backend.app.schemas.dispatch import IncidentStatusUpdate
from backend.app.services.triage_engine import assess_incident_severity
from backend.app.core.ws import broadcast_sync

router = APIRouter(prefix="/api/incidents", tags=["incidents"])

@router.post("/triage-preview", response_model=TriageAssessmentOut)
def preview_triage(payload: TriagePreviewRequest):
    """
    Simulates explainable clinical triage without creating an incident record.
    """
    result = assess_incident_severity(
        chief_complaint=payload.chief_complaint,
        consciousness_level=payload.consciousness_level,
        breathing_status=payload.breathing_status,
        severe_bleeding=payload.severe_bleeding,
        chest_pain=payload.chest_pain,
        suspected_stroke=payload.suspected_stroke,
        severe_trauma=payload.severe_trauma,
        patient_age=payload.patient_age,
    )
    return result.to_dict()

@router.post("", response_model=IncidentOut, status_code=status.HTTP_201_CREATED)
def create_incident(payload: IncidentCreate, db: Session = Depends(get_db)):
    """
    Emergency Registration & Triage:
    Registers incoming incident, executes transparent rule-based triage,
    attaches clinical justification tags, and persists to database.
    """
    triage = assess_incident_severity(
        chief_complaint=payload.chief_complaint,
        consciousness_level=payload.consciousness_level,
        breathing_status=payload.breathing_status,
        severe_bleeding=payload.severe_bleeding,
        chest_pain=payload.chest_pain,
        suspected_stroke=payload.suspected_stroke,
        severe_trauma=payload.severe_trauma,
        patient_age=payload.patient_age,
    )

    incident = Incident(
        caller_name=payload.caller_name,
        caller_phone=payload.caller_phone,
        location_address=payload.location_address,
        latitude=payload.latitude,
        longitude=payload.longitude,
        chief_complaint=payload.chief_complaint,
        patient_age=payload.patient_age,
        patient_gender=payload.patient_gender,
        consciousness_level=payload.consciousness_level,
        breathing_status=payload.breathing_status,
        severe_bleeding=payload.severe_bleeding,
        chest_pain=payload.chest_pain,
        suspected_stroke=payload.suspected_stroke,
        severe_trauma=payload.severe_trauma,
        triage_level=triage.triage_level,
        triage_color=triage.triage_color,
        triage_score=triage.triage_score,
        required_ambulance_type=triage.required_ambulance_type,
        status="TRIAGED",
    )
    incident.triage_justifications = triage.justifications

    db.add(incident)
    db.commit()
    db.refresh(incident)

    broadcast_sync("INCIDENT_CREATED", {
        "incident_id": incident.id,
        "caller_name": incident.caller_name,
        "triage_level": incident.triage_level,
        "triage_color": incident.triage_color,
        "status": incident.status,
    })

    return incident

@router.get("", response_model=List[IncidentOut])
def list_incidents(db: Session = Depends(get_db)):
    """
    Returns all registered emergency incidents, ordered by priority score and recency.
    """
    return db.query(Incident).order_by(Incident.triage_score.desc(), Incident.created_at.desc()).all()

@router.get("/{incident_id}", response_model=IncidentOut)
def get_incident(incident_id: int, db: Session = Depends(get_db)):
    incident = db.query(Incident).filter(Incident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Emergency incident not found")
    return incident

@router.patch("/{incident_id}/status", response_model=IncidentOut)
def update_incident_status(incident_id: int, payload: IncidentStatusUpdate, db: Session = Depends(get_db)):
    incident = db.query(Incident).filter(Incident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Emergency incident not found")

    valid_statuses = [
        "REPORTED", "TRIAGED", "ALLOCATED", "DISPATCHED",
        "EN_ROUTE", "ON_SCENE", "TRANSPORTING", "AT_HOSPITAL", "RESOLVED", "CANCELLED"
    ]
    new_status = payload.status.upper().strip()
    if new_status not in valid_statuses:
        raise HTTPException(status_code=400, detail=f"Invalid status '{payload.status}'. Valid: {valid_statuses}")

    incident.status = new_status
    db.commit()
    db.refresh(incident)

    broadcast_sync("INCIDENT_STATUS_UPDATED", {
        "incident_id": incident.id,
        "status": incident.status,
    })

    return incident
