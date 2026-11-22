from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.models.entities import Incident, IncidentEvent, User, Dispatch, Ambulance, Hospital
from backend.app.schemas.incident import (
    IncidentCreate,
    IncidentOut,
    IncidentEventOut,
    TriagePreviewRequest,
    TriageAssessmentOut,
)
from backend.app.schemas.dispatch import (
    IncidentStatusUpdate,
    IncidentCancelRequest,
    IncidentCloseRequest,
)
from backend.app.services.triage_engine import assess_incident_severity
from backend.app.services.timeline_service import log_incident_event
from backend.app.core.ws import broadcast_sync
from backend.app.core.auth import (
    get_optional_current_user,
    ROLE_CITIZEN,
    ROLE_DISPATCHER,
    ROLE_SUPER_ADMIN,
    ROLE_AMBULANCE_CREW,
    ROLE_HOSPITAL_STAFF,
)

router = APIRouter(prefix="/api/incidents", tags=["incidents"])

def begin_immediate_if_sqlite(db: Session):
    try:
        if db.get_bind().dialect.name != "postgresql":
            db.execute(text("BEGIN IMMEDIATE"))
    except Exception:
        pass

def release_incident_resources(
    incident: Incident,
    db: Session,
    reason: str = "Incident cancelled",
    is_resolved: bool = False,
):
    """
    Safely and idempotently releases provisional reservations on both ambulance
    units and hospital emergency beds associated with active dispatches for this incident.
    """
    active_dispatches = db.query(Dispatch).filter(
        Dispatch.incident_id == incident.id,
        Dispatch.status.notin_(["COMPLETED", "CANCELLED"]),
    ).all()

    for disp in active_dispatches:
        disp.status = "COMPLETED" if is_resolved else "CANCELLED"
        if not is_resolved:
            disp.coordination_status = "CANCELLED"
            disp.rejection_source = "CANCELLED"
            disp.rejection_reason = reason
        elif disp.coordination_status == "PENDING_CONFIRMATIONS":
            disp.coordination_status = "CONFIRMED"

        if disp.ambulance_id:
            amb = db.query(Ambulance).filter(Ambulance.id == disp.ambulance_id).first()
            if amb:
                amb.status = "AVAILABLE"
                amb.reservation_dispatch_id = None

        if disp.destination_hospital_id:
            hosp = db.query(Hospital).filter(Hospital.id == disp.destination_hospital_id).first()
            if hosp and (hosp.reserved_emergency_beds or 0) > 0:
                hosp.reserved_emergency_beds = max(0, hosp.reserved_emergency_beds - 1)

        broadcast_sync(
            "DISPATCH_CONFIRMATION_UPDATED",
            {
                "dispatch_id": disp.id,
                "incident_id": disp.incident_id,
                "ambulance_id": disp.ambulance_id,
                "destination_hospital_id": disp.destination_hospital_id,
                "status": disp.status,
                "coordination_status": disp.coordination_status,
                "rejection_reason": disp.rejection_reason,
            },
            ambulance_id=disp.ambulance_id,
            hospital_id=disp.destination_hospital_id,
            reporter_user_id=incident.reporter_user_id,
            entity_type="dispatch",
            entity_id=disp.id,
        )

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
def create_incident(
    payload: IncidentCreate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Emergency Registration & Triage:
    Registers incoming incident, executes transparent rule-based triage,
    attaches clinical justification tags, and persists to database.
    """
    auth_user = current_user if isinstance(current_user, User) else None

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
        reporter_user_id=auth_user.id if auth_user else None,
    )
    incident.triage_justifications = triage.justifications

    db.add(incident)
    db.commit()
    db.refresh(incident)

    # FEATURE 5 — Log incident registration and triage events
    log_incident_event(
        db=db,
        incident_id=incident.id,
        event_type="EMERGENCY_REGISTERED",
        event_title="Emergency Incident Reported",
        event_description=f"Reported by {incident.caller_name}: '{incident.chief_complaint}' at {incident.location_address}.",
        actor_type="CALLER",
        actor_reference=incident.caller_name,
        metadata={
            "caller_name": incident.caller_name,
            "location_address": incident.location_address,
            "coordinates": [incident.latitude, incident.longitude],
        },
    )
    log_incident_event(
        db=db,
        incident_id=incident.id,
        event_type="TRIAGE_COMPLETED",
        event_title=f"Clinical Triage: {incident.triage_level}",
        event_description=f"Rule-based triage assigned score {incident.triage_score}/100 ({incident.triage_color}). Required tier: {incident.required_ambulance_type}.",
        actor_type="SYSTEM",
        actor_reference="Rule-Based Triage Engine",
        metadata={
            "triage_level": incident.triage_level,
            "triage_color": incident.triage_color,
            "triage_score": incident.triage_score,
            "required_ambulance_type": incident.required_ambulance_type,
            "justifications": incident.triage_justifications,
        },
    )

    broadcast_sync(
        "INCIDENT_CREATED",
        {
            "incident_id": incident.id,
            "caller_name": incident.caller_name,
            "triage_level": incident.triage_level,
            "triage_color": incident.triage_color,
            "status": incident.status,
            "reporter_user_id": incident.reporter_user_id,
            "chief_complaint": incident.chief_complaint,
            "location_address": incident.location_address,
        },
        reporter_user_id=incident.reporter_user_id,
        target_roles=[ROLE_DISPATCHER, ROLE_SUPER_ADMIN],
        entity_type="incident",
        entity_id=incident.id,
    )

    return incident

@router.get("", response_model=List[IncidentOut])
def list_incidents(
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Returns registered emergency incidents.
    Role-based filtering:
      - CITIZEN: Only sees incidents they personally reported.
      - DISPATCHER / SUPER_ADMIN / CREW / HOSPITAL: Regional emergency list.
    """
    query = db.query(Incident)
    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            query = query.filter(Incident.reporter_user_id == auth_user.id)
        elif auth_user.role == ROLE_HOSPITAL_STAFF:
            if not auth_user.hospital_id:
                return []
            query = query.join(Dispatch, Dispatch.incident_id == Incident.id).filter(
                Dispatch.destination_hospital_id == auth_user.hospital_id
            ).distinct()

    return query.order_by(Incident.triage_score.desc(), Incident.created_at.desc()).all()

@router.get("/{incident_id}", response_model=IncidentOut)
def get_incident(
    incident_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    incident = db.query(Incident).filter(Incident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Emergency incident not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            if incident.reporter_user_id != auth_user.id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Access denied: Citizens can only inspect their own reported emergency incidents",
                )
        elif auth_user.role == ROLE_HOSPITAL_STAFF:
            if not auth_user.hospital_id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Access denied: Hospital staff not assigned to a facility",
                )
            has_dispatch = db.query(Dispatch).filter(
                Dispatch.incident_id == incident.id,
                Dispatch.destination_hospital_id == auth_user.hospital_id,
            ).first()
            if not has_dispatch:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Access denied: Incident is not allocated to your hospital facility",
                )

    return incident

@router.patch("/{incident_id}/status", response_model=IncidentOut)
def update_incident_status(
    incident_id: int,
    payload: IncidentStatusUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    begin_immediate_if_sqlite(db)
    incident = db.query(Incident).filter(Incident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Emergency incident not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user and auth_user.role == ROLE_CITIZEN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Citizens cannot modify incident lifecycle status directly. Use /cancel endpoint.",
        )

    valid_statuses = [
        "REPORTED", "TRIAGED", "ALLOCATED", "DISPATCHED",
        "EN_ROUTE", "ON_SCENE", "TRANSPORTING", "AT_HOSPITAL", "RESOLVED", "CLOSED", "CANCELLED"
    ]
    new_status = payload.status.upper().strip()
    if new_status not in valid_statuses:
        raise HTTPException(status_code=400, detail=f"Invalid status '{payload.status}'. Valid: {valid_statuses}")

    # Validate lifecycle transition rules
    if new_status == "CLOSED" and incident.status != "RESOLVED":
        raise HTTPException(
            status_code=400,
            detail=f"Cannot transition Incident #{incident.id} to 'CLOSED': Previous status must be 'RESOLVED' (current: '{incident.status}').",
        )
    if new_status == "CANCELLED" and incident.status in ["RESOLVED", "CLOSED"]:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot cancel Incident #{incident.id}: Incident is already in terminal stage '{incident.status}'.",
        )

    previous_status = incident.status
    incident.status = new_status

    if new_status in ["RESOLVED", "CANCELLED"]:
        release_incident_resources(
            incident=incident,
            db=db,
            reason="Incident status transitioned to " + new_status,
            is_resolved=(new_status == "RESOLVED"),
        )

    log_incident_event(
        db=db,
        incident_id=incident.id,
        event_type="INCIDENT_STATUS_CHANGED" if new_status != "CLOSED" else "INCIDENT_CLOSED",
        event_title=f"Incident Status: {incident.status}",
        event_description=f"Incident status changed to '{incident.status}'. Previous: '{previous_status}'.",
        actor_type="DISPATCHER" if auth_user and auth_user.role in [ROLE_DISPATCHER, ROLE_SUPER_ADMIN] else "SYSTEM",
        actor_reference=auth_user.full_name if auth_user else "Operations Desk",
        metadata={"status": incident.status, "previous_status": previous_status},
        commit=False,
    )

    db.commit()
    db.refresh(incident)

    broadcast_sync(
        "INCIDENT_STATUS_UPDATED",
        {
            "incident_id": incident.id,
            "status": incident.status,
            "previous_status": previous_status,
            "reporter_user_id": incident.reporter_user_id,
        },
        reporter_user_id=incident.reporter_user_id,
        target_roles=[ROLE_DISPATCHER, ROLE_SUPER_ADMIN],
        entity_type="incident",
        entity_id=incident.id,
    )

    return incident

@router.post("/{incident_id}/cancel", response_model=IncidentOut)
def cancel_incident(
    incident_id: int,
    payload: Optional[IncidentCancelRequest] = None,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    FEATURE: Emergency Cancellation Workflow
    Cancels an active emergency incident, atomically releasing all provisionally
    reserved fleet and hospital bed resources.
    """
    begin_immediate_if_sqlite(db)
    incident = db.query(Incident).filter(Incident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Emergency incident not found")

    auth_user = current_user if isinstance(current_user, User) else None

    # Role validation
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            if incident.reporter_user_id and incident.reporter_user_id != auth_user.id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Access denied: Citizens can only cancel their own emergency requests.",
                )
        elif auth_user.role in [ROLE_AMBULANCE_CREW, ROLE_HOSPITAL_STAFF]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Access denied: Role '{auth_user.role}' cannot cancel civilian emergency incidents.",
            )

    # Idempotent return if already cancelled
    if incident.status == "CANCELLED":
        return incident

    # Terminal stage check: cannot cancel already resolved/closed incident
    if incident.status in ["RESOLVED", "CLOSED"]:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot cancel Incident #{incident.id}: Incident is already in terminal stage '{incident.status}'.",
        )

    cancel_reason = payload.reason if payload and payload.reason else "Emergency request cancelled by citizen/dispatcher."
    previous_status = incident.status
    incident.status = "CANCELLED"

    release_incident_resources(incident=incident, db=db, reason=cancel_reason, is_resolved=False)

    actor_type = "CITIZEN" if auth_user and auth_user.role == ROLE_CITIZEN else ("DISPATCHER" if auth_user and auth_user.role in [ROLE_DISPATCHER, ROLE_SUPER_ADMIN] else "SYSTEM")
    actor_ref = auth_user.full_name if auth_user else "Reporting Citizen"

    log_incident_event(
        db=db,
        incident_id=incident.id,
        event_type="INCIDENT_CANCELLED",
        event_title="Emergency Request Cancelled",
        event_description=f"Incident cancelled. Reason: {cancel_reason}. All associated fleet and bed reservations released.",
        actor_type=actor_type,
        actor_reference=actor_ref,
        metadata={"reason": cancel_reason, "previous_status": previous_status},
        commit=False,
    )

    db.commit()
    db.refresh(incident)

    broadcast_sync(
        "INCIDENT_CANCELLED",
        {
            "incident_id": incident.id,
            "status": incident.status,
            "reason": cancel_reason,
            "reporter_user_id": incident.reporter_user_id,
        },
        reporter_user_id=incident.reporter_user_id,
        target_roles=[ROLE_DISPATCHER, ROLE_SUPER_ADMIN],
        entity_type="incident",
        entity_id=incident.id,
    )
    broadcast_sync(
        "INCIDENT_STATUS_UPDATED",
        {
            "incident_id": incident.id,
            "status": incident.status,
            "reporter_user_id": incident.reporter_user_id,
        },
        reporter_user_id=incident.reporter_user_id,
        target_roles=[ROLE_DISPATCHER, ROLE_SUPER_ADMIN],
        entity_type="incident",
        entity_id=incident.id,
    )

    return incident

@router.post("/{incident_id}/close", response_model=IncidentOut)
def close_incident(
    incident_id: int,
    payload: Optional[IncidentCloseRequest] = None,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    FEATURE: Incident Lifecycle Formal Closure
    Formally closes and archives an incident that has reached RESOLVED stage.
    """
    begin_immediate_if_sqlite(db)
    incident = db.query(Incident).filter(Incident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Emergency incident not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user and auth_user.role not in [ROLE_DISPATCHER, ROLE_SUPER_ADMIN]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access denied: Role '{auth_user.role}' cannot formally close emergency incidents. Only dispatchers and administrators are authorized.",
        )

    # Idempotent return if already closed
    if incident.status == "CLOSED":
        return incident

    if incident.status != "RESOLVED":
        raise HTTPException(
            status_code=400,
            detail=f"Cannot close Incident #{incident.id}: Incident is currently '{incident.status}'. Only incidents in 'RESOLVED' stage can be formally closed and archived.",
        )

    incident.status = "CLOSED"
    notes = payload.resolution_notes if payload and payload.resolution_notes else "Incident review complete. Case archived."

    log_incident_event(
        db=db,
        incident_id=incident.id,
        event_type="INCIDENT_CLOSED",
        event_title="Emergency Incident Formally Closed",
        event_description=f"Incident marked CLOSED. {notes}",
        actor_type="DISPATCHER" if auth_user and auth_user.role in [ROLE_DISPATCHER, ROLE_SUPER_ADMIN] else "SYSTEM",
        actor_reference=auth_user.full_name if auth_user else "Emergency Coordinator",
        metadata={"resolution_notes": notes},
        commit=False,
    )

    db.commit()
    db.refresh(incident)

    broadcast_sync(
        "INCIDENT_CLOSED",
        {
            "incident_id": incident.id,
            "status": "CLOSED",
            "notes": notes,
        },
        target_roles=[ROLE_DISPATCHER, ROLE_SUPER_ADMIN],
        entity_type="incident",
        entity_id=incident.id,
    )
    broadcast_sync(
        "INCIDENT_STATUS_UPDATED",
        {
            "incident_id": incident.id,
            "status": "CLOSED",
        },
        target_roles=[ROLE_DISPATCHER, ROLE_SUPER_ADMIN],
        entity_type="incident",
        entity_id=incident.id,
    )

    return incident

@router.get("/{incident_id}/timeline", response_model=List[IncidentEventOut])
def get_incident_timeline(
    incident_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    FEATURE 5 — UNIFIED EMERGENCY COORDINATION TIMELINE:
    Returns the complete persistent chronological history for the incident.
    """
    incident = db.query(Incident).filter(Incident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user and auth_user.role == ROLE_CITIZEN:
        if incident.reporter_user_id != auth_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: Citizens can only inspect timelines for their own reported incidents",
            )

    events = db.query(IncidentEvent).filter(
        IncidentEvent.incident_id == incident_id
    ).order_by(IncidentEvent.created_at.asc()).all()

    return events
