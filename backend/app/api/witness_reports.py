from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.models.entities import Incident, WitnessReport
from backend.app.schemas.witness_report import (
    WitnessReportCreate,
    WitnessReportOut,
    WitnessReportLinkRequest,
    WitnessReportMarkDistinctRequest,
)
from backend.app.services.duplicate_detection_engine import find_best_incident_match
from backend.app.services.triage_engine import assess_incident_severity
from backend.app.services.timeline_service import log_incident_event
from backend.app.core.ws import broadcast_sync
from backend.app.core.auth import ROLE_DISPATCHER, ROLE_SUPER_ADMIN

router = APIRouter(prefix="/api/witness-reports", tags=["witness-reports"])

def get_utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)

@router.post("", response_model=WitnessReportOut, status_code=status.HTTP_201_CREATED)
def create_witness_report(payload: WitnessReportCreate, db: Session = Depends(get_db)):
    """
    FEATURE 4 — MULTI-WITNESS INCIDENT DETECTION:
    Ingests an eyewitness report and evaluates similarity against active incidents.
    Does NOT automatically merge incidents; flags as POSSIBLE_DUPLICATE for dispatcher review.
    """
    now = get_utc_now()
    rep_time = payload.reported_at or now
    if rep_time.tzinfo:
        rep_time = rep_time.replace(tzinfo=None)

    # Fetch candidate incidents: prioritize active incidents, fallback to all recent
    active_incidents = db.query(Incident).filter(
        Incident.status.notin_(["RESOLVED", "CANCELLED"])
    ).all()
    if not active_incidents:
        active_incidents = db.query(Incident).order_by(Incident.created_at.desc()).limit(10).all()

    # Evaluate duplicates deterministically
    best_match = find_best_incident_match(
        report_lat=payload.latitude,
        report_lon=payload.longitude,
        report_time=rep_time,
        report_type=payload.incident_type,
        report_desc=payload.incident_description,
        active_incidents=active_incidents,
    )

    matching_inc_id = None
    dup_prob = None
    dist_m = None
    time_s = None
    explanation = None
    review_status = "NEW"

    if best_match:
        matching_inc_id = best_match["incident_id"]
        dup_prob = best_match["composite_score"]
        dist_m = best_match["distance_meters"]
        time_s = best_match["time_difference_seconds"]
        explanation = best_match["explanation"]
        if best_match["is_possible_duplicate"]:
            review_status = "POSSIBLE_DUPLICATE"

    initial_audit = [{
        "action": "INGESTED",
        "timestamp": now.isoformat(),
        "review_status": review_status,
        "matching_incident_id": matching_inc_id,
        "score": dup_prob,
    }]

    report = WitnessReport(
        reporter_identifier=payload.reporter_identifier,
        incident_description=payload.incident_description,
        incident_type=payload.incident_type,
        latitude=payload.latitude,
        longitude=payload.longitude,
        reported_at=rep_time,
        matching_incident_id=matching_inc_id,
        duplicate_probability=dup_prob,
        matching_distance_meters=dist_m,
        matching_time_difference_seconds=time_s,
        matching_explanation=explanation,
        review_status=review_status,
        created_at=now,
        updated_at=now,
    )
    report.audit_trail = initial_audit

    db.add(report)
    db.commit()
    db.refresh(report)

    # Broadcast real-time events
    broadcast_sync(
        "WITNESS_REPORT_CREATED",
        {
            "report_id": report.id,
            "reporter": report.reporter_identifier,
            "review_status": report.review_status,
            "matching_incident_id": report.matching_incident_id,
            "duplicate_probability": report.duplicate_probability,
        },
        target_roles=[ROLE_DISPATCHER, ROLE_SUPER_ADMIN],
        entity_type="witness_report",
        entity_id=report.id,
    )

    if report.review_status == "POSSIBLE_DUPLICATE":
        broadcast_sync(
            "POSSIBLE_DUPLICATE_DETECTED",
            {
                "report_id": report.id,
                "matching_incident_id": report.matching_incident_id,
                "duplicate_probability": report.duplicate_probability,
                "distance_meters": report.matching_distance_meters,
                "time_difference_seconds": report.matching_time_difference_seconds,
                "explanation": report.matching_explanation,
            },
            target_roles=[ROLE_DISPATCHER, ROLE_SUPER_ADMIN],
            entity_type="witness_report",
            entity_id=report.id,
        )

    if report.matching_incident_id:
        log_incident_event(
            db=db,
            incident_id=report.matching_incident_id,
            event_type="WITNESS_REPORT_RECEIVED",
            event_title="Eyewitness Report Ingested",
            event_description=f"Eyewitness report from {report.reporter_identifier}: '{report.incident_description}'.",
            actor_type="WITNESS",
            actor_reference=report.reporter_identifier,
            metadata={"report_id": report.id, "duplicate_probability": report.duplicate_probability},
        )
        if report.review_status == "POSSIBLE_DUPLICATE":
            log_incident_event(
                db=db,
                incident_id=report.matching_incident_id,
                event_type="POSSIBLE_DUPLICATE_DETECTED",
                event_title="Possible Eyewitness Duplicate Correlated",
                event_description=f"Correlated with confidence {round((report.duplicate_probability or 0)*100)}%. {report.matching_explanation}",
                actor_type="SYSTEM",
                actor_reference="Duplicate Detection Engine",
                metadata={"report_id": report.id, "score": report.duplicate_probability},
            )

    return report

@router.get("", response_model=List[WitnessReportOut])
def list_witness_reports(
    review_status: Optional[str] = Query(None, description="Filter by status: NEW, POSSIBLE_DUPLICATE, CONFIRMED_DUPLICATE, DISTINCT"),
    incident_id: Optional[int] = Query(None, description="Filter by master incident ID"),
    db: Session = Depends(get_db),
):
    query = db.query(WitnessReport)
    if review_status and isinstance(review_status, str):
        query = query.filter(WitnessReport.review_status == review_status.upper().strip())
    if incident_id and isinstance(incident_id, int):
        query = query.filter(
            (WitnessReport.master_incident_id == incident_id) |
            (WitnessReport.matching_incident_id == incident_id)
        )
    return query.order_by(WitnessReport.created_at.desc()).all()

@router.get("/{report_id}", response_model=WitnessReportOut)
def get_witness_report(report_id: int, db: Session = Depends(get_db)):
    report = db.query(WitnessReport).filter(WitnessReport.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Witness report not found")
    return report

@router.post("/{report_id}/link", response_model=WitnessReportOut)
def link_witness_report(
    report_id: int,
    payload: Optional[WitnessReportLinkRequest] = None,
    db: Session = Depends(get_db),
):
    """
    FEATURE 4:
    Links a witness report to a master incident.
    - Preserves the original witness report record.
    - Sets review_status = CONFIRMED_DUPLICATE.
    - Does NOT trigger or duplicate ambulance dispatch.
    - Records an audit trail entry.
    """
    report = db.query(WitnessReport).filter(WitnessReport.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Witness report not found")

    target_inc_id = (payload and payload.master_incident_id) or report.matching_incident_id
    if not target_inc_id:
        raise HTTPException(
            status_code=400,
            detail="Cannot link: no target master incident ID provided or inferred from match."
        )

    master_inc = db.query(Incident).filter(Incident.id == target_inc_id).first()
    if not master_inc:
        raise HTTPException(status_code=404, detail=f"Master incident #{target_inc_id} not found")

    now = get_utc_now()
    report.master_incident_id = master_inc.id
    report.review_status = "CONFIRMED_DUPLICATE"
    report.updated_at = now

    audit = list(report.audit_trail or [])
    audit.append({
        "action": "LINKED_AS_DUPLICATE",
        "master_incident_id": master_inc.id,
        "timestamp": now.isoformat(),
        "notes": (payload and payload.notes) or "Dispatcher confirmed eyewitness duplicate of master incident.",
    })
    report.audit_trail = audit

    db.commit()
    db.refresh(report)

    broadcast_sync(
        "WITNESS_REPORT_LINKED",
        {
            "report_id": report.id,
            "master_incident_id": master_inc.id,
            "reporter": report.reporter_identifier,
            "review_status": report.review_status,
        },
        target_roles=[ROLE_DISPATCHER, ROLE_SUPER_ADMIN],
        entity_type="witness_report",
        entity_id=report.id,
    )

    log_incident_event(
        db=db,
        incident_id=master_inc.id,
        event_type="WITNESS_REPORT_LINKED",
        event_title="Eyewitness Duplicate Linked",
        event_description=f"Eyewitness report #{report.id} ({report.reporter_identifier}) confirmed by operator and linked to master emergency.",
        actor_type="DISPATCHER",
        actor_reference="Emergency Coordinator",
        metadata={"report_id": report.id, "master_incident_id": master_inc.id},
    )

    return report

@router.post("/{report_id}/mark-distinct", response_model=WitnessReportOut)
def mark_witness_report_distinct(
    report_id: int,
    payload: Optional[WitnessReportMarkDistinctRequest] = None,
    db: Session = Depends(get_db),
):
    """
    FEATURE 4:
    Marks a witness report as a DISTINCT real-world incident.
    If promote_to_incident is true, spawns a fresh independent Incident.
    """
    report = db.query(WitnessReport).filter(WitnessReport.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Witness report not found")

    now = get_utc_now()
    report.review_status = "DISTINCT"
    report.master_incident_id = None
    report.updated_at = now

    promoted_inc_id = None
    if payload and payload.promote_to_incident:
        # Triage and spawn distinct emergency incident
        triage_out = assess_incident_severity(
            chief_complaint=report.incident_description,
            consciousness_level="Alert",
            breathing_status="Normal",
        )
        new_inc = Incident(
            caller_name=report.reporter_identifier,
            caller_phone="Anonymous/Witness",
            location_address=f"Witness Report #{report.id} GPS ({round(report.latitude, 4)}, {round(report.longitude, 4)})",
            latitude=report.latitude,
            longitude=report.longitude,
            chief_complaint=report.incident_description,
            triage_level=triage_out.triage_level,
            triage_color=triage_out.triage_color,
            triage_score=triage_out.triage_score,
            required_ambulance_type=triage_out.required_ambulance_type,
            status="TRIAGED",
            created_at=now,
            updated_at=now,
        )
        new_inc.triage_justifications = triage_out.justifications
        db.add(new_inc)
        db.commit()
        db.refresh(new_inc)

        report.master_incident_id = new_inc.id
        promoted_inc_id = new_inc.id

        broadcast_sync(
            "INCIDENT_CREATED",
            {
                "incident_id": new_inc.id,
                "chief_complaint": new_inc.chief_complaint,
                "triage_color": new_inc.triage_color,
                "status": new_inc.status,
            },
            target_roles=[ROLE_DISPATCHER, ROLE_SUPER_ADMIN],
            entity_type="incident",
            entity_id=new_inc.id,
        )

    audit = list(report.audit_trail or [])
    audit.append({
        "action": "MARKED_DISTINCT",
        "timestamp": now.isoformat(),
        "notes": (payload and payload.notes) or "Dispatcher verified report as an independent incident.",
        "promoted_incident_id": promoted_inc_id,
    })
    report.audit_trail = audit

    db.commit()
    db.refresh(report)

    broadcast_sync(
        "WITNESS_REPORT_REVIEWED",
        {
            "report_id": report.id,
            "review_status": report.review_status,
            "promoted_incident_id": promoted_inc_id,
        },
        target_roles=[ROLE_DISPATCHER, ROLE_SUPER_ADMIN],
        entity_type="witness_report",
        entity_id=report.id,
    )

    if promoted_inc_id:
        log_incident_event(
            db=db,
            incident_id=promoted_inc_id,
            event_type="WITNESS_REPORT_DISTINCT",
            event_title="Independent Emergency Spawned",
            event_description=f"Eyewitness report #{report.id} verified as distinct and promoted to independent emergency case.",
            actor_type="DISPATCHER",
            actor_reference="Emergency Coordinator",
            metadata={"report_id": report.id},
        )

    return report
