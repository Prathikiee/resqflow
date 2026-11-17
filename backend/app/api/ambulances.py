from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.models.entities import Ambulance
from backend.app.schemas.ambulance import AmbulanceOut, AmbulanceLocationUpdate

router = APIRouter(prefix="/api/ambulances", tags=["ambulances"])

@router.get("", response_model=List[AmbulanceOut])
def list_ambulances(status: Optional[str] = None, db: Session = Depends(get_db)):
    """
    Returns ambulance fleet across Mangaluru sector stations.
    Optionally filter by status (AVAILABLE, DISPATCHED, etc.).
    """
    query = db.query(Ambulance)
    if status:
        query = query.filter(Ambulance.status == status.upper().strip())
    return query.order_by(Ambulance.id.asc()).all()

@router.get("/{ambulance_id}", response_model=AmbulanceOut)
def get_ambulance(ambulance_id: int, db: Session = Depends(get_db)):
    amb = db.query(Ambulance).filter(Ambulance.id == ambulance_id).first()
    if not amb:
        raise HTTPException(status_code=404, detail="Ambulance unit not found")
    return amb

@router.patch("/{ambulance_id}/status", response_model=AmbulanceOut)
def update_ambulance_status(ambulance_id: int, status: str, db: Session = Depends(get_db)):
    amb = db.query(Ambulance).filter(Ambulance.id == ambulance_id).first()
    if not amb:
        raise HTTPException(status_code=404, detail="Ambulance unit not found")

    valid_statuses = ["AVAILABLE", "RESERVED", "DISPATCHED", "EN_ROUTE", "ON_SCENE", "TRANSPORTING", "MAINTENANCE", "OFF_DUTY"]
    s_upper = status.upper().strip()
    if s_upper not in valid_statuses:
        raise HTTPException(status_code=400, detail=f"Invalid ambulance status '{status}'. Valid: {valid_statuses}")

    amb.status = s_upper
    db.commit()
    db.refresh(amb)
    return amb

@router.patch("/{ambulance_id}/telemetry", response_model=AmbulanceOut)
def update_ambulance_telemetry(ambulance_id: int, payload: AmbulanceLocationUpdate, db: Session = Depends(get_db)):
    amb = db.query(Ambulance).filter(Ambulance.id == ambulance_id).first()
    if not amb:
        raise HTTPException(status_code=404, detail="Ambulance unit not found")

    amb.current_latitude = payload.latitude
    amb.current_longitude = payload.longitude
    if payload.status:
        amb.status = payload.status.upper().strip()

    db.commit()
    db.refresh(amb)
    return amb
