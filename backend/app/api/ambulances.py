from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.models.entities import Ambulance, User
from backend.app.schemas.ambulance import AmbulanceOut, AmbulanceLocationUpdate
from backend.app.core.auth import (
    get_optional_current_user,
    ROLE_AMBULANCE_CREW,
    ROLE_DISPATCHER,
    ROLE_SUPER_ADMIN,
)
from backend.app.core.ws import broadcast_sync

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
def update_ambulance_status(
    ambulance_id: int,
    status: str,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    amb = db.query(Ambulance).filter(Ambulance.id == ambulance_id).first()
    if not amb:
        raise HTTPException(status_code=404, detail="Ambulance unit not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_AMBULANCE_CREW:
            if auth_user.ambulance_id != ambulance_id:
                raise HTTPException(
                    status_code=403,
                    detail="Access denied: Paramedic crews can only update status for their own assigned unit",
                )
        elif auth_user.role not in [ROLE_DISPATCHER, ROLE_SUPER_ADMIN]:
            raise HTTPException(
                status_code=403,
                detail="Access denied: Insufficient permissions to update ambulance unit status",
            )

    valid_statuses = ["AVAILABLE", "RESERVED", "DISPATCHED", "EN_ROUTE", "ON_SCENE", "TRANSPORTING", "MAINTENANCE", "OFF_DUTY"]
    s_upper = status.upper().strip()
    if s_upper not in valid_statuses:
        raise HTTPException(status_code=400, detail=f"Invalid ambulance status '{status}'. Valid: {valid_statuses}")

    amb.status = s_upper
    db.commit()
    db.refresh(amb)

    broadcast_sync(
        "AMBULANCE_STATUS_UPDATED",
        {
            "ambulance_id": amb.id,
            "call_sign": amb.call_sign,
            "status": amb.status,
            "current_latitude": amb.current_latitude,
            "current_longitude": amb.current_longitude,
        },
        ambulance_id=amb.id,
        entity_type="ambulance",
        entity_id=amb.id,
    )

    return amb

@router.patch("/{ambulance_id}/telemetry", response_model=AmbulanceOut)
def update_ambulance_telemetry(
    ambulance_id: int,
    payload: AmbulanceLocationUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    amb = db.query(Ambulance).filter(Ambulance.id == ambulance_id).first()
    if not amb:
        raise HTTPException(status_code=404, detail="Ambulance unit not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_AMBULANCE_CREW:
            if auth_user.ambulance_id != ambulance_id:
                raise HTTPException(
                    status_code=403,
                    detail="Access denied: Paramedic crews can only update telemetry for their own assigned unit",
                )
        elif auth_user.role not in [ROLE_DISPATCHER, ROLE_SUPER_ADMIN]:
            raise HTTPException(
                status_code=403,
                detail="Access denied: Insufficient permissions to update ambulance telemetry",
            )

    amb.current_latitude = payload.latitude
    amb.current_longitude = payload.longitude
    if payload.status:
        amb.status = payload.status.upper().strip()

    db.commit()
    db.refresh(amb)

    broadcast_sync(
        "AMBULANCE_STATUS_UPDATED",
        {
            "ambulance_id": amb.id,
            "call_sign": amb.call_sign,
            "status": amb.status,
            "current_latitude": amb.current_latitude,
            "current_longitude": amb.current_longitude,
        },
        ambulance_id=amb.id,
        entity_type="ambulance",
        entity_id=amb.id,
    )

    return amb
