from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.models.entities import Incident, Ambulance, Hospital, Dispatch
from backend.app.schemas.dispatch import DispatchRequest, DispatchOut
from backend.app.services.allocation_engine import score_and_rank_ambulances
from backend.app.services.hospital_engine import rank_suitable_hospitals
from backend.app.services.routing_service import calculate_route
from backend.app.core.ws import broadcast_sync

router = APIRouter(prefix="/api/dispatch", tags=["dispatch"])

def get_utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)

@router.get("/recommend/{incident_id}")
def get_dispatch_recommendation(incident_id: int, db: Session = Depends(get_db)):
    """
    Executes the intelligence core for an incident:
      1. Multi-factor ambulance allocation (filtering + ranking + explainability).
      2. Hospital suitability ranking (specialty, ICU beds, transit time).
    """
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
    """
    Executes dispatch creation:
      - Validates incident and ambulance.
      - Calculates initial ambulance-to-incident route and ETA.
      - Updates ambulance status to DISPATCHED.
      - Updates incident status to DISPATCHED.
      - Persists dispatch with full allocation breakdown and route geometry.
    """
    incident = db.query(Incident).filter(Incident.id == payload.incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")

    ambulance = db.query(Ambulance).filter(Ambulance.id == payload.ambulance_id).first()
    if not ambulance:
        raise HTTPException(status_code=404, detail="Ambulance unit not found")

    # Check for duplicate active dispatch on this incident
    active_disp = db.query(Dispatch).filter(
        Dispatch.incident_id == incident.id,
        Dispatch.status.notin_(["COMPLETED", "CANCELLED"]),
    ).first()
    if active_disp:
        raise HTTPException(
            status_code=400,
            detail=f"Incident #{incident.id} already has an active dispatch (#{active_disp.id} - status: {active_disp.status}). Duplicate dispatch rejected."
        )

    if ambulance.status != "AVAILABLE":
        raise HTTPException(
            status_code=400,
            detail=f"Ambulance {ambulance.call_sign} is currently '{ambulance.status}' and cannot be dispatched."
        )

    hospital = None
    if payload.destination_hospital_id:
        hospital = db.query(Hospital).filter(Hospital.id == payload.destination_hospital_id).first()

    # Calculate route from ambulance base location to incident
    route = calculate_route(
        start_lat=ambulance.current_latitude,
        start_lon=ambulance.current_longitude,
        dest_lat=incident.latitude,
        dest_lon=incident.longitude,
    )

    # Evaluate multi-factor score for record
    all_ambs = db.query(Ambulance).all()
    scoring_result = score_and_rank_ambulances(incident=incident, ambulances=all_ambs)
    matched_candidate = next(
        (c for c in scoring_result["ranked_ambulances"] if c["ambulance_id"] == ambulance.id),
        None
    )

    dispatch = Dispatch(
        incident_id=incident.id,
        ambulance_id=ambulance.id,
        destination_hospital_id=hospital.id if hospital else None,
        status="ASSIGNED",
        dispatched_at=get_utc_now(),
        estimated_eta_seconds=route["duration_seconds"],
        route_distance_meters=route["distance_meters"],
        allocation_score=matched_candidate["total_score"] if matched_candidate else 75.0,
    )
    dispatch.allocation_breakdown = matched_candidate["score_breakdown"] if matched_candidate else {}
    dispatch.route_geometry = route["geometry"]

    # Update states
    ambulance.status = "DISPATCHED"
    incident.status = "DISPATCHED"

    db.add(dispatch)
    db.commit()
    db.refresh(dispatch)

    broadcast_sync("DISPATCH_CREATED", {
        "dispatch_id": dispatch.id,
        "incident_id": incident.id,
        "ambulance_id": ambulance.id,
        "status": dispatch.status,
    })

    return dispatch

@router.get("", response_model=List[DispatchOut])
def list_dispatches(db: Session = Depends(get_db)):
    return db.query(Dispatch).order_by(Dispatch.created_at.desc()).all()

@router.get("/{dispatch_id}", response_model=DispatchOut)
def get_dispatch(dispatch_id: int, db: Session = Depends(get_db)):
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch record not found")
    return dispatch

@router.patch("/{dispatch_id}/step", response_model=DispatchOut)
def advance_dispatch_lifecycle(dispatch_id: int, db: Session = Depends(get_db)):
    """
    Advances dispatch lifecycle through standard operational sequence:
    ASSIGNED -> EN_ROUTE_INCIDENT -> ON_SCENE -> EN_ROUTE_HOSPITAL -> COMPLETED
    Synchronously updates parent Incident and Ambulance states.
    """
    dispatch = db.query(Dispatch).filter(Dispatch.id == dispatch_id).first()
    if not dispatch:
        raise HTTPException(status_code=404, detail="Dispatch not found")

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
        # Calculate actual response time in seconds
        delta = (now - dispatch.dispatched_at).total_seconds()
        dispatch.actual_response_seconds = round(delta, 1)
        if incident:
            incident.status = "ON_SCENE"
            # Update ambulance position to incident scene
            if ambulance:
                ambulance.status = "ON_SCENE"
                ambulance.current_latitude = incident.latitude
                ambulance.current_longitude = incident.longitude

    elif current_status == "ON_SCENE":
        dispatch.status = "EN_ROUTE_HOSPITAL"
        dispatch.departed_incident_at = now
        if incident: incident.status = "TRANSPORTING"
        if ambulance: ambulance.status = "TRANSPORTING"

        # If destination hospital is present, recompute route geometry to hospital
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
            if dispatch.destination_hospital_id:
                hospital = db.query(Hospital).filter(Hospital.id == dispatch.destination_hospital_id).first()
                if hospital:
                    ambulance.current_latitude = hospital.latitude
                    ambulance.current_longitude = hospital.longitude

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
    """
    Public route preview endpoint returning OSRM or fallback geometry and ETA.
    """
    return calculate_route(start_lat, start_lon, dest_lat, dest_lon)
