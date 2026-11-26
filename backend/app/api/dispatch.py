from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy import text
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.models.entities import Incident, Ambulance, Hospital, Dispatch, HandoverPacket, User, PatientVitals
from backend.app.schemas.vitals import VitalsCreate, VitalsOut
from backend.app.schemas.dispatch import (
    DispatchRequest,
    DispatchOut,
    PreflightValidationOut,
    ConfirmationDecision,
    SimulateDecisionRequest,
    HandoverAcknowledgeRequest,
    HandoverReviewRequest,
    HandoverCompleteRequest,
    HandoverPacketOut,
    HospitalPreparationUpdate,
    MissionAssistanceRequest,
    AlternativeAmbulanceRequest,
    PatientNotPickedUpRequest,
)
from backend.app.services.allocation_engine import score_and_rank_ambulances
from backend.app.services.hospital_engine import rank_suitable_hospitals
from backend.app.services.routing_service import calculate_route
from backend.app.services.timeline_service import log_incident_event
from backend.app.core.ws import broadcast_sync
from backend.app.core.auth import (
    get_optional_current_user,
    ROLE_CITIZEN,
    ROLE_AMBULANCE_CREW,
    ROLE_HOSPITAL_STAFF,
    ROLE_DISPATCHER,
    ROLE_SUPER_ADMIN,
)

router = APIRouter(prefix="/api/dispatch", tags=["dispatch"])

def get_utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)

def is_postgres(db: Session) -> bool:
    try:
        return db.get_bind().dialect.name == "postgresql"
    except Exception:
        return False

def begin_immediate_if_sqlite(db: Session):
    if not is_postgres(db):
        try:
            db.execute(text("BEGIN IMMEDIATE"))
        except Exception:
            pass

def generate_or_update_handover_packet(
    dispatch: Dispatch,
    db: Session,
    force_status: Optional[str] = None,
    commit: bool = True,
) -> Optional[HandoverPacket]:
    """
    FEATURE 3 — EMERGENCY HANDOVER PACKET:
    Creates or updates the persistent structured Handover Packet for the dispatch.
    Only generated after dual confirmation (coordination_status == 'CONFIRMED').
    Idempotent: updates existing packet fields if already generated.
    """
    if dispatch.coordination_status != "CONFIRMED" and not dispatch.handover_packet:
        return None

    incident = db.query(Incident).filter(Incident.id == dispatch.incident_id).first()
    ambulance = db.query(Ambulance).filter(Ambulance.id == dispatch.ambulance_id).first()
    hospital = None
    if dispatch.destination_hospital_id:
        hospital = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id).first()

    now = get_utc_now()

    # Collect clinical observations without inventing missing data
    symptoms = []
    if incident:
        if incident.consciousness_level and incident.consciousness_level != "Alert":
            symptoms.append(f"Consciousness: {incident.consciousness_level}")
        elif incident.consciousness_level:
            symptoms.append(f"Consciousness: {incident.consciousness_level}")

        if incident.breathing_status and incident.breathing_status != "Normal":
            symptoms.append(f"Breathing: {incident.breathing_status}")
        elif incident.breathing_status:
            symptoms.append(f"Breathing: {incident.breathing_status}")

        if incident.severe_bleeding:
            symptoms.append("Active severe hemorrhage / bleeding reported")
        if incident.chest_pain:
            symptoms.append("Acute chest pain / suspected ACS")
        if incident.suspected_stroke:
            symptoms.append("Suspected stroke / neurological deficit")
        if incident.severe_trauma:
            symptoms.append("Severe blunt / penetrating trauma")

    existing_packet = db.query(HandoverPacket).filter(HandoverPacket.dispatch_id == dispatch.id).first()
    if existing_packet:
        # Update existing packet (preserves packet across reassignment and route updates)
        if ambulance:
            existing_packet.ambulance_call_sign = ambulance.call_sign
            existing_packet.ambulance_vehicle_type = ambulance.vehicle_type
            existing_packet.paramedic_level = ambulance.paramedic_level
            existing_packet.required_equipment = ambulance.equipment
        if hospital:
            existing_packet.receiving_hospital_id = hospital.id
            existing_packet.receiving_hospital_name = hospital.name
        existing_packet.estimated_arrival_eta_seconds = dispatch.estimated_eta_seconds
        existing_packet.route_distance_meters = dispatch.route_distance_meters
        existing_packet.updated_at = now
        if force_status:
            existing_packet.status = force_status
        if commit:
            db.commit()
            db.refresh(existing_packet)
        else:
            db.flush()
        return existing_packet

    # Create new packet
    packet = HandoverPacket(
        dispatch_id=dispatch.id,
        incident_id=dispatch.incident_id,
        status=force_status or "SENT",
        patient_age=incident.patient_age if incident else None,
        patient_gender=incident.patient_gender if incident and incident.patient_gender else "Unknown",
        chief_complaint=incident.chief_complaint if incident else "Emergency medical assistance",
        triage_priority=incident.triage_level if incident else "Priority 3",
        triage_color=incident.triage_color if incident else "GREEN",
        triage_score=incident.triage_score if incident else 30,
        incident_latitude=incident.latitude if incident else 0.0,
        incident_longitude=incident.longitude if incident else 0.0,
        incident_address=incident.location_address if incident else None,
        ambulance_call_sign=ambulance.call_sign if ambulance else "Unknown",
        ambulance_vehicle_type=ambulance.vehicle_type if ambulance else "BLS",
        paramedic_level=ambulance.paramedic_level if ambulance else "BASIC",
        receiving_hospital_id=hospital.id if hospital else None,
        receiving_hospital_name=hospital.name if hospital else "Receiving ER",
        estimated_arrival_eta_seconds=dispatch.estimated_eta_seconds,
        route_distance_meters=dispatch.route_distance_meters,
        created_at=now,
        updated_at=now,
    )
    packet.reported_symptoms = symptoms
    packet.triage_justifications = incident.triage_justifications if incident else []
    packet.required_equipment = ambulance.equipment if ambulance else []

    db.add(packet)
    if commit:
        db.commit()
        db.refresh(packet)
    else:
        db.flush()

    broadcast_sync(
        "HANDOVER_PACKET_GENERATED",
        {
            "dispatch_id": dispatch.id,
            "incident_id": dispatch.incident_id,
            "packet_id": packet.id,
            "status": packet.status,
            "hospital_name": packet.receiving_hospital_name,
        },
        ambulance_id=dispatch.ambulance_id,
        hospital_id=dispatch.destination_hospital_id,
        entity_type="handover_packet",
        entity_id=packet.id,
    )

    log_incident_event(
        db=db,
        incident_id=dispatch.incident_id,
        dispatch_id=dispatch.id,
        event_type="HANDOVER_PACKET_GENERATED",
        event_title="Emergency Handover Packet Compiled",
        event_description=f"Pre-arrival clinical handover packet generated and transmitted to {packet.receiving_hospital_name or 'ER'} triage.",
        actor_type="SYSTEM",
        actor_reference="Clinical Telemetry",
        metadata={"packet_id": packet.id, "status": packet.status},
        commit=commit,
    )

    return packet

def auto_escalate_dispatch(
    dispatch: Dispatch,
    failure_source: str,
    failure_reason: str,
    db: Session,
    expected_attempt: Optional[int] = None,
) -> Dispatch:
    """
    FEATURE 2 — SMART EMERGENCY ESCALATION (Hardened with Concurrency Guards):
    Automatically detects emergency coordination failures and reassigns an alternative resource:
      1. Acquires transactional lock (BEGIN IMMEDIATE on SQLite / with_for_update on Postgres).
      2. Validates preconditions: aborts if already CONFIRMED, attempt mismatch, or REASSIGNMENT_REQUIRED.
      3. Releases previous provisional ambulance and hospital bed reservations exactly once.
      4. Excludes failed/rejected resources from the candidate pool across attempts.
      5. Uses existing allocation and hospital matching engines to select the next suitable unit.
      6. Creates a new provisional reservation with a fresh 90s confirmation TTL.
      7. Resets dual confirmation states to PENDING.
      8. Increments attempt_number and appends a detailed escalation audit record to history.
      9. If no alternative exists, marks REASSIGNMENT_REQUIRED and preserves incident.
      10. Atomically commits and broadcasts DISPATCH_ESCALATED and DISPATCH_CONFIRMATION_UPDATED events.
    """
    begin_immediate_if_sqlite(db)
    disp_query = db.query(Dispatch).filter(Dispatch.id == dispatch.id).execution_options(populate_existing=True)
    if is_postgres(db):
        disp_query = disp_query.with_for_update()
    locked_disp = disp_query.first()
    if locked_disp:
        dispatch = locked_disp

    now = get_utc_now()

    # Precondition checks under lock
    if dispatch.coordination_status == "CONFIRMED" and failure_source != "DISPATCHER_OVERRIDE":
        return dispatch

    if expected_attempt is not None and dispatch.attempt_number != expected_attempt:
        return dispatch

    if failure_source == "TIMEOUT" and dispatch.reservation_expires_at and dispatch.reservation_expires_at > now:
        return dispatch

    if dispatch.coordination_status == "REASSIGNMENT_REQUIRED" and failure_source != "DISPATCHER_OVERRIDE":
        return dispatch

    incident = db.query(Incident).filter(Incident.id == dispatch.incident_id).first()

    # 1. Release previous reservations safely (without committing prematurely)
    old_amb = None
    if dispatch.ambulance_id:
        amb_q = db.query(Ambulance).filter(Ambulance.id == dispatch.ambulance_id)
        if is_postgres(db):
            amb_q = amb_q.with_for_update()
        old_amb = amb_q.first()
        if old_amb and old_amb.status == "RESERVED" and (old_amb.reservation_dispatch_id == dispatch.id or old_amb.reservation_dispatch_id is None):
            old_amb.status = "AVAILABLE"
            old_amb.reservation_dispatch_id = None

    old_hosp = None
    if dispatch.destination_hospital_id:
        hosp_q = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id)
        if is_postgres(db):
            hosp_q = hosp_q.with_for_update()
        old_hosp = hosp_q.first()
        if old_hosp and (old_hosp.reserved_emergency_beds or 0) > 0 and dispatch.coordination_status != "CONFIRMED":
            old_hosp.reserved_emergency_beds = max(0, old_hosp.reserved_emergency_beds - 1)

    log_incident_event(
        db=db,
        incident_id=dispatch.incident_id,
        dispatch_id=dispatch.id,
        event_type="ESCALATION_TRIGGERED",
        event_title=f"Smart Escalation Triggered ({failure_source})",
        event_description=f"Coordination failure detected: {failure_reason}. Releasing previous reservations.",
        actor_type="SYSTEM",
        actor_reference="Smart Escalation Engine",
        metadata={
            "failure_source": failure_source,
            "failure_reason": failure_reason,
            "attempt_number": dispatch.attempt_number,
        },
        commit=False,
    )

    # 2. Gather excluded resources across all attempts
    history = list(dispatch.escalation_history or [])
    failed_amb_ids = set()
    failed_hosp_ids = set()

    if failure_source == "DISPATCHER_OVERRIDE":
        # Dispatcher manual intervention explicitly resets exclusions to pick best available unit
        pass
    else:
        if dispatch.ambulance_id:
            failed_amb_ids.add(dispatch.ambulance_id)
        if failure_source == "HOSPITAL" and dispatch.destination_hospital_id:
            failed_hosp_ids.add(dispatch.destination_hospital_id)

        for entry in history:
            if entry.get("failed_ambulance_id"):
                failed_amb_ids.add(entry["failed_ambulance_id"])
            if entry.get("failed_hospital_id") and entry.get("failure_source") == "HOSPITAL":
                failed_hosp_ids.add(entry["failed_hospital_id"])

    # 3. Find candidate ambulances: AVAILABLE and not in failed_amb_ids
    amb_filters = [
        Ambulance.status == "AVAILABLE",
        Ambulance.is_active == True,
    ]
    if failed_amb_ids:
        amb_filters.append(Ambulance.id.notin_(failed_amb_ids))

    all_ambs = db.query(Ambulance).filter(*amb_filters).all()

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
            "ambulance_id": dispatch.ambulance_id,
            "failure_source": failure_source,
            "reason": failure_reason,
            "coordination_status": dispatch.coordination_status,
        }, broadcast_to_all=True)
        broadcast_sync("DISPATCH_CONFIRMATION_UPDATED", {
            "dispatch_id": dispatch.id,
            "coordination_status": dispatch.coordination_status,
            "ambulance_confirmation": dispatch.ambulance_confirmation_status,
            "hospital_confirmation": dispatch.hospital_confirmation_status,
            "ambulance_id": dispatch.ambulance_id,
        }, broadcast_to_all=True)
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

        broadcast_sync("DISPATCH_ESCALATION_FAILED", {
            "dispatch_id": dispatch.id,
            "incident_id": dispatch.incident_id,
            "ambulance_id": dispatch.ambulance_id,
            "failure_source": failure_source,
            "reason": failure_reason,
            "coordination_status": dispatch.coordination_status,
        }, broadcast_to_all=True)
        broadcast_sync("DISPATCH_CONFIRMATION_UPDATED", {
            "dispatch_id": dispatch.id,
            "coordination_status": dispatch.coordination_status,
            "ambulance_confirmation": dispatch.ambulance_confirmation_status,
            "hospital_confirmation": dispatch.hospital_confirmation_status,
            "ambulance_id": dispatch.ambulance_id,
        }, broadcast_to_all=True)
        return dispatch

    best_amb_cand = ranking["ranked_ambulances"][0]
    amb_new_q = db.query(Ambulance).filter(Ambulance.id == best_amb_cand["ambulance_id"])
    if is_postgres(db):
        amb_new_q = amb_new_q.with_for_update()
    new_amb = amb_new_q.first()

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
            hosp_new_q = db.query(Hospital).filter(Hospital.id == best_hosp_cand["hospital_id"])
            if is_postgres(db):
                hosp_new_q = hosp_new_q.with_for_update()
            new_hosp = hosp_new_q.first()
    elif dispatch.destination_hospital_id and dispatch.destination_hospital_id not in failed_hosp_ids:
        hosp_new_q = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id)
        if is_postgres(db):
            hosp_new_q = hosp_new_q.with_for_update()
        new_hosp = hosp_new_q.first()

    if not new_hosp:
        # All candidate hospitals exhausted or unavailable
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
            "escalation_result": "REASSIGNMENT_REQUIRED_NO_HOSPITAL",
        }
        history.append(history_entry)
        dispatch.escalation_history = history
        dispatch.coordination_status = "REASSIGNMENT_REQUIRED"
        dispatch.rejection_source = failure_source
        dispatch.rejection_reason = failure_reason or "All regional hospitals exhausted or declining emergency intake."
        if incident and incident.status == "ALLOCATED":
            incident.status = "TRIAGED"
        db.commit()
        db.refresh(dispatch)

        broadcast_sync("DISPATCH_ESCALATION_FAILED", {
            "dispatch_id": dispatch.id,
            "incident_id": dispatch.incident_id,
            "failure_source": failure_source,
            "reason": "No hospital capacity available in region.",
        }, broadcast_to_all=True)
        broadcast_sync("DISPATCH_CONFIRMATION_UPDATED", {
            "dispatch_id": dispatch.id,
            "coordination_status": dispatch.coordination_status,
            "ambulance_confirmation": dispatch.ambulance_confirmation_status,
            "hospital_confirmation": dispatch.hospital_confirmation_status,
        }, broadcast_to_all=True)
        return dispatch

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

    log_incident_event(
        db=db,
        incident_id=dispatch.incident_id,
        dispatch_id=dispatch.id,
        event_type="RESOURCE_REASSIGNED",
        event_title=f"Emergency Reassigned (Attempt #{dispatch.attempt_number})",
        event_description=f"Assigned replacement unit {new_amb.call_sign} ({new_amb.vehicle_type}) and hospital {new_hosp.name if new_hosp else 'ER'}. Fresh 90s dual confirmation window.",
        actor_type="SYSTEM",
        actor_reference="Allocation Engine",
        metadata={
            "attempt_number": dispatch.attempt_number,
            "new_ambulance_id": new_amb.id,
            "new_ambulance_call_sign": new_amb.call_sign,
            "new_hospital_id": new_hosp.id if new_hosp else None,
            "new_hospital_name": new_hosp.name if new_hosp else None,
        },
        commit=False,
    )

    if dispatch.handover_packet:
        generate_or_update_handover_packet(dispatch, db, commit=False)

    db.commit()
    db.refresh(dispatch)

    # 9. Broadcast live events
    broadcast_sync("DISPATCH_ESCALATED", {
        "dispatch_id": dispatch.id,
        "incident_id": incident.id,
        "attempt_number": dispatch.attempt_number,
        "new_ambulance_id": new_amb.id,
        "new_ambulance_call_sign": new_amb.call_sign,
        "previous_ambulance_id": old_amb.id if old_amb else None,
        "previous_ambulance_call_sign": old_amb.call_sign if old_amb else None,
        "failure_source": failure_source,
        "failure_reason": failure_reason,
    }, ambulance_id=new_amb.id, hospital_id=new_hosp.id if new_hosp else None, broadcast_to_all=True)
    broadcast_sync("DISPATCH_CONFIRMATION_UPDATED", {
        "dispatch_id": dispatch.id,
        "coordination_status": dispatch.coordination_status,
        "ambulance_confirmation": dispatch.ambulance_confirmation_status,
        "hospital_confirmation": dispatch.hospital_confirmation_status,
        "reservation_expires_at": reservation_expires.isoformat(),
        "attempt_number": dispatch.attempt_number,
        "new_ambulance_id": new_amb.id,
        "previous_ambulance_id": old_amb.id if old_amb else None,
    }, ambulance_id=new_amb.id, hospital_id=new_hosp.id if new_hosp else None, broadcast_to_all=True)
    broadcast_sync("DISPATCH_REASSIGNED", {
        "dispatch_id": dispatch.id,
        "incident_id": incident.id,
        "new_ambulance_id": new_amb.id,
        "new_ambulance_call_sign": new_amb.call_sign,
        "previous_ambulance_id": old_amb.id if old_amb else None,
        "previous_ambulance_call_sign": old_amb.call_sign if old_amb else None,
        "attempt_number": dispatch.attempt_number,
    }, ambulance_id=new_amb.id, hospital_id=new_hosp.id if new_hosp else None, broadcast_to_all=True)

    return dispatch

def check_and_escalate_expired_dispatches(db: Session) -> List[int]:
    """
    Sweeps active dispatches in PENDING_CONFIRMATIONS whose reservation TTL has expired
    and automatically executes smart escalation.
    """
    begin_immediate_if_sqlite(db)
    now = get_utc_now()
    pending = db.query(Dispatch).filter(
        Dispatch.coordination_status == "PENDING_CONFIRMATIONS",
        Dispatch.reservation_expires_at.isnot(None),
        Dispatch.reservation_expires_at < now,
    ).all()

    escalated_ids = []
    for d in pending:
        try:
            db.refresh(d)
        except Exception:
            pass
        if (
            d.coordination_status == "PENDING_CONFIRMATIONS"
            and d.reservation_expires_at
            and d.reservation_expires_at < now
        ):
            log_incident_event(
                db=db,
                incident_id=d.incident_id,
                dispatch_id=d.id,
                event_type="RESERVATION_EXPIRED",
                event_title="Provisional Reservation Expired",
                event_description="Dual confirmation window (90s TTL) elapsed without both parties accepting. Auto-escalating.",
                actor_type="SYSTEM",
                actor_reference="Background Escalation Worker",
                metadata={"attempt_number": d.attempt_number},
                commit=False,
            )
            auto_escalate_dispatch(
                dispatch=d,
                failure_source="TIMEOUT",
                failure_reason="Provisional reservation expired (90s confirmation TTL elapsed without dual acceptance).",
                db=db,
                expected_attempt=d.attempt_number,
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
            expected_attempt=dispatch.attempt_number,
        )
        return True
    return False
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
@router.get("/recommendations/{incident_id}")
def get_dispatch_recommendation(incident_id: int, db: Session = Depends(get_db)):
    incident = db.query(Incident).filter(Incident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")

    ambulances = db.query(Ambulance).all()
    hospitals = db.query(Hospital).all()

    ambulance_results = score_and_rank_ambulances(incident=incident, ambulances=ambulances)
    hospital_results = rank_suitable_hospitals(incident=incident, hospitals=hospitals)

    rec_ambulance = ambulance_results.get("recommended_ambulance")
    rec_hospital = hospital_results.get("recommended_hospital")

    # Generate route geometry coordinates preview for dispatcher map
    amb_lat = rec_ambulance.get("current_latitude") if isinstance(rec_ambulance, dict) else getattr(rec_ambulance, "current_latitude", None)
    amb_lng = rec_ambulance.get("current_longitude") if isinstance(rec_ambulance, dict) else getattr(rec_ambulance, "current_longitude", None)
    hosp_lat = rec_hospital.get("latitude") if isinstance(rec_hospital, dict) else getattr(rec_hospital, "latitude", None)
    hosp_lng = rec_hospital.get("longitude") if isinstance(rec_hospital, dict) else getattr(rec_hospital, "longitude", None)

    route_geometry = []
    if amb_lat is not None and amb_lng is not None:
        route_geometry.append([amb_lat, amb_lng])
        route_geometry.append([incident.latitude, incident.longitude])
        if hosp_lat is not None and hosp_lng is not None:
            route_geometry.append([hosp_lat, hosp_lng])

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
        "recommended_ambulance": rec_ambulance,
        "recommended_hospital": rec_hospital,
        "route_geometry": route_geometry,
    }

@router.post("/auto-allocate/{incident_id}", response_model=DispatchOut, status_code=status.HTTP_201_CREATED)
def auto_allocate_dispatch(
    incident_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
    request: Request = None,
):
    """
    Automatic Ambulance & Hospital Allocation Engine:
    Selects the best available ambulance and suitable hospital using multi-factor scoring
    and establishes a temporary dual confirmation reservation with 90-second expiry.
    """
    auth_user = current_user if isinstance(current_user, User) else None
    if request is not None and auth_user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required to trigger automatic dispatch allocation.",
        )
    if auth_user and auth_user.role not in (ROLE_DISPATCHER, ROLE_SUPER_ADMIN):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access denied: {auth_user.role} accounts cannot trigger dispatch allocation.",
        )

    incident = db.query(Incident).filter(Incident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")

    ambulances = db.query(Ambulance).all()
    hospitals = db.query(Hospital).all()

    amb_results = score_and_rank_ambulances(incident=incident, ambulances=ambulances)
    hosp_results = rank_suitable_hospitals(incident=incident, hospitals=hospitals)

    rec_amb = amb_results.get("recommended_ambulance")
    rec_hosp = hosp_results.get("recommended_hospital")

    if not rec_amb:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No feasible ambulance currently available in the sector. Incident placed on priority manual dispatch queue.",
        )
    if not rec_hosp:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No suitable receiving emergency department currently available. Incident awaiting manual medical direction.",
        )

    dispatch_payload = DispatchRequest(
        incident_id=incident.id,
        ambulance_id=rec_amb["ambulance_id"],
        destination_hospital_id=rec_hosp["hospital_id"],
    )

    return create_dispatch(payload=dispatch_payload, db=db, current_user=current_user, request=None)

@router.post("/validate", response_model=PreflightValidationOut)
def validate_dispatch_preflight(
    payload: DispatchRequest,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    FEATURE: Smart Pre-Flight Validation for Manual Dispatch Allocation
    Inspects proposed allocation parameters against authoritative database state.
    Returns whether allocation is feasible, with descriptive error and warning messages.
    """
    errors: List[str] = []
    warnings: List[str] = []

    incident = db.query(Incident).filter(Incident.id == payload.incident_id).first()
    if not incident:
        return PreflightValidationOut(
            is_valid=False,
            incident_id=payload.incident_id,
            ambulance_id=payload.ambulance_id,
            hospital_id=payload.destination_hospital_id,
            errors=["Incident record not found."],
        )

    if incident.status in ["CANCELLED", "RESOLVED", "CLOSED"]:
        errors.append(f"Incident #{incident.id} is already in terminal stage '{incident.status}'. No new dispatch can be allocated.")

    active_disp = db.query(Dispatch).filter(
        Dispatch.incident_id == incident.id,
        Dispatch.status.notin_(["COMPLETED", "CANCELLED"]),
        Dispatch.coordination_status.notin_(["REJECTED", "EXPIRED"]),
    ).first()
    if active_disp:
        errors.append(f"Incident #{incident.id} already has an active dispatch (#{active_disp.id} - status: {active_disp.status}). Duplicate allocation prohibited.")

    ambulance = db.query(Ambulance).filter(Ambulance.id == payload.ambulance_id).first()
    if not ambulance:
        errors.append(f"Ambulance unit #{payload.ambulance_id} not found in fleet.")
    else:
        if not ambulance.is_active:
            errors.append(f"Ambulance {ambulance.call_sign} is decommissioned or inactive.")
        if ambulance.status != "AVAILABLE":
            errors.append(f"Ambulance {ambulance.call_sign} is currently '{ambulance.status}' (expected 'AVAILABLE').")
        if ambulance.reservation_dispatch_id and (not active_disp or ambulance.reservation_dispatch_id != active_disp.id):
            errors.append(f"Ambulance {ambulance.call_sign} holds an active reservation for dispatch #{ambulance.reservation_dispatch_id}.")

        if incident.required_ambulance_type == "ALS" and ambulance.vehicle_type != "ALS":
            warnings.append(f"Clinical Triage mismatch: Incident requires an ALS unit, but {ambulance.call_sign} is a {ambulance.vehicle_type} unit.")

    if payload.destination_hospital_id:
        hospital = db.query(Hospital).filter(Hospital.id == payload.destination_hospital_id).first()
        if not hospital:
            errors.append(f"Hospital facility #{payload.destination_hospital_id} not found.")
        else:
            if not hospital.accepting_emergencies:
                errors.append(f"Hospital {hospital.name} is currently not accepting emergency transfers.")
            if hospital.readiness_status == "DIVERT":
                errors.append(f"Hospital {hospital.name} is currently on DIVERT status.")
            elif hospital.readiness_status == "BUSY":
                warnings.append(f"Hospital {hospital.name} is operating at heavy capacity ('BUSY').")

            unreserved_beds = hospital.available_emergency_beds - (hospital.reserved_emergency_beds or 0)
            if unreserved_beds <= 0:
                errors.append(f"Hospital {hospital.name} has no available emergency bays (0 unreserved beds remaining).")

    return PreflightValidationOut(
        is_valid=len(errors) == 0,
        incident_id=payload.incident_id,
        ambulance_id=payload.ambulance_id,
        hospital_id=payload.destination_hospital_id,
        errors=errors,
        warnings=warnings,
    )

@router.post("", response_model=DispatchOut, status_code=status.HTTP_201_CREATED)
def create_dispatch(
    payload: DispatchRequest,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
    request: Request = None,
):
    auth_user = current_user if isinstance(current_user, User) else None
    if request is not None and auth_user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required: Only authorized regional dispatchers can create dispatches.",
        )
    if auth_user and auth_user.role not in (ROLE_DISPATCHER, ROLE_SUPER_ADMIN):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access denied: {auth_user.role} accounts cannot directly issue fleet dispatches. Only Dispatchers and Super Administrators are authorized.",
        )

    begin_immediate_if_sqlite(db)

    incident = db.query(Incident).filter(Incident.id == payload.incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")

    if incident.status in ["CANCELLED", "RESOLVED", "CLOSED"]:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot allocate dispatch for Incident #{incident.id}: Incident is already in terminal stage '{incident.status}'."
        )

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
            status_code=409,
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
    db.flush()

    ambulance.reservation_dispatch_id = dispatch.id

    log_incident_event(
        db=db,
        incident_id=incident.id,
        dispatch_id=dispatch.id,
        event_type="RESOURCES_RESERVED",
        event_title="Resources Provisionally Reserved",
        event_description=f"Unit {ambulance.call_sign} ({ambulance.vehicle_type}) and hospital {hospital.name if hospital else 'ER'} provisionally reserved with 90s dual confirmation window.",
        actor_type="DISPATCHER",
        actor_reference="Emergency Coordinator",
        metadata={
            "ambulance_id": ambulance.id,
            "ambulance_call_sign": ambulance.call_sign,
            "hospital_id": hospital.id if hospital else None,
            "hospital_name": hospital.name if hospital else None,
            "ttl_seconds": 90,
            "attempt_number": dispatch.attempt_number,
        },
        commit=False,
    )

    db.commit()
    db.refresh(dispatch)

    broadcast_sync(
        "DISPATCH_CREATED",
        {
            "dispatch_id": dispatch.id,
            "incident_id": incident.id,
            "ambulance_id": ambulance.id,
            "destination_hospital_id": hospital.id if hospital else None,
            "status": dispatch.status,
            "coordination_status": dispatch.coordination_status,
            "ambulance_call_sign": ambulance.call_sign,
            "destination_hospital_name": hospital.name if hospital else "TBD",
            "reservation_expires_at": reservation_expires.isoformat(),
        },
        ambulance_id=ambulance.id,
        hospital_id=hospital.id if hospital else None,
        reporter_user_id=incident.reporter_user_id,
        entity_type="dispatch",
        entity_id=dispatch.id,
    )

    broadcast_sync(
        "DISPATCH_CONFIRMATION_UPDATED",
        {
            "dispatch_id": dispatch.id,
            "incident_id": incident.id,
            "ambulance_id": ambulance.id,
            "destination_hospital_id": hospital.id if hospital else None,
            "coordination_status": dispatch.coordination_status,
            "ambulance_confirmation": dispatch.ambulance_confirmation_status,
            "hospital_confirmation": dispatch.hospital_confirmation_status,
            "reservation_expires_at": reservation_expires.isoformat(),
            "attempt_number": dispatch.attempt_number,
        },
        ambulance_id=ambulance.id,
        hospital_id=hospital.id if hospital else None,
        reporter_user_id=incident.reporter_user_id,
        entity_type="dispatch",
        entity_id=dispatch.id,
    )

    log_incident_event(
        db=db,
        incident_id=incident.id,
        dispatch_id=dispatch.id,
        event_type="RESOURCES_RESERVED",
        event_title="Resources Provisionally Reserved",
        event_description=f"Unit {ambulance.call_sign} ({ambulance.vehicle_type}) and hospital {hospital.name if hospital else 'ER'} provisionally reserved with 90s dual confirmation window.",
        actor_type="DISPATCHER",
        actor_reference="Emergency Coordinator",
        metadata={
            "ambulance_id": ambulance.id,
            "ambulance_call_sign": ambulance.call_sign,
            "hospital_id": hospital.id if hospital else None,
            "hospital_name": hospital.name if hospital else None,
            "ttl_seconds": 90,
            "attempt_number": dispatch.attempt_number,
        },
    )

    return dispatch

@router.get("", response_model=List[DispatchOut])
def list_dispatches(
    incident_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    query = db.query(Dispatch)
    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            query = query.join(Incident).filter(Incident.reporter_user_id == auth_user.id)
        elif auth_user.role == ROLE_AMBULANCE_CREW:
            amb_id = auth_user.ambulance_id
            if not amb_id and auth_user.ambulance:
                amb_id = auth_user.ambulance.id
            if not amb_id:
                user_call_sign = getattr(auth_user, "ambulance_call_sign", None)
                if user_call_sign:
                    matched_amb = db.query(Ambulance).filter(Ambulance.call_sign == user_call_sign).first()
                    if matched_amb:
                        amb_id = matched_amb.id
                        auth_user.ambulance_id = matched_amb.id
                        try:
                            db.commit()
                        except Exception:
                            db.rollback()
            if amb_id:
                query = query.filter(Dispatch.ambulance_id == amb_id)
            else:
                query = query.filter(Dispatch.id == -1)
        elif auth_user.role == ROLE_HOSPITAL_STAFF:
            if auth_user.hospital_id:
                query = query.filter(Dispatch.destination_hospital_id == auth_user.hospital_id)
            else:
                query = query.filter(Dispatch.id == -1)

    if incident_id:
        query = query.filter(Dispatch.incident_id == incident_id)

    dispatches = query.order_by(Dispatch.created_at.desc()).all()
    for d in dispatches:
        expire_single_dispatch_if_due(d, db)
    return dispatches

@router.get("/{dispatch_id}", response_model=DispatchOut)
def get_dispatch(
    dispatch_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            if dispatch.incident and dispatch.incident.reporter_user_id != auth_user.id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied: Cannot view another citizen's emergency dispatch")
        elif auth_user.role == ROLE_AMBULANCE_CREW:
            driver_amb_id = auth_user.ambulance_id or (auth_user.ambulance.id if auth_user.ambulance else None)
            if driver_amb_id and dispatch.ambulance_id != driver_amb_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied: Cannot view dispatches assigned to another ambulance unit")
        elif auth_user.role == ROLE_HOSPITAL_STAFF:
            if not auth_user.hospital_id or dispatch.destination_hospital_id != auth_user.hospital_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied: Cannot view dispatches routed to another hospital")

    expire_single_dispatch_if_due(dispatch, db)
    return dispatch

@router.post("/{dispatch_id}/confirm/ambulance", response_model=DispatchOut)
@router.post("/{dispatch_id}/confirm-ambulance", response_model=DispatchOut)
def confirm_ambulance(
    dispatch_id: int,
    payload: ConfirmationDecision,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    begin_immediate_if_sqlite(db)
    decision = payload.decision.upper().strip()
    if decision not in ["ACCEPTED", "REJECTED"]:
        raise HTTPException(status_code=400, detail="Decision must be 'ACCEPTED' or 'REJECTED'")

    disp_query = db.query(Dispatch).filter(Dispatch.id == dispatch_id).execution_options(populate_existing=True)
    if is_postgres(db):
        disp_query = disp_query.with_for_update()
    dispatch = disp_query.first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Citizens cannot confirm or reject ambulance assignments")
        if auth_user.role == ROLE_HOSPITAL_STAFF:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Hospital staff cannot confirm or reject ambulance assignments")
        if auth_user.role == ROLE_AMBULANCE_CREW:
            driver_amb_id = auth_user.ambulance_id or (auth_user.ambulance.id if auth_user.ambulance else None)
            if not driver_amb_id or dispatch.ambulance_id != driver_amb_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Paramedic crew can only confirm or reject assignments for their own ambulance unit")

    if payload.attempt_number is not None and payload.attempt_number != dispatch.attempt_number:
        raise HTTPException(
            status_code=400,
            detail=f"Stale confirmation: dispatch has already escalated to attempt #{dispatch.attempt_number} (received attempt #{payload.attempt_number})."
        )

    if dispatch.coordination_status == "CONFIRMED":
        if decision == "ACCEPTED":
            return dispatch
        else:
            raise HTTPException(
                status_code=400,
                detail="Cannot reject: dispatch has already reached CONFIRMED coordination status."
            )

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

        log_incident_event(
            db=db,
            incident_id=dispatch.incident_id,
            dispatch_id=dispatch.id,
            event_type="AMBULANCE_ACCEPTED",
            event_title=f"Ambulance {ambulance.call_sign if ambulance else 'Crew'} Confirmed",
            event_description=f"Ambulance crew {ambulance.call_sign if ambulance else 'unit'} accepted assignment.",
            actor_type="AMBULANCE_CREW",
            actor_reference=ambulance.call_sign if ambulance else "Ambulance Unit",
            metadata={"ambulance_id": dispatch.ambulance_id, "attempt_number": dispatch.attempt_number},
            commit=False,
        )

        both_accepted = (
            dispatch.destination_hospital_id is None
            or dispatch.hospital_confirmation_status == "ACCEPTED"
        )
        if both_accepted and dispatch.coordination_status != "CONFIRMED":
            dispatch.coordination_status = "CONFIRMED"
            dispatch.confirmed_at = now
            if ambulance:
                ambulance.status = "DISPATCHED"
            if incident:
                incident.status = "DISPATCHED"

            log_incident_event(
                db=db,
                incident_id=dispatch.incident_id,
                dispatch_id=dispatch.id,
                event_type="DUAL_CONFIRMATION_COMPLETED",
                event_title="Dual Confirmation Completed",
                event_description="Both ambulance unit and receiving hospital confirmed. Unit dispatched to scene.",
                actor_type="SYSTEM",
                actor_reference="Dual Confirmation Machine",
                metadata={"coordination_status": "CONFIRMED", "attempt_number": dispatch.attempt_number},
                commit=False,
            )
            generate_or_update_handover_packet(dispatch, db, commit=False)

        db.commit()
        db.refresh(dispatch)

        inc = db.query(Incident).filter(Incident.id == dispatch.incident_id).first()
        broadcast_sync(
            "DISPATCH_CONFIRMATION_UPDATED",
            {
                "dispatch_id": dispatch.id,
                "incident_id": dispatch.incident_id,
                "ambulance_id": dispatch.ambulance_id,
                "destination_hospital_id": dispatch.destination_hospital_id,
                "coordination_status": dispatch.coordination_status,
                "ambulance_confirmation": dispatch.ambulance_confirmation_status,
                "hospital_confirmation": dispatch.hospital_confirmation_status,
                "status": dispatch.status,
            },
            ambulance_id=dispatch.ambulance_id,
            hospital_id=dispatch.destination_hospital_id,
            reporter_user_id=inc.reporter_user_id if inc else None,
            entity_type="dispatch",
            entity_id=dispatch.id,
        )
        return dispatch

    elif decision == "REJECTED":
        # AUTOMATIC EMERGENCY ESCALATION TRIGGER
        dispatch.ambulance_confirmation_status = "REJECTED"
        log_incident_event(
            db=db,
            incident_id=dispatch.incident_id,
            dispatch_id=dispatch.id,
            event_type="AMBULANCE_REJECTED",
            event_title=f"Ambulance {ambulance.call_sign if ambulance else 'Crew'} Rejected",
            event_description=f"Ambulance crew rejected emergency assignment: {payload.reason or 'Declined by crew'}.",
            actor_type="AMBULANCE_CREW",
            actor_reference=ambulance.call_sign if ambulance else "Ambulance Unit",
            metadata={"reason": payload.reason, "attempt_number": dispatch.attempt_number},
            commit=False,
        )
        return auto_escalate_dispatch(
            dispatch=dispatch,
            failure_source="AMBULANCE",
            failure_reason=payload.reason or "Ambulance crew rejected emergency assignment.",
            db=db,
            expected_attempt=dispatch.attempt_number,
        )

@router.post("/{dispatch_id}/confirm/hospital", response_model=DispatchOut)
@router.post("/{dispatch_id}/confirm-hospital", response_model=DispatchOut)
def confirm_hospital(
    dispatch_id: int,
    payload: ConfirmationDecision,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    begin_immediate_if_sqlite(db)
    decision = payload.decision.upper().strip()
    if decision not in ["ACCEPTED", "REJECTED"]:
        raise HTTPException(status_code=400, detail="Decision must be 'ACCEPTED' or 'REJECTED'")

    disp_query = db.query(Dispatch).filter(Dispatch.id == dispatch_id).execution_options(populate_existing=True)
    if is_postgres(db):
        disp_query = disp_query.with_for_update()
    dispatch = disp_query.first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Citizens cannot confirm or reject hospital bed reservations")
        if auth_user.role == ROLE_AMBULANCE_CREW:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Ambulance crew cannot confirm or reject hospital bed reservations")
        if auth_user.role == ROLE_HOSPITAL_STAFF:
            if not auth_user.hospital_id or dispatch.destination_hospital_id != auth_user.hospital_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Hospital staff can only confirm or reject bed reservations for their own facility")

    if payload.attempt_number is not None and payload.attempt_number != dispatch.attempt_number:
        raise HTTPException(
            status_code=400,
            detail=f"Stale confirmation: dispatch has already escalated to attempt #{dispatch.attempt_number} (received attempt #{payload.attempt_number})."
        )

    if dispatch.coordination_status == "CONFIRMED":
        if decision == "ACCEPTED":
            return dispatch
        else:
            raise HTTPException(
                status_code=400,
                detail="Cannot reject: dispatch has already reached CONFIRMED coordination status."
            )

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
        hosp_query = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id)
        if is_postgres(db):
            hosp_query = hosp_query.with_for_update()
        hospital = hosp_query.first()
        if not hospital:
            raise HTTPException(status_code=404, detail="Destination hospital record not found")
        if not hospital.accepting_emergencies:
            raise HTTPException(
                status_code=409,
                detail=f"Hospital {hospital.name} is currently not accepting emergency intakes"
            )
        if hospital.readiness_status in ["DIVERT", "OFFLINE"]:
            raise HTTPException(
                status_code=409,
                detail=f"Hospital {hospital.name} is in {hospital.readiness_status} status and cannot accept emergency admissions"
            )
        if (hospital.available_emergency_beds or 0) <= 0:
            raise HTTPException(
                status_code=409,
                detail=f"Hospital {hospital.name} has 0 available emergency beds"
            )
        if (hospital.available_emergency_beds or 0) < (hospital.reserved_emergency_beds or 0):
            raise HTTPException(
                status_code=409,
                detail=f"Hospital {hospital.name} emergency bed capacity is exhausted"
            )

        dispatch.hospital_confirmation_status = "ACCEPTED"
        dispatch.hospital_confirmed_at = now

        log_incident_event(
            db=db,
            incident_id=dispatch.incident_id,
            dispatch_id=dispatch.id,
            event_type="HOSPITAL_ACCEPTED",
            event_title="Hospital ER Confirmed Intake",
            event_description="Receiving hospital emergency unit confirmed capacity reservation.",
            actor_type="HOSPITAL_ER",
            actor_reference=f"Hospital #{dispatch.destination_hospital_id}",
            metadata={"destination_hospital_id": dispatch.destination_hospital_id, "attempt_number": dispatch.attempt_number},
            commit=False,
        )

        both_accepted = (dispatch.ambulance_confirmation_status == "ACCEPTED")
        if both_accepted and dispatch.coordination_status != "CONFIRMED":
            dispatch.coordination_status = "CONFIRMED"
            dispatch.confirmed_at = now
            if ambulance:
                ambulance.status = "DISPATCHED"
            if incident:
                incident.status = "DISPATCHED"

            log_incident_event(
                db=db,
                incident_id=dispatch.incident_id,
                dispatch_id=dispatch.id,
                event_type="DUAL_CONFIRMATION_COMPLETED",
                event_title="Dual Confirmation Completed",
                event_description="Both ambulance unit and receiving hospital confirmed. Unit dispatched to scene.",
                actor_type="SYSTEM",
                actor_reference="Dual Confirmation Machine",
                metadata={"coordination_status": "CONFIRMED", "attempt_number": dispatch.attempt_number},
                commit=False,
            )
            generate_or_update_handover_packet(dispatch, db, commit=False)

        db.commit()
        db.refresh(dispatch)

        inc = db.query(Incident).filter(Incident.id == dispatch.incident_id).first()
        broadcast_sync(
            "DISPATCH_CONFIRMATION_UPDATED",
            {
                "dispatch_id": dispatch.id,
                "incident_id": dispatch.incident_id,
                "ambulance_id": dispatch.ambulance_id,
                "destination_hospital_id": dispatch.destination_hospital_id,
                "coordination_status": dispatch.coordination_status,
                "ambulance_confirmation": dispatch.ambulance_confirmation_status,
                "hospital_confirmation": dispatch.hospital_confirmation_status,
                "status": dispatch.status,
            },
            ambulance_id=dispatch.ambulance_id,
            hospital_id=dispatch.destination_hospital_id,
            reporter_user_id=inc.reporter_user_id if inc else None,
            entity_type="dispatch",
            entity_id=dispatch.id,
        )
        return dispatch

    elif decision == "REJECTED":
        reason = (payload.reason or "").strip()
        if not reason:
            raise HTTPException(
                status_code=400,
                detail="A valid rejection reason is required when declining an emergency bed reservation."
            )
        # AUTOMATIC EMERGENCY ESCALATION TRIGGER
        dispatch.hospital_confirmation_status = "REJECTED"
        log_incident_event(
            db=db,
            incident_id=dispatch.incident_id,
            dispatch_id=dispatch.id,
            event_type="HOSPITAL_REJECTED",
            event_title="Hospital ER Declined Intake",
            event_description=f"Receiving hospital declined emergency admission: {reason}.",
            actor_type="HOSPITAL_ER",
            actor_reference=f"Hospital #{dispatch.destination_hospital_id}",
            metadata={"reason": reason, "attempt_number": dispatch.attempt_number},
            commit=False,
        )
        return auto_escalate_dispatch(
            dispatch=dispatch,
            failure_source="HOSPITAL",
            failure_reason=reason,
            db=db,
            expected_attempt=dispatch.attempt_number,
        )

@router.post("/{dispatch_id}/simulate-decision", response_model=DispatchOut)
def simulate_decision(dispatch_id: int, payload: SimulateDecisionRequest, db: Session = Depends(get_db)):
    party = payload.party.upper().strip()
    decision = payload.decision.upper().strip()

    if party in ["AMBULANCE", "BOTH"]:
        confirm_ambulance(dispatch_id, ConfirmationDecision(decision=decision, reason=payload.reason), db)

    if party in ["HOSPITAL", "BOTH"]:
        confirm_hospital(dispatch_id, ConfirmationDecision(decision=decision, reason=payload.reason or "Simulated hospital decision"), db)

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
def reassign_dispatch(
    dispatch_id: int,
    expected_attempt: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user and auth_user.role not in (ROLE_DISPATCHER, ROLE_SUPER_ADMIN):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access denied: role '{auth_user.role}' cannot manually reassign dispatches. Only dispatchers and super administrators are authorized.",
        )

    begin_immediate_if_sqlite(db)
    disp_query = db.query(Dispatch).filter(Dispatch.id == dispatch_id).execution_options(populate_existing=True)
    if is_postgres(db):
        disp_query = disp_query.with_for_update()
    dispatch = disp_query.first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    if dispatch.status in ["COMPLETED", "CANCELLED"]:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot reassign: dispatch #{dispatch.id} is already in terminal stage '{dispatch.status}'."
        )

    if expected_attempt is not None and dispatch.attempt_number != expected_attempt:
        return dispatch

    return auto_escalate_dispatch(
        dispatch=dispatch,
        failure_source="DISPATCHER_OVERRIDE",
        failure_reason="Manual dispatcher reassignment requested.",
        db=db,
        expected_attempt=expected_attempt or dispatch.attempt_number,
    )

@router.patch("/{dispatch_id}/step", response_model=DispatchOut)
def advance_dispatch_lifecycle(
    dispatch_id: int,
    expected_status: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    begin_immediate_if_sqlite(db)

    disp_query = db.query(Dispatch).filter(Dispatch.id == dispatch_id).execution_options(populate_existing=True)
    if is_postgres(db):
        disp_query = disp_query.with_for_update()
    dispatch = disp_query.first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Citizens cannot advance ambulance mission lifecycle")
        if auth_user.role == ROLE_HOSPITAL_STAFF:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Hospital staff cannot advance ambulance mission lifecycle")
        if auth_user.role == ROLE_AMBULANCE_CREW:
            if auth_user.ambulance_id and dispatch.ambulance_id != auth_user.ambulance_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Ambulance crew can only advance lifecycle for their own assigned ambulance unit")

    if dispatch.coordination_status != "CONFIRMED":
        raise HTTPException(
            status_code=400,
            detail=f"Cannot advance dispatch lifecycle: Dual confirmation status is '{dispatch.coordination_status}' (Ambulance: {dispatch.ambulance_confirmation_status}, Hospital: {dispatch.hospital_confirmation_status}). Both must accept before unit can proceed."
        )

    current_status = dispatch.status

    if current_status in ["COMPLETED", "CANCELLED"]:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot advance dispatch lifecycle: Dispatch #{dispatch.id} is already in terminal stage '{current_status}'."
        )

    if expected_status is not None and current_status != expected_status:
        raise HTTPException(
            status_code=409,
            detail=f"Conflict: Expected current status '{expected_status}' but dispatch #{dispatch.id} is currently '{current_status}'."
        )

    incident = db.query(Incident).filter(Incident.id == dispatch.incident_id).first()
    amb_query = db.query(Ambulance).filter(Ambulance.id == dispatch.ambulance_id)
    if is_postgres(db):
        amb_query = amb_query.with_for_update()
    ambulance = amb_query.first()

    now = get_utc_now()

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
            hosp_query = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id)
            if is_postgres(db):
                hosp_query = hosp_query.with_for_update()
            hospital = hosp_query.first()
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

    elif current_status in ["EN_ROUTE_HOSPITAL", "AT_HOSPITAL"]:
        dispatch.status = "COMPLETED"
        dispatch.arrived_hospital_at = now
        dispatch.completed_at = now
        if incident: incident.status = "RESOLVED"
        if ambulance:
            ambulance.status = "AVAILABLE"
            ambulance.reservation_dispatch_id = None
            if dispatch.destination_hospital_id:
                hosp_query = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id)
                if is_postgres(db):
                    hosp_query = hosp_query.with_for_update()
                hospital = hosp_query.first()
                if hospital:
                    ambulance.current_latitude = hospital.latitude
                    ambulance.current_longitude = hospital.longitude

        if dispatch.destination_hospital_id:
            hosp_query = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id)
            if is_postgres(db):
                hosp_query = hosp_query.with_for_update()
            hospital = hosp_query.first()
            if hospital and (hospital.reserved_emergency_beds or 0) > 0:
                hospital.reserved_emergency_beds = max(0, hospital.reserved_emergency_beds - 1)

    else:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot advance dispatch lifecycle: Unsupported current status '{current_status}' for dispatch #{dispatch.id}."
        )

    log_incident_event(
        db=db,
        incident_id=dispatch.incident_id,
        dispatch_id=dispatch.id,
        event_type="EMERGENCY_COMPLETED" if dispatch.status == "COMPLETED" else "LIFECYCLE_STEPPED",
        event_title="Emergency Case Completed" if dispatch.status == "COMPLETED" else f"Ambulance Lifecycle: {dispatch.status.replace('_', ' ').title()}",
        event_description=f"Emergency coordination advanced to '{dispatch.status}'. Incident status: '{incident.status if incident else 'RESOLVED'}'.",
        actor_type="AMBULANCE_CREW",
        actor_reference=ambulance.call_sign if ambulance else "Unit Crew",
        metadata={"status": dispatch.status, "incident_status": incident.status if incident else None},
        commit=False,
    )

    if dispatch.handover_packet:
        generate_or_update_handover_packet(dispatch, db, commit=False)

    db.commit()
    db.refresh(dispatch)

    broadcast_sync(
        "DISPATCH_STEPPED",
        {
            "dispatch_id": dispatch.id,
            "incident_id": dispatch.incident_id,
            "ambulance_id": dispatch.ambulance_id,
            "destination_hospital_id": dispatch.destination_hospital_id,
            "status": dispatch.status,
            "incident_status": incident.status if incident else None,
            "ambulance_status": ambulance.status if ambulance else None,
            "estimated_eta_seconds": dispatch.estimated_eta_seconds,
        },
        ambulance_id=dispatch.ambulance_id,
        hospital_id=dispatch.destination_hospital_id,
        reporter_user_id=incident.reporter_user_id if incident else None,
        entity_type="dispatch",
        entity_id=dispatch.id,
    )

    return dispatch

# ============================================================================
# MEMBER 3, PHASE 1: PATIENT VITALS TELEMETRY & CLINICAL MONITORING
# ============================================================================

@router.post("/{dispatch_id}/vitals", response_model=VitalsOut, status_code=status.HTTP_201_CREATED)
def record_patient_vitals(
    dispatch_id: int,
    payload: VitalsCreate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Records patient physiological vitals for an active assigned ambulance mission.
    Requirements:
      1. Authenticated ambulance user only (or dispatcher/super-admin).
      2. Linked directly to the active confirmed dispatch and incident.
      3. Input validation: HR (30-250), Systolic (50-260), Diastolic (30-160),
         SpO2 (50-100), RR (5-60), Systolic > Diastolic.
      4. Duplicate submission protection: rapid duplicate submissions (<15s) with
         identical values return the existing record idempotently.
      5. Generates an IncidentEvent timeline entry and broadcasts a live WebSocket event.
      6. Synchronizes handover packet clinical observations if present.
    """
    begin_immediate_if_sqlite(db)

    disp_query = db.query(Dispatch).filter(Dispatch.id == dispatch_id).execution_options(populate_existing=True)
    if is_postgres(db):
        disp_query = disp_query.with_for_update()
    dispatch = disp_query.first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    # 1. Authorization check
    auth_user = current_user if isinstance(current_user, User) else None
    if not auth_user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication credentials required to record patient vitals",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if auth_user.role == ROLE_CITIZEN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: Citizens cannot record patient vitals",
        )
    if auth_user.role == ROLE_HOSPITAL_STAFF:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: Hospital staff cannot record ambulance patient vitals",
        )
    if auth_user.role == ROLE_AMBULANCE_CREW:
        if auth_user.ambulance_id and dispatch.ambulance_id != auth_user.ambulance_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: Paramedic crews can only record vitals for their own assigned ambulance unit",
            )

    # 2. Mission status check: must be confirmed and not completed/cancelled
    if dispatch.coordination_status != "CONFIRMED":
        raise HTTPException(
            status_code=400,
            detail=f"Cannot record vitals: Dispatch coordination status is '{dispatch.coordination_status}'. Mission must be dual-confirmed first.",
        )

    if dispatch.status in ["COMPLETED", "CANCELLED"]:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot record vitals: Dispatch #{dispatch.id} is already in terminal stage '{dispatch.status}'.",
        )

    now = get_utc_now()

    # 3. Duplicate submission prevention: check for identical record submitted within last 15 seconds
    recent = (
        db.query(PatientVitals)
        .filter(PatientVitals.dispatch_id == dispatch.id)
        .order_by(PatientVitals.recorded_at.desc())
        .first()
    )
    if recent:
        delta_sec = (now - recent.recorded_at).total_seconds() if recent.recorded_at else 999
        if (
            delta_sec < 15
            and recent.heart_rate == payload.heart_rate
            and recent.blood_pressure_systolic == payload.blood_pressure_systolic
            and recent.blood_pressure_diastolic == payload.blood_pressure_diastolic
            and recent.oxygen_saturation == payload.oxygen_saturation
            and recent.respiratory_rate == payload.respiratory_rate
        ):
            # If notes were provided on the duplicate, update notes
            if payload.notes and not recent.notes:
                recent.notes = payload.notes
                db.commit()
                db.refresh(recent)
            return recent

    # 4. Create and persist vitals record
    vitals = PatientVitals(
        dispatch_id=dispatch.id,
        incident_id=dispatch.incident_id,
        recorded_by_user_id=auth_user.id,
        heart_rate=payload.heart_rate,
        blood_pressure_systolic=payload.blood_pressure_systolic,
        blood_pressure_diastolic=payload.blood_pressure_diastolic,
        oxygen_saturation=payload.oxygen_saturation,
        respiratory_rate=payload.respiratory_rate,
        notes=payload.notes.strip() if payload.notes else None,
        recorded_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(vitals)

    # 5. Log incident timeline event
    log_incident_event(
        db=db,
        incident_id=dispatch.incident_id,
        dispatch_id=dispatch.id,
        event_type="PATIENT_VITALS_RECORDED",
        event_title="Patient Vitals Recorded",
        event_description=(
            f"Vitals recorded: HR {vitals.heart_rate} bpm, "
            f"BP {vitals.blood_pressure_display} mmHg, "
            f"SpO2 {vitals.oxygen_saturation}%, "
            f"RR {vitals.respiratory_rate}/min."
            + (f" Notes: {vitals.notes}" if vitals.notes else "")
        ),
        actor_type="AMBULANCE_CREW",
        actor_reference=dispatch.ambulance_call_sign or auth_user.full_name,
        metadata={
            "vitals_id": vitals.id,
            "heart_rate": vitals.heart_rate,
            "blood_pressure": vitals.blood_pressure_display,
            "oxygen_saturation": vitals.oxygen_saturation,
            "respiratory_rate": vitals.respiratory_rate,
            "notes": vitals.notes,
        },
        commit=False,
    )

    # 6. Update Handover Packet if exists
    if dispatch.handover_packet:
        generate_or_update_handover_packet(dispatch, db, commit=False)

    db.commit()
    db.refresh(vitals)

    # 7. Live WebSocket broadcast
    broadcast_sync(
        "PATIENT_VITALS_RECORDED",
        {
            "dispatch_id": dispatch.id,
            "incident_id": dispatch.incident_id,
            "vitals_id": vitals.id,
            "heart_rate": vitals.heart_rate,
            "blood_pressure_systolic": vitals.blood_pressure_systolic,
            "blood_pressure_diastolic": vitals.blood_pressure_diastolic,
            "blood_pressure_display": vitals.blood_pressure_display,
            "oxygen_saturation": vitals.oxygen_saturation,
            "respiratory_rate": vitals.respiratory_rate,
            "notes": vitals.notes,
            "recorded_at": vitals.recorded_at.isoformat(),
        },
        ambulance_id=dispatch.ambulance_id,
        hospital_id=dispatch.destination_hospital_id,
        entity_type="patient_vitals",
        entity_id=vitals.id,
    )

    return vitals


@router.get("/{dispatch_id}/vitals", response_model=List[VitalsOut])
def list_patient_vitals(
    dispatch_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Retrieves all recorded patient vital signs for a dispatch, ordered by newest first.
    """
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_AMBULANCE_CREW and auth_user.ambulance_id and dispatch.ambulance_id != auth_user.ambulance_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: Cannot view vitals for another ambulance unit",
            )
        if auth_user.role == ROLE_HOSPITAL_STAFF and auth_user.hospital_id and dispatch.destination_hospital_id != auth_user.hospital_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: Cannot view vitals for another hospital destination",
            )

    return (
        db.query(PatientVitals)
        .filter(PatientVitals.dispatch_id == dispatch_id)
        .order_by(PatientVitals.recorded_at.desc())
        .all()
    )


@router.get("/{dispatch_id}/vitals/latest", response_model=Optional[VitalsOut])
def get_latest_patient_vitals(
    dispatch_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Retrieves the most recent patient vital signs reading for a dispatch.
    """
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_AMBULANCE_CREW and auth_user.ambulance_id and dispatch.ambulance_id != auth_user.ambulance_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: Cannot view vitals for another ambulance unit",
            )
        if auth_user.role == ROLE_HOSPITAL_STAFF and auth_user.hospital_id and dispatch.destination_hospital_id != auth_user.hospital_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: Cannot view vitals for another hospital destination",
            )

    return (
        db.query(PatientVitals)
        .filter(PatientVitals.dispatch_id == dispatch_id)
        .order_by(PatientVitals.recorded_at.desc())
        .first()
    )

@router.get("/{dispatch_id}/handover", response_model=HandoverPacketOut)
def get_handover_packet(
    dispatch_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
    request: Request = None,
):
    """
    FEATURE 3 — EMERGENCY HANDOVER PACKET:
    Retrieves the persistent handover packet for a dispatch.
    Returns 404 if dispatch does not exist or if dual confirmation has not yet occurred.
    Access Control:
      - Blocked for unauthenticated HTTP requests.
      - Citizens are strictly forbidden from clinical SBAR packets.
      - Paramedics restricted to their assigned ambulance.
      - Hospital staff restricted to their own facility.
    """
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if request is not None and auth_user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required to inspect clinical handover packets.",
        )
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: Clinical SBAR handover packets are strictly confidential and restricted to paramedics, hospital ER staff, and regional dispatchers.",
            )
        elif auth_user.role == ROLE_HOSPITAL_STAFF:
            if not auth_user.hospital_id or dispatch.destination_hospital_id != auth_user.hospital_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Hospital staff can only view handover packets routed to their own facility")
        elif auth_user.role == ROLE_AMBULANCE_CREW:
            if auth_user.ambulance_id and dispatch.ambulance_id != auth_user.ambulance_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Ambulance crew can only view handover packets for their own assigned ambulance unit")

    if dispatch.coordination_status != "CONFIRMED" and not dispatch.handover_packet:
        raise HTTPException(
            status_code=404,
            detail="Emergency Handover Packet not found. Handover packets are generated only after dual confirmation (ambulance and hospital acceptance)."
        )

    packet = dispatch.handover_packet
    if not packet and dispatch.coordination_status == "CONFIRMED":
        packet = generate_or_update_handover_packet(dispatch, db)

    return packet

@router.post("/{dispatch_id}/handover/acknowledge", response_model=HandoverPacketOut)
def acknowledge_handover_packet(
    dispatch_id: int,
    payload: Optional[HandoverAcknowledgeRequest] = None,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    FEATURE 3 — EMERGENCY HANDOVER PACKET (Strictly Idempotent & Concurrency Safe):
    Receiving hospital ER acknowledges intake of the digital handover packet.
    If already acknowledged, returns existing record immediately without updating timestamps.
    First caller sets definitive timestamp and staff identity.
    """
    begin_immediate_if_sqlite(db)

    disp_query = db.query(Dispatch).filter(Dispatch.id == dispatch_id).execution_options(populate_existing=True)
    if is_postgres(db):
        disp_query = disp_query.with_for_update()
    dispatch = disp_query.first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Citizens cannot acknowledge hospital emergency handover packets")
        if auth_user.role == ROLE_AMBULANCE_CREW:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Ambulance crew cannot acknowledge hospital intake handover packets. This action is reserved for hospital ER staff.")
        if auth_user.role == ROLE_HOSPITAL_STAFF:
            if not auth_user.hospital_id or dispatch.destination_hospital_id != auth_user.hospital_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Hospital staff can only acknowledge handover packets for their own receiving facility")

    packet_query = db.query(HandoverPacket).filter(HandoverPacket.dispatch_id == dispatch_id).execution_options(populate_existing=True)
    if is_postgres(db):
        packet_query = packet_query.with_for_update()
    packet = packet_query.first()

    if not packet:
        if dispatch.coordination_status == "CONFIRMED":
            packet = generate_or_update_handover_packet(dispatch, db, commit=False)
        else:
            raise HTTPException(
                status_code=400,
                detail="Cannot acknowledge handover: packet not yet generated (requires dual confirmation)."
            )

    # Strictly Idempotent: If already acknowledged, return existing packet immediately
    if packet.status in ["ACKNOWLEDGED", "COMPLETED"]:
        if payload and payload.receiving_notes and not packet.receiving_notes:
            packet.receiving_notes = payload.receiving_notes
            db.commit()
            db.refresh(packet)
        return packet

    now = get_utc_now()
    packet.status = "ACKNOWLEDGED"
    packet.acknowledged_at = now
    packet.acknowledged_by = (payload and payload.acknowledged_by) or "Receiving Hospital ER Intake (Staff)"
    if payload and payload.receiving_clinician:
        packet.receiving_clinician = payload.receiving_clinician
    if payload and payload.receiving_notes:
        packet.receiving_notes = payload.receiving_notes
    packet.updated_at = now

    log_incident_event(
        db=db,
        incident_id=dispatch.incident_id,
        dispatch_id=dispatch.id,
        event_type="HANDOVER_ACKNOWLEDGED",
        event_title="Hospital ER Acknowledged Handover",
        event_description=f"Pre-arrival clinical handover packet acknowledged by {packet.acknowledged_by}.",
        actor_type="HOSPITAL_ER",
        actor_reference=packet.acknowledged_by,
        metadata={"packet_id": packet.id, "acknowledged_by": packet.acknowledged_by},
        commit=False,
    )

    db.commit()
    db.refresh(packet)

    inc = db.query(Incident).filter(Incident.id == dispatch.incident_id).first()
    broadcast_sync(
        "HANDOVER_ACKNOWLEDGED",
        {
            "dispatch_id": dispatch.id,
            "incident_id": dispatch.incident_id,
            "packet_id": packet.id,
            "status": packet.status,
            "acknowledged_at": packet.acknowledged_at.isoformat() if packet.acknowledged_at else None,
            "acknowledged_by": packet.acknowledged_by,
            "receiving_clinician": packet.receiving_clinician,
            "receiving_notes": packet.receiving_notes,
        },
        ambulance_id=dispatch.ambulance_id,
        hospital_id=dispatch.destination_hospital_id,
        reporter_user_id=inc.reporter_user_id if inc else None,
        entity_type="handover_packet",
        entity_id=packet.id,
    )

    return packet

@router.post("/{dispatch_id}/handover/review", response_model=HandoverPacketOut)
def review_handover_packet(
    dispatch_id: int,
    payload: Optional[HandoverReviewRequest] = None,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Hospital clinical triage reviews incoming SBAR handover information prior to ambulance arrival.
    """
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Citizens cannot review clinical handover packets")
        if auth_user.role == ROLE_HOSPITAL_STAFF and (not auth_user.hospital_id or dispatch.destination_hospital_id != auth_user.hospital_id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied: Cannot review handover for another hospital facility")

    packet = dispatch.handover_packet
    if not packet and dispatch.coordination_status == "CONFIRMED":
        packet = generate_or_update_handover_packet(dispatch, db, commit=False)

    if not packet:
        raise HTTPException(status_code=404, detail="Handover packet not found")

    now = get_utc_now()
    if packet.status in ["SENT", "PENDING", "NOT_RECEIVED"]:
        packet.status = "REVIEWED"
    packet.reviewed_at = now
    if payload:
        if payload.reviewed_by:
            packet.receiving_clinician = payload.reviewed_by
        if payload.receiving_notes:
            packet.receiving_notes = payload.receiving_notes
    packet.updated_at = now
    db.commit()
    db.refresh(packet)

    broadcast_sync(
        "HANDOVER_REVIEWED",
        {
            "dispatch_id": dispatch.id,
            "packet_id": packet.id,
            "status": packet.status,
            "reviewed_at": packet.reviewed_at.isoformat() if packet.reviewed_at else None,
            "receiving_clinician": packet.receiving_clinician,
            "receiving_notes": packet.receiving_notes,
        },
        hospital_id=dispatch.destination_hospital_id,
        ambulance_id=dispatch.ambulance_id,
        entity_type="handover_packet",
        entity_id=packet.id,
    )
    return packet

@router.post("/{dispatch_id}/handover/complete", response_model=HandoverPacketOut)
def complete_handover_packet(
    dispatch_id: int,
    payload: Optional[HandoverCompleteRequest] = None,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Hospital ER completes receiving workflow and formal clinician sign-off.
    """
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Citizens cannot complete clinical handover")
        if auth_user.role == ROLE_HOSPITAL_STAFF and (not auth_user.hospital_id or dispatch.destination_hospital_id != auth_user.hospital_id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied: Cannot complete handover for another hospital facility")

    packet = dispatch.handover_packet
    if not packet and dispatch.coordination_status == "CONFIRMED":
        packet = generate_or_update_handover_packet(dispatch, db, commit=False)

    if not packet:
        raise HTTPException(status_code=404, detail="Handover packet not found")

    now = get_utc_now()
    packet.status = "COMPLETED"
    packet.completed_at = now
    if payload:
        if payload.completed_by:
            packet.receiving_clinician = payload.completed_by
        if payload.receiving_notes:
            packet.receiving_notes = payload.receiving_notes
    packet.updated_at = now
    db.commit()
    db.refresh(packet)

    broadcast_sync(
        "HANDOVER_COMPLETED",
        {
            "dispatch_id": dispatch.id,
            "packet_id": packet.id,
            "status": packet.status,
            "completed_at": packet.completed_at.isoformat() if packet.completed_at else None,
            "receiving_clinician": packet.receiving_clinician,
            "receiving_notes": packet.receiving_notes,
        },
        hospital_id=dispatch.destination_hospital_id,
        ambulance_id=dispatch.ambulance_id,
        entity_type="handover_packet",
        entity_id=packet.id,
    )
    return packet

@router.patch("/{dispatch_id}/preparation", response_model=DispatchOut)
def update_hospital_preparation(
    dispatch_id: int,
    payload: HospitalPreparationUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Citizens cannot update hospital preparation")
        if auth_user.role == ROLE_AMBULANCE_CREW:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Ambulance crew cannot update hospital ER preparation")
        if auth_user.role == ROLE_HOSPITAL_STAFF:
            if not auth_user.hospital_id or dispatch.destination_hospital_id != auth_user.hospital_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied: Cannot update preparation for another hospital facility")

    valid_prep = ["NOT_STARTED", "TEAM_NOTIFIED", "BAY_PREPARED", "SPECIALISTS_STANDBY", "READY_FOR_ARRIVAL"]
    if payload.preparation_status not in valid_prep:
        raise HTTPException(status_code=400, detail=f"Invalid preparation status '{payload.preparation_status}'. Valid: {valid_prep}")

    dispatch.hospital_preparation_status = payload.preparation_status
    if payload.preparation_notes:
        existing = dispatch.hospital_preparation_notes or ""
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        entry = f"[{ts}] {payload.preparation_notes}"
        dispatch.hospital_preparation_notes = f"{existing}\n{entry}".strip()

    if not dispatch.hospital_acknowledged_at:
        dispatch.hospital_acknowledged_at = get_utc_now()

    db.commit()
    db.refresh(dispatch)

    log_incident_event(
        db=db,
        incident_id=dispatch.incident_id,
        dispatch_id=dispatch.id,
        event_type="HOSPITAL_PREPARATION_UPDATED",
        event_title="Hospital Emergency Preparation Updated",
        event_description=f"Receiving hospital updated status to '{payload.preparation_status}'.",
        actor_type="HOSPITAL_ER",
        actor_reference=payload.acknowledged_by or (auth_user.email if auth_user else "Hospital ER Staff"),
        metadata={
            "dispatch_id": dispatch.id,
            "preparation_status": dispatch.hospital_preparation_status,
            "preparation_notes": dispatch.hospital_preparation_notes,
        },
    )

    inc = db.query(Incident).filter(Incident.id == dispatch.incident_id).first()
    broadcast_sync(
        "HOSPITAL_PREPARATION_UPDATED",
        {
            "dispatch_id": dispatch.id,
            "incident_id": dispatch.incident_id,
            "destination_hospital_id": dispatch.destination_hospital_id,
            "hospital_preparation_status": dispatch.hospital_preparation_status,
            "hospital_preparation_notes": dispatch.hospital_preparation_notes,
            "hospital_acknowledged_at": dispatch.hospital_acknowledged_at.isoformat() if dispatch.hospital_acknowledged_at else None,
        },
        ambulance_id=dispatch.ambulance_id,
        hospital_id=dispatch.destination_hospital_id,
        reporter_user_id=inc.reporter_user_id if inc else None,
        entity_type="dispatch",
        entity_id=dispatch.id,
    )

    return dispatch

@router.post("/{dispatch_id}/confirm-arrival", response_model=DispatchOut)
def confirm_patient_arrival_at_hospital(
    dispatch_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Citizens cannot confirm hospital patient arrival")
        if auth_user.role == ROLE_HOSPITAL_STAFF:
            if not auth_user.hospital_id or dispatch.destination_hospital_id != auth_user.hospital_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied: Cannot confirm arrival for another hospital facility")

    now = get_utc_now()
    dispatch.patient_arrived_hospital_confirmed_at = now
    if not dispatch.arrived_hospital_at:
        dispatch.arrived_hospital_at = now

    if dispatch.status in ["ASSIGNED", "EN_ROUTE", "EN_ROUTE_INCIDENT", "ON_SCENE", "TRANSPORTING", "EN_ROUTE_HOSPITAL"]:
        dispatch.status = "AT_HOSPITAL"

    incident = db.query(Incident).filter(Incident.id == dispatch.incident_id).first()
    if incident and incident.status in ["REPORTED", "TRIAGED", "ALLOCATED", "DISPATCHED", "EN_ROUTE", "ON_SCENE", "TRANSPORTING"]:
        incident.status = "AT_HOSPITAL"

    # Synchronize bed reservation
    if dispatch.destination_hospital_id:
        hosp_query = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id)
        if is_postgres(db):
            hosp_query = hosp_query.with_for_update()
        hospital = hosp_query.first()
        if hospital and (hospital.reserved_emergency_beds or 0) > 0:
            hospital.reserved_emergency_beds = max(0, hospital.reserved_emergency_beds - 1)

    db.commit()
    db.refresh(dispatch)

    log_incident_event(
        db=db,
        incident_id=dispatch.incident_id,
        dispatch_id=dispatch.id,
        event_type="PATIENT_ARRIVED_HOSPITAL",
        event_title="Patient Arrived at Hospital ER",
        event_description="Emergency department confirmed patient arrival and reception into trauma bay.",
        actor_type="HOSPITAL_ER",
        actor_reference=auth_user.email if auth_user else "Hospital ER Staff",
        metadata={
            "dispatch_id": dispatch.id,
            "confirmed_at": now.isoformat(),
        },
    )

    broadcast_sync(
        "PATIENT_ARRIVED_HOSPITAL",
        {
            "dispatch_id": dispatch.id,
            "incident_id": dispatch.incident_id,
            "destination_hospital_id": dispatch.destination_hospital_id,
            "status": dispatch.status,
            "patient_arrived_hospital_confirmed_at": now.isoformat(),
        },
        ambulance_id=dispatch.ambulance_id,
        hospital_id=dispatch.destination_hospital_id,
        reporter_user_id=incident.reporter_user_id if incident else None,
        entity_type="dispatch",
        entity_id=dispatch.id,
    )

    return dispatch

@router.post("/{dispatch_id}/confirm-patient-pickup", response_model=DispatchOut)
def confirm_patient_pickup(
    dispatch_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Driver explicitly confirms that the patient is physically inside the ambulance
    and secured for transport. Advances the dispatch status to EN_ROUTE_HOSPITAL,
    marks incident and ambulance as TRANSPORTING, calculates the hospital route,
    logs the PATIENT_PICKED_UP event, and broadcasts real-time updates.
    """
    begin_immediate_if_sqlite(db)
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Citizens cannot confirm patient pickup")
        if auth_user.role == ROLE_AMBULANCE_CREW and auth_user.ambulance_id != dispatch.ambulance_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied: Cannot confirm patient pickup for another unit")

    if dispatch.status != "ON_SCENE":
        raise HTTPException(
            status_code=400,
            detail=f"Cannot confirm patient pickup: Unit must be ON_SCENE (current status: '{dispatch.status}').",
        )

    now = get_utc_now()
    dispatch.status = "EN_ROUTE_HOSPITAL"
    dispatch.departed_incident_at = now

    incident = db.query(Incident).filter(Incident.id == dispatch.incident_id).first()
    ambulance = db.query(Ambulance).filter(Ambulance.id == dispatch.ambulance_id).first()

    if incident:
        incident.status = "TRANSPORTING"
    if ambulance:
        ambulance.status = "TRANSPORTING"

    # Calculate and attach route to destination hospital
    if dispatch.destination_hospital_id and incident:
        hospital = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id).first()
        if hospital:
            h_route = calculate_route(
                start_lat=incident.latitude,
                start_lon=incident.longitude,
                dest_lat=hospital.latitude,
                dest_lon=hospital.longitude,
            )
            dispatch.route_geometry = h_route.get("geometry", [])
            dispatch.estimated_eta_seconds = h_route.get("duration_seconds")
            dispatch.route_distance_meters = h_route.get("distance_meters")

    log_incident_event(
        db=db,
        incident_id=dispatch.incident_id,
        dispatch_id=dispatch.id,
        event_type="PATIENT_PICKED_UP",
        event_title="Patient Picked Up On Scene",
        event_description=f"Ambulance crew {ambulance.call_sign if ambulance else 'unit'} confirmed patient is safely boarded and departing towards {dispatch.destination_hospital_name or 'the hospital'}.",
        actor_type="AMBULANCE_CREW",
        actor_reference=ambulance.call_sign if ambulance else "Unit Crew",
        metadata={"status": dispatch.status, "hospital_id": dispatch.destination_hospital_id},
        commit=False,
    )

    if dispatch.handover_packet:
        generate_or_update_handover_packet(dispatch, db, commit=False)

    db.commit()
    db.refresh(dispatch)

    broadcast_sync(
        "PATIENT_PICKED_UP",
        {
            "dispatch_id": dispatch.id,
            "incident_id": dispatch.incident_id,
            "ambulance_id": dispatch.ambulance_id,
            "destination_hospital_id": dispatch.destination_hospital_id,
            "status": dispatch.status,
            "incident_status": incident.status if incident else "TRANSPORTING",
            "ambulance_status": ambulance.status if ambulance else "TRANSPORTING",
            "estimated_eta_seconds": dispatch.estimated_eta_seconds,
        },
        ambulance_id=dispatch.ambulance_id,
        hospital_id=dispatch.destination_hospital_id,
        reporter_user_id=incident.reporter_user_id if incident else None,
        entity_type="dispatch",
        entity_id=dispatch.id,
    )

    return dispatch

@router.post("/{dispatch_id}/request-assistance")
def request_mission_assistance(
    dispatch_id: int,
    payload: Optional[MissionAssistanceRequest] = None,
    assistance_type: Optional[str] = None,
    notes: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Paramedic crew requests operational assistance (Police backup, Fire rescue, or Dispatcher callback).
    """
    final_type = (payload.assistance_type if payload and payload.assistance_type else assistance_type) or "CONTROL_ROOM"
    final_notes = (payload.notes if payload and payload.notes is not None else notes)

    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    ambulance = db.query(Ambulance).filter(Ambulance.id == dispatch.ambulance_id).first()

    log_incident_event(
        db=db,
        incident_id=dispatch.incident_id,
        dispatch_id=dispatch.id,
        event_type="ASSISTANCE_REQUESTED",
        event_title=f"Operational Assistance Requested: {final_type.replace('_', ' ').title()}",
        event_description=f"Ambulance {ambulance.call_sign if ambulance else 'crew'} requested {final_type}. Notes: {final_notes or 'Immediate assistance requested on active mission.'}",
        actor_type="AMBULANCE_CREW",
        actor_reference=ambulance.call_sign if ambulance else "Unit Crew",
        metadata={"dispatch_id": dispatch.id, "assistance_type": final_type, "notes": final_notes},
    )

    broadcast_sync(
        "ASSISTANCE_REQUESTED",
        {
            "dispatch_id": dispatch.id,
            "incident_id": dispatch.incident_id,
            "ambulance_id": dispatch.ambulance_id,
            "call_sign": ambulance.call_sign if ambulance else None,
            "assistance_type": final_type,
            "notes": final_notes,
        },
        ambulance_id=dispatch.ambulance_id,
        hospital_id=dispatch.destination_hospital_id,
        entity_type="assistance_request",
        entity_id=dispatch.id,
    )

    return {"status": "ok", "message": f"Assistance request for {final_type} transmitted to Control Room"}

@router.post("/{dispatch_id}/request-alternative-ambulance", response_model=DispatchOut)
def request_alternative_ambulance(
    dispatch_id: int,
    payload: AlternativeAmbulanceRequest,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Hospital staff action: Arrange/Request Alternative Ambulance unit
    (e.g., when a crash/collision alert is detected on transit route,
    or the assigned unit is delayed/immobilized, or patient needs higher care level).
    Sends request to Dispatcher, records audit event, and flags dispatch.
    """
    begin_immediate_if_sqlite(db)
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user and auth_user.role == ROLE_CITIZEN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Citizens cannot request alternative ambulances")

    hospital_id = payload.hospital_id or dispatch.destination_hospital_id
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first() if hospital_id else None
    ambulance = db.query(Ambulance).filter(Ambulance.id == dispatch.ambulance_id).first() if dispatch.ambulance_id else None

    dispatch.alternative_ambulance_requested = True
    dispatch.alternative_ambulance_reason = payload.reason
    now = get_utc_now()

    # Append to escalation history
    history = list(dispatch.escalation_history or [])
    history.append({
        "event": "ALTERNATIVE_AMBULANCE_REQUESTED",
        "requested_by": auth_user.full_name if auth_user else "Hospital Medical Staff",
        "role": auth_user.role if auth_user else "HOSPITAL_STAFF",
        "hospital_id": hospital.id if hospital else None,
        "hospital_name": hospital.name if hospital else "Receiving Hospital",
        "reason": payload.reason,
        "notes": payload.notes,
        "timestamp": now.isoformat(),
    })
    dispatch.escalation_history = history

    log_incident_event(
        db=db,
        incident_id=dispatch.incident_id,
        dispatch_id=dispatch.id,
        event_type="ALTERNATIVE_AMBULANCE_REQUESTED",
        event_title="Alternative Ambulance Requested by Hospital",
        event_description=f"Hospital {hospital.name if hospital else 'ER'} requested alternative ambulance unit for dispatch #{dispatch.id} (Current: {ambulance.call_sign if ambulance else 'Unit'}). Reason: {payload.reason}. Notes: {payload.notes or 'None'}",
        actor_type=auth_user.role if auth_user else "HOSPITAL_STAFF",
        actor_reference=auth_user.full_name if auth_user else (hospital.name if hospital else "Hospital Staff"),
        metadata={
            "dispatch_id": dispatch.id,
            "hospital_id": hospital.id if hospital else None,
            "reason": payload.reason,
            "notes": payload.notes,
        },
        commit=False,
    )

    db.commit()
    db.refresh(dispatch)

    broadcast_sync(
        "ALTERNATIVE_AMBULANCE_REQUESTED",
        {
            "dispatch_id": dispatch.id,
            "incident_id": dispatch.incident_id,
            "ambulance_id": dispatch.ambulance_id,
            "current_call_sign": ambulance.call_sign if ambulance else None,
            "destination_hospital_id": dispatch.destination_hospital_id,
            "hospital_name": hospital.name if hospital else None,
            "reason": payload.reason,
            "notes": payload.notes,
            "timestamp": now.isoformat(),
        },
        ambulance_id=dispatch.ambulance_id,
        hospital_id=dispatch.destination_hospital_id,
        entity_type="alternative_ambulance_request",
        entity_id=dispatch.id,
    )

    return dispatch


@router.post("/{dispatch_id}/patient-not-picked-up", response_model=DispatchOut)
def record_patient_not_picked_up(
    dispatch_id: int,
    payload: PatientNotPickedUpRequest,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Paramedic crew explicitly records that the patient was NOT picked up on scene
    (e.g., patient refused transport AMA, patient deceased on scene, gone on arrival,
    treated on scene without transport needed, cancelled by police).
    Safely terminates the mission without starting transport:
      - Sets dispatch status to CANCELLED
      - Marks patient_pickup_status = "NOT_PICKED_UP"
      - Records patient_pickup_failure_reason = payload.reason
      - Releases assigned ambulance back to AVAILABLE
      - Releases hospital provisional bed reservation if any
      - Updates incident status to RESOLVED or CANCELLED with clinical notes
      - Logs PATIENT_NOT_PICKED_UP audit event
      - Broadcasts real-time WebSocket update
    """
    begin_immediate_if_sqlite(db)
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Citizens cannot record patient pickup status")
        if auth_user.role == ROLE_AMBULANCE_CREW and auth_user.ambulance_id != dispatch.ambulance_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied: Cannot record pickup status for another unit")

    if dispatch.status != "ON_SCENE":
        raise HTTPException(
            status_code=400,
            detail=f"Cannot record patient not picked up: Unit must be ON_SCENE (current status: '{dispatch.status}').",
        )

    now = get_utc_now()
    dispatch.status = "CANCELLED"
    dispatch.completed_at = now
    dispatch.patient_pickup_status = "NOT_PICKED_UP"
    dispatch.patient_pickup_failure_reason = payload.reason
    dispatch.rejection_reason = f"Patient Not Picked Up: {payload.reason} ({payload.notes or 'No additional notes'})"

    incident = db.query(Incident).filter(Incident.id == dispatch.incident_id).first()
    ambulance = db.query(Ambulance).filter(Ambulance.id == dispatch.ambulance_id).first()

    # Free ambulance back to AVAILABLE
    if ambulance:
        ambulance.status = "AVAILABLE"
        ambulance.reservation_dispatch_id = None

    # Free reserved hospital emergency bed
    if dispatch.destination_hospital_id:
        hospital = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id).first()
        if hospital and (hospital.reserved_emergency_beds or 0) > 0:
            hospital.reserved_emergency_beds = max(0, hospital.reserved_emergency_beds - 1)

    # Determine incident outcome status
    if incident:
        if "Treated at Scene" in payload.reason:
            incident.status = "RESOLVED"
        else:
            incident.status = "CANCELLED"

    log_incident_event(
        db=db,
        incident_id=dispatch.incident_id,
        dispatch_id=dispatch.id,
        event_type="PATIENT_NOT_PICKED_UP",
        event_title="Patient Not Picked Up On Scene",
        event_description=f"Ambulance {ambulance.call_sign if ambulance else 'crew'} recorded: Patient Not Picked Up. Reason: {payload.reason}. Notes: {payload.notes or 'None'}. Transport to hospital aborted.",
        actor_type="AMBULANCE_CREW",
        actor_reference=ambulance.call_sign if ambulance else "Unit Crew",
        metadata={
            "dispatch_id": dispatch.id,
            "reason": payload.reason,
            "notes": payload.notes,
            "incident_status": incident.status if incident else None,
        },
        commit=False,
    )

    db.commit()
    db.refresh(dispatch)

    broadcast_sync(
        "PATIENT_NOT_PICKED_UP",
        {
            "dispatch_id": dispatch.id,
            "incident_id": dispatch.incident_id,
            "ambulance_id": dispatch.ambulance_id,
            "destination_hospital_id": dispatch.destination_hospital_id,
            "status": dispatch.status,
            "patient_pickup_status": "NOT_PICKED_UP",
            "reason": payload.reason,
            "incident_status": incident.status if incident else "CANCELLED",
            "ambulance_status": "AVAILABLE",
        },
        ambulance_id=dispatch.ambulance_id,
        hospital_id=dispatch.destination_hospital_id,
        reporter_user_id=incident.reporter_user_id if incident else None,
        entity_type="dispatch",
        entity_id=dispatch.id,
    )

    return dispatch

@router.get("/route/preview")
def preview_route(
    start_lat: float,
    start_lon: float,
    dest_lat: float,
    dest_lon: float,
):
    return calculate_route(start_lat, start_lon, dest_lat, dest_lon)
