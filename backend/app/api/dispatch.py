from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.models.entities import Incident, Ambulance, Hospital, Dispatch
from backend.app.schemas.dispatch import (
    DispatchRequest,
    DispatchOut,
    ConfirmationDecision,
    SimulateDecisionRequest,
)
from backend.app.services.allocation_engine import score_and_rank_ambulances
from backend.app.services.hospital_engine import rank_suitable_hospitals
from backend.app.services.routing_service import calculate_route
from backend.app.core.ws import broadcast_sync

router = APIRouter(prefix="/api/dispatch", tags=["dispatch"])

def get_utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)

def is_postgres(db: Session) -> bool:
    try:
        return db.get_bind().dialect.name == "postgresql"
    except Exception:
        return False

def auto_escalate_dispatch(
    dispatch: Dispatch,
    failure_source: str,
    failure_reason: str,
    db: Session,
) -> Dispatch:
    """
    FEATURE 2 — SMART EMERGENCY ESCALATION:
    Automatically detects emergency coordination failures and reassigns an alternative resource:
      1. Releases previous provisional ambulance and hospital bed reservations.
      2. Excludes failed/rejected resources from the candidate pool across attempts.
      3. Uses existing allocation and hospital matching engines to select the next suitable unit.
      4. Creates a new provisional reservation with a fresh 90s confirmation TTL.
      5. Resets dual confirmation states to PENDING.
      6. Increments attempt_number and appends a detailed escalation audit record to history.
      7. If no alternative exists, marks REASSIGNMENT_REQUIRED and preserves incident.
      8. Broadcasts DISPATCH_ESCALATED and DISPATCH_CONFIRMATION_UPDATED events.
    """
    now = get_utc_now()
    incident = db.query(Incident).filter(Incident.id == dispatch.incident_id).first()

    # 1. Release previous reservations
    old_amb = db.query(Ambulance).filter(Ambulance.id == dispatch.ambulance_id).first()
    if old_amb and old_amb.status == "RESERVED" and old_amb.reservation_dispatch_id == dispatch.id:
        old_amb.status = "AVAILABLE"
        old_amb.reservation_dispatch_id = None

    old_hosp = None
    if dispatch.destination_hospital_id:
        old_hosp = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id).first()
        if old_hosp and (old_hosp.reserved_emergency_beds or 0) > 0 and dispatch.coordination_status != "CONFIRMED":
            old_hosp.reserved_emergency_beds = max(0, old_hosp.reserved_emergency_beds - 1)

    db.commit()

    # 2. Gather excluded resources across all attempts
    history = list(dispatch.escalation_history or [])
    failed_amb_ids = {dispatch.ambulance_id}
    failed_hosp_ids = set()
    if failure_source == "HOSPITAL" and dispatch.destination_hospital_id:
        failed_hosp_ids.add(dispatch.destination_hospital_id)

    for entry in history:
        if entry.get("failed_ambulance_id"):
            failed_amb_ids.add(entry["failed_ambulance_id"])
        if entry.get("failed_hospital_id") and entry.get("failure_source") == "HOSPITAL":
            failed_hosp_ids.add(entry["failed_hospital_id"])

    # 3. Find candidate ambulances: AVAILABLE and not in failed_amb_ids
    all_ambs = db.query(Ambulance).filter(
        Ambulance.id.notin_(failed_amb_ids),
        Ambulance.status == "AVAILABLE",
        Ambulance.is_active == True,
    ).all()

    if not all_ambs or not incident:
        # No alternative ambulances available
        history_entry = {
            "attempt_number": dispatch.attempt_number,
            "failed_ambulance_id": dispatch.ambulance_id,
            "failed_ambulance_call_sign": old_amb.call_sign if old_amb else f"ID #{dispatch.ambulance_id}",
            "failed_hospital_id": dispatch.destination_hospital_id,
            "failed_hospital_name": old_hosp.name if old_hosp else None,
            "failure_source": failure_source,
            "failure_reason": failure_reason,
            "timestamp": now.isoformat(),
            "replacement_ambulance_id": None,
            "replacement_ambulance_call_sign": None,
            "replacement_hospital_id": None,
            "replacement_hospital_name": None,
            "escalation_result": "REASSIGNMENT_REQUIRED_NO_ALTERNATIVES",
        }
        history.append(history_entry)
        dispatch.escalation_history = history
        dispatch.coordination_status = "REASSIGNMENT_REQUIRED"
        dispatch.rejection_source = failure_source
        dispatch.rejection_reason = failure_reason
        if incident and incident.status == "ALLOCATED":
            incident.status = "TRIAGED"
        db.commit()
        db.refresh(dispatch)

        broadcast_sync("DISPATCH_ESCALATION_FAILED", {
            "dispatch_id": dispatch.id,
            "incident_id": dispatch.incident_id,
            "failure_source": failure_source,
            "reason": failure_reason,
        })
        broadcast_sync("DISPATCH_CONFIRMATION_UPDATED", {
            "dispatch_id": dispatch.id,
            "coordination_status": dispatch.coordination_status,
            "ambulance_confirmation": dispatch.ambulance_confirmation_status,
            "hospital_confirmation": dispatch.hospital_confirmation_status,
        })
        return dispatch

    ranking = score_and_rank_ambulances(incident=incident, ambulances=all_ambs)
    if not ranking["ranked_ambulances"]:
        history_entry = {
            "attempt_number": dispatch.attempt_number,
            "failed_ambulance_id": dispatch.ambulance_id,
            "failed_ambulance_call_sign": old_amb.call_sign if old_amb else f"ID #{dispatch.ambulance_id}",
            "failed_hospital_id": dispatch.destination_hospital_id,
            "failed_hospital_name": old_hosp.name if old_hosp else None,
            "failure_source": failure_source,
            "failure_reason": failure_reason,
            "timestamp": now.isoformat(),
            "replacement_ambulance_id": None,
            "replacement_ambulance_call_sign": None,
            "replacement_hospital_id": None,
            "replacement_hospital_name": None,
            "escalation_result": "REASSIGNMENT_REQUIRED_CLINICAL_MISMATCH",
        }
        history.append(history_entry)
        dispatch.escalation_history = history
        dispatch.coordination_status = "REASSIGNMENT_REQUIRED"
        dispatch.rejection_source = failure_source
        dispatch.rejection_reason = failure_reason
        if incident and incident.status == "ALLOCATED":
            incident.status = "TRIAGED"
        db.commit()
        db.refresh(dispatch)
        return dispatch

    best_amb_cand = ranking["ranked_ambulances"][0]
    new_amb = db.query(Ambulance).filter(Ambulance.id == best_amb_cand["ambulance_id"]).first()

    # 4. Find candidate hospitals: unreserved capacity > 0 and accepting emergencies
    all_hosps = db.query(Hospital).filter(Hospital.accepting_emergencies == True).all()
    eligible_hosps = [
        h for h in all_hosps
        if (h.available_emergency_beds - (h.reserved_emergency_beds or 0)) > 0
        and (h.id not in failed_hosp_ids)
    ]

    new_hosp = None
    if eligible_hosps:
        hosp_ranking = rank_suitable_hospitals(incident=incident, hospitals=eligible_hosps)
        if hosp_ranking["ranked_hospitals"]:
            best_hosp_cand = hosp_ranking["ranked_hospitals"][0]
            new_hosp = db.query(Hospital).filter(Hospital.id == best_hosp_cand["hospital_id"]).first()
    elif dispatch.destination_hospital_id and dispatch.destination_hospital_id not in failed_hosp_ids:
        new_hosp = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id).first()

    # 5. Calculate new route
    route = calculate_route(
        start_lat=new_amb.current_latitude,
        start_lon=new_amb.current_longitude,
        dest_lat=incident.latitude,
        dest_lon=incident.longitude,
    )

    reservation_expires = now + timedelta(seconds=90)

    # 6. Reserve new resources
    new_amb.status = "RESERVED"
    new_amb.reservation_dispatch_id = dispatch.id
    if new_hosp:
        new_hosp.reserved_emergency_beds = (new_hosp.reserved_emergency_beds or 0) + 1

    # 7. Record escalation history entry
    history_entry = {
        "attempt_number": dispatch.attempt_number,
        "failed_ambulance_id": dispatch.ambulance_id,
        "failed_ambulance_call_sign": old_amb.call_sign if old_amb else f"ID #{dispatch.ambulance_id}",
        "failed_hospital_id": dispatch.destination_hospital_id,
        "failed_hospital_name": old_hosp.name if old_hosp else None,
        "failure_source": failure_source,
        "failure_reason": failure_reason,
        "timestamp": now.isoformat(),
        "replacement_ambulance_id": new_amb.id,
        "replacement_ambulance_call_sign": new_amb.call_sign,
        "replacement_hospital_id": new_hosp.id if new_hosp else None,
        "replacement_hospital_name": new_hosp.name if new_hosp else None,
        "escalation_result": "SUCCESSFULLY_ESCALATED",
    }
    history.append(history_entry)
    dispatch.escalation_history = history

    # 8. Reset confirmation states & update dispatch
    dispatch.attempt_number += 1
    dispatch.ambulance_id = new_amb.id
    dispatch.destination_hospital_id = new_hosp.id if new_hosp else None
    dispatch.status = "ASSIGNED"
    dispatch.coordination_status = "PENDING_CONFIRMATIONS"
    dispatch.ambulance_confirmation_status = "PENDING"
    dispatch.hospital_confirmation_status = "PENDING"
    dispatch.reservation_expires_at = reservation_expires
    dispatch.ambulance_confirmed_at = None
    dispatch.hospital_confirmed_at = None
    dispatch.confirmed_at = None
    dispatch.rejection_source = failure_source
    dispatch.rejection_reason = failure_reason
    dispatch.dispatched_at = now
    dispatch.estimated_eta_seconds = route["duration_seconds"]
    dispatch.route_distance_meters = route["distance_meters"]
    dispatch.allocation_score = best_amb_cand["total_score"]
    dispatch.allocation_breakdown = best_amb_cand["score_breakdown"]
    dispatch.route_geometry = route["geometry"]

    incident.status = "ALLOCATED"

    db.commit()
    db.refresh(dispatch)

    # 9. Broadcast live events
    broadcast_sync("DISPATCH_ESCALATED", {
        "dispatch_id": dispatch.id,
        "incident_id": incident.id,
        "attempt_number": dispatch.attempt_number,
        "new_ambulance_id": new_amb.id,
        "new_ambulance_call_sign": new_amb.call_sign,
        "previous_ambulance_call_sign": old_amb.call_sign if old_amb else None,
        "failure_source": failure_source,
        "failure_reason": failure_reason,
    })
    broadcast_sync("DISPATCH_CONFIRMATION_UPDATED", {
        "dispatch_id": dispatch.id,
        "coordination_status": dispatch.coordination_status,
        "ambulance_confirmation": dispatch.ambulance_confirmation_status,
        "hospital_confirmation": dispatch.hospital_confirmation_status,
        "reservation_expires_at": reservation_expires.isoformat(),
        "attempt_number": dispatch.attempt_number,
    })
    broadcast_sync("DISPATCH_REASSIGNED", {
        "dispatch_id": dispatch.id,
        "incident_id": incident.id,
        "new_ambulance_id": new_amb.id,
        "new_ambulance_call_sign": new_amb.call_sign,
        "attempt_number": dispatch.attempt_number,
    })

    return dispatch

def check_and_escalate_expired_dispatches(db: Session) -> List[int]:
    """
    Sweeps active dispatches in PENDING_CONFIRMATIONS whose reservation TTL has expired
    and automatically executes smart escalation.
    """
    now = get_utc_now()
    pending = db.query(Dispatch).filter(
        Dispatch.coordination_status == "PENDING_CONFIRMATIONS",
        Dispatch.reservation_expires_at.isnot(None),
        Dispatch.reservation_expires_at < now,
    ).all()

    escalated_ids = []
    for d in pending:
        auto_escalate_dispatch(
            dispatch=d,
            failure_source="TIMEOUT",
            failure_reason="Provisional reservation expired (90s confirmation TTL elapsed without dual acceptance).",
            db=db,
        )
        escalated_ids.append(d.id)
    return escalated_ids

def expire_single_dispatch_if_due(dispatch: Dispatch, db: Session) -> bool:
    """
    Checks if a dispatch in PENDING_CONFIRMATIONS has expired past its reservation TTL.
    If so, automatically triggers smart escalation.
    """
    if (
        dispatch.coordination_status == "PENDING_CONFIRMATIONS"
        and dispatch.reservation_expires_at
        and dispatch.reservation_expires_at < get_utc_now()
    ):
        auto_escalate_dispatch(
            dispatch=dispatch,
            failure_source="TIMEOUT",
            failure_reason="Provisional reservation expired (90s confirmation TTL elapsed without dual acceptance).",
            db=db,
        )
        return True
    return False

@router.get("/recommend/{incident_id}")
def get_dispatch_recommendation(incident_id: int, db: Session = Depends(get_db)):
    incident = db.query(Incident).filter(Incident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")

    ambulances = db.query(Ambulance).all()
    hospitals = db.query(Hospital).all()

    ambulance_results = score_and_rank_ambulances(incident=incident, ambulances=ambulances)
    hospital_results = rank_suitable_hospitals(incident=incident, hospitals=hospitals)

    return {
        "incident_id": incident.id,
        "incident_location": {
            "address": incident.location_address,
            "latitude": incident.latitude,
            "longitude": incident.longitude,
        },
        "triage": {
            "level": incident.triage_level,
            "color": incident.triage_color,
            "score": incident.triage_score,
            "required_ambulance_type": incident.required_ambulance_type,
            "justifications": incident.triage_justifications,
        },
        "ambulance_allocation": ambulance_results,
        "hospital_ranking": hospital_results,
    }

@router.post("", response_model=DispatchOut, status_code=status.HTTP_201_CREATED)
def create_dispatch(payload: DispatchRequest, db: Session = Depends(get_db)):
    if not is_postgres(db):
        try:
            db.execute(text("BEGIN IMMEDIATE"))
        except Exception:
            pass

    incident = db.query(Incident).filter(Incident.id == payload.incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")

    active_disp = db.query(Dispatch).filter(
        Dispatch.incident_id == incident.id,
        Dispatch.status.notin_(["COMPLETED", "CANCELLED"]),
        Dispatch.coordination_status.notin_(["REJECTED", "EXPIRED"]),
    ).first()
    if active_disp:
        raise HTTPException(
            status_code=400,
            detail=f"Incident #{incident.id} already has an active dispatch (#{active_disp.id} - status: {active_disp.status}). Duplicate dispatch rejected."
        )

    amb_query = db.query(Ambulance).filter(Ambulance.id == payload.ambulance_id)
    if is_postgres(db):
        amb_query = amb_query.with_for_update()
    ambulance = amb_query.first()

    if not ambulance:
        raise HTTPException(status_code=404, detail="Ambulance unit not found")

    if not ambulance.is_active:
        raise HTTPException(status_code=400, detail=f"Ambulance {ambulance.call_sign} is marked inactive.")

    if ambulance.status != "AVAILABLE":
        raise HTTPException(
            status_code=400,
            detail=f"Ambulance {ambulance.call_sign} is currently '{ambulance.status}' and cannot be dispatched."
        )

    hospital = None
    if payload.destination_hospital_id:
        hosp_query = db.query(Hospital).filter(Hospital.id == payload.destination_hospital_id)
        if is_postgres(db):
            hosp_query = hosp_query.with_for_update()
        hospital = hosp_query.first()

        if not hospital:
            raise HTTPException(status_code=404, detail="Hospital not found")

        if not hospital.accepting_emergencies:
            raise HTTPException(status_code=400, detail=f"Hospital {hospital.name} is currently not accepting emergency cases.")

        unreserved_beds = hospital.available_emergency_beds - (hospital.reserved_emergency_beds or 0)
        if unreserved_beds <= 0:
            raise HTTPException(
                status_code=409,
                detail=f"Hospital {hospital.name} has no remaining unreserved emergency bays (Available: {hospital.available_emergency_beds}, Reserved: {hospital.reserved_emergency_beds or 0})."
            )

    route = calculate_route(
        start_lat=ambulance.current_latitude,
        start_lon=ambulance.current_longitude,
        dest_lat=incident.latitude,
        dest_lon=incident.longitude,
    )

    all_ambs = db.query(Ambulance).all()
    scoring_result = score_and_rank_ambulances(incident=incident, ambulances=all_ambs)
    matched_candidate = next(
        (c for c in scoring_result["ranked_ambulances"] if c["ambulance_id"] == ambulance.id),
        None
    )

    now = get_utc_now()
    reservation_expires = now + timedelta(seconds=90)

    dispatch = Dispatch(
        incident_id=incident.id,
        ambulance_id=ambulance.id,
        destination_hospital_id=hospital.id if hospital else None,
        status="ASSIGNED",
        coordination_status="PENDING_CONFIRMATIONS",
        ambulance_confirmation_status="PENDING",
        hospital_confirmation_status="PENDING",
        reservation_expires_at=reservation_expires,
        attempt_number=1,
        dispatched_at=now,
        estimated_eta_seconds=route["duration_seconds"],
        route_distance_meters=route["distance_meters"],
        allocation_score=matched_candidate["total_score"] if matched_candidate else 75.0,
    )
    dispatch.allocation_breakdown = matched_candidate["score_breakdown"] if matched_candidate else {}
    dispatch.route_geometry = route["geometry"]
    dispatch.escalation_history = []

    ambulance.status = "RESERVED"
    if hospital:
        hospital.reserved_emergency_beds = (hospital.reserved_emergency_beds or 0) + 1

    incident.status = "ALLOCATED"

    db.add(dispatch)
    db.commit()
    db.refresh(dispatch)

    ambulance.reservation_dispatch_id = dispatch.id
    db.commit()
    db.refresh(dispatch)

    broadcast_sync("DISPATCH_CREATED", {
        "dispatch_id": dispatch.id,
        "incident_id": incident.id,
        "ambulance_id": ambulance.id,
        "status": dispatch.status,
        "coordination_status": dispatch.coordination_status,
    })

    broadcast_sync("DISPATCH_CONFIRMATION_UPDATED", {
        "dispatch_id": dispatch.id,
        "coordination_status": dispatch.coordination_status,
        "ambulance_confirmation": dispatch.ambulance_confirmation_status,
        "hospital_confirmation": dispatch.hospital_confirmation_status,
        "reservation_expires_at": reservation_expires.isoformat(),
        "attempt_number": dispatch.attempt_number,
    })

    return dispatch

@router.get("", response_model=List[DispatchOut])
def list_dispatches(db: Session = Depends(get_db)):
    dispatches = db.query(Dispatch).order_by(Dispatch.created_at.desc()).all()
    for d in dispatches:
        expire_single_dispatch_if_due(d, db)
    return dispatches

@router.get("/{dispatch_id}", response_model=DispatchOut)
def get_dispatch(dispatch_id: int, db: Session = Depends(get_db)):
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")
    expire_single_dispatch_if_due(dispatch, db)
    return dispatch

@router.post("/{dispatch_id}/confirm/ambulance", response_model=DispatchOut)
def confirm_ambulance(dispatch_id: int, payload: ConfirmationDecision, db: Session = Depends(get_db)):
    decision = payload.decision.upper().strip()
    if decision not in ["ACCEPTED", "REJECTED"]:
        raise HTTPException(status_code=400, detail="Decision must be 'ACCEPTED' or 'REJECTED'")

    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    if dispatch.coordination_status == "CONFIRMED" and decision == "ACCEPTED":
        return dispatch

    if dispatch.coordination_status in ["REJECTED", "EXPIRED", "REASSIGNMENT_REQUIRED"]:
        if decision == "ACCEPTED":
            raise HTTPException(
                status_code=400,
                detail=f"Cannot accept: dispatch coordination is '{dispatch.coordination_status}'. Provisional reservations were released."
            )
        return dispatch

    # Idempotent return if already accepted
    if dispatch.ambulance_confirmation_status == decision and decision == "ACCEPTED":
        return dispatch

    ambulance = db.query(Ambulance).filter(Ambulance.id == dispatch.ambulance_id).first()
    incident = db.query(Incident).filter(Incident.id == dispatch.incident_id).first()
    now = get_utc_now()

    if decision == "ACCEPTED":
        dispatch.ambulance_confirmation_status = "ACCEPTED"
        dispatch.ambulance_confirmed_at = now

        if dispatch.destination_hospital_id is None or dispatch.hospital_confirmation_status == "ACCEPTED":
            dispatch.coordination_status = "CONFIRMED"
            dispatch.confirmed_at = now
            if ambulance:
                ambulance.status = "DISPATCHED"
            if incident:
                incident.status = "DISPATCHED"

        db.commit()
        db.refresh(dispatch)

        broadcast_sync("DISPATCH_CONFIRMATION_UPDATED", {
            "dispatch_id": dispatch.id,
            "coordination_status": dispatch.coordination_status,
            "ambulance_confirmation": dispatch.ambulance_confirmation_status,
            "hospital_confirmation": dispatch.hospital_confirmation_status,
        })
        return dispatch

    elif decision == "REJECTED":
        # AUTOMATIC EMERGENCY ESCALATION TRIGGER
        dispatch.ambulance_confirmation_status = "REJECTED"
        return auto_escalate_dispatch(
            dispatch=dispatch,
            failure_source="AMBULANCE",
            failure_reason=payload.reason or "Ambulance crew rejected emergency assignment.",
            db=db,
        )

@router.post("/{dispatch_id}/confirm/hospital", response_model=DispatchOut)
def confirm_hospital(dispatch_id: int, payload: ConfirmationDecision, db: Session = Depends(get_db)):
    decision = payload.decision.upper().strip()
    if decision not in ["ACCEPTED", "REJECTED"]:
        raise HTTPException(status_code=400, detail="Decision must be 'ACCEPTED' or 'REJECTED'")

    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    if dispatch.coordination_status == "CONFIRMED" and decision == "ACCEPTED":
        return dispatch

    if dispatch.coordination_status in ["REJECTED", "EXPIRED", "REASSIGNMENT_REQUIRED"]:
        if decision == "ACCEPTED":
            raise HTTPException(
                status_code=400,
                detail=f"Cannot accept: dispatch coordination is '{dispatch.coordination_status}'. Provisional reservations were released."
            )
        return dispatch

    if dispatch.hospital_confirmation_status == decision and decision == "ACCEPTED":
        return dispatch

    ambulance = db.query(Ambulance).filter(Ambulance.id == dispatch.ambulance_id).first()
    incident = db.query(Incident).filter(Incident.id == dispatch.incident_id).first()
    now = get_utc_now()

    if decision == "ACCEPTED":
        dispatch.hospital_confirmation_status = "ACCEPTED"
        dispatch.hospital_confirmed_at = now

        if dispatch.ambulance_confirmation_status == "ACCEPTED":
            dispatch.coordination_status = "CONFIRMED"
            dispatch.confirmed_at = now
            if ambulance:
                ambulance.status = "DISPATCHED"
            if incident:
                incident.status = "DISPATCHED"

        db.commit()
        db.refresh(dispatch)

        broadcast_sync("DISPATCH_CONFIRMATION_UPDATED", {
            "dispatch_id": dispatch.id,
            "coordination_status": dispatch.coordination_status,
            "ambulance_confirmation": dispatch.ambulance_confirmation_status,
            "hospital_confirmation": dispatch.hospital_confirmation_status,
        })
        return dispatch

    elif decision == "REJECTED":
        # AUTOMATIC EMERGENCY ESCALATION TRIGGER
        dispatch.hospital_confirmation_status = "REJECTED"
        return auto_escalate_dispatch(
            dispatch=dispatch,
            failure_source="HOSPITAL",
            failure_reason=payload.reason or "Hospital ER unit declined admission.",
            db=db,
        )

@router.post("/{dispatch_id}/simulate-decision", response_model=DispatchOut)
def simulate_decision(dispatch_id: int, payload: SimulateDecisionRequest, db: Session = Depends(get_db)):
    party = payload.party.upper().strip()
    decision = payload.decision.upper().strip()

    if party in ["AMBULANCE", "BOTH"]:
        confirm_ambulance(dispatch_id, ConfirmationDecision(decision=decision, reason=payload.reason), db)

    if party in ["HOSPITAL", "BOTH"]:
        confirm_hospital(dispatch_id, ConfirmationDecision(decision=decision, reason=payload.reason), db)

    db.expire_all()
    return db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()

@router.post("/check-expirations")
def check_expirations(db: Session = Depends(get_db)):
    escalated_ids = check_and_escalate_expired_dispatches(db)
    return {
        "expired_count": len(escalated_ids),
        "expired_dispatch_ids": escalated_ids,
        "checked_at": get_utc_now().isoformat(),
    }

@router.post("/{dispatch_id}/reassign", response_model=DispatchOut)
def reassign_dispatch(dispatch_id: int, db: Session = Depends(get_db)):
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    return auto_escalate_dispatch(
        dispatch=dispatch,
        failure_source="DISPATCHER_OVERRIDE",
        failure_reason="Manual dispatcher reassignment requested.",
        db=db,
    )

@router.patch("/{dispatch_id}/step", response_model=DispatchOut)
def advance_dispatch_lifecycle(dispatch_id: int, db: Session = Depends(get_db)):
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch not found")

    if dispatch.coordination_status != "CONFIRMED":
        raise HTTPException(
            status_code=400,
            detail=f"Cannot advance dispatch lifecycle: Dual confirmation status is '{dispatch.coordination_status}' (Ambulance: {dispatch.ambulance_confirmation_status}, Hospital: {dispatch.hospital_confirmation_status}). Both must accept before unit can proceed."
        )

    incident = db.query(Incident).filter(Incident.id == dispatch.incident_id).first()
    ambulance = db.query(Ambulance).filter(Ambulance.id == dispatch.ambulance_id).first()

    now = get_utc_now()
    current_status = dispatch.status

    if current_status == "ASSIGNED":
        dispatch.status = "EN_ROUTE_INCIDENT"
        if incident: incident.status = "EN_ROUTE"
        if ambulance: ambulance.status = "EN_ROUTE"

    elif current_status == "EN_ROUTE_INCIDENT":
        dispatch.status = "ON_SCENE"
        dispatch.arrived_incident_at = now
        delta = (now - dispatch.dispatched_at).total_seconds()
        dispatch.actual_response_seconds = round(delta, 1)
        if incident:
            incident.status = "ON_SCENE"
            if ambulance:
                ambulance.status = "ON_SCENE"
                ambulance.current_latitude = incident.latitude
                ambulance.current_longitude = incident.longitude

    elif current_status == "ON_SCENE":
        dispatch.status = "EN_ROUTE_HOSPITAL"
        dispatch.departed_incident_at = now
        if incident: incident.status = "TRANSPORTING"
        if ambulance: ambulance.status = "TRANSPORTING"

        if dispatch.destination_hospital_id:
            hospital = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id).first()
            if hospital and incident:
                h_route = calculate_route(
                    start_lat=incident.latitude,
                    start_lon=incident.longitude,
                    dest_lat=hospital.latitude,
                    dest_lon=hospital.longitude,
                )
                dispatch.route_geometry = h_route["geometry"]
                dispatch.estimated_eta_seconds = h_route["duration_seconds"]
                dispatch.route_distance_meters = h_route["distance_meters"]

    elif current_status == "EN_ROUTE_HOSPITAL":
        dispatch.status = "COMPLETED"
        dispatch.arrived_hospital_at = now
        dispatch.completed_at = now
        if incident: incident.status = "RESOLVED"
        if ambulance:
            ambulance.status = "AVAILABLE"
            ambulance.reservation_dispatch_id = None
            if dispatch.destination_hospital_id:
                hospital = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id).first()
                if hospital:
                    ambulance.current_latitude = hospital.latitude
                    ambulance.current_longitude = hospital.longitude

        if dispatch.destination_hospital_id:
            hospital = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id).first()
            if hospital and (hospital.reserved_emergency_beds or 0) > 0:
                hospital.reserved_emergency_beds = max(0, hospital.reserved_emergency_beds - 1)

    db.commit()
    db.refresh(dispatch)

    broadcast_sync("DISPATCH_STEPPED", {
        "dispatch_id": dispatch.id,
        "status": dispatch.status,
        "incident_status": incident.status if incident else None,
        "ambulance_status": ambulance.status if ambulance else None,
    })

    return dispatch

@router.get("/route/preview")
def preview_route(
    start_lat: float,
    start_lon: float,
    dest_lat: float,
    dest_lon: float,
):
    return calculate_route(start_lat, start_lon, dest_lat, dest_lon)
