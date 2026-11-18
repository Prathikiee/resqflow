from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.models.entities import Hospital, User
from backend.app.schemas.hospital import HospitalOut, HospitalCapacityUpdate
from backend.app.core.auth import (
    get_optional_current_user,
    ROLE_HOSPITAL_STAFF,
    ROLE_DISPATCHER,
    ROLE_SUPER_ADMIN,
)
from backend.app.core.ws import broadcast_sync

router = APIRouter(prefix="/api/hospitals", tags=["hospitals"])

@router.get("", response_model=List[HospitalOut])
def list_hospitals(accepting_only: bool = False, db: Session = Depends(get_db)):
    """
    Returns registered hospitals in Mangaluru with live bed capacity and department specialties.
    """
    query = db.query(Hospital)
    if accepting_only:
        query = query.filter(Hospital.accepting_emergencies == True)
    return query.order_by(Hospital.available_emergency_beds.desc()).all()

@router.get("/{hospital_id}", response_model=HospitalOut)
def get_hospital(hospital_id: int, db: Session = Depends(get_db)):
    h = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not h:
        raise HTTPException(status_code=404, detail="Hospital not found")
    return h

@router.patch("/{hospital_id}/capacity", response_model=HospitalOut)
def update_hospital_capacity(
    hospital_id: int,
    payload: HospitalCapacityUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Allows hospital ER triage staff (for their assigned facility) or regional dispatchers
    to update emergency bed capacity and emergency intake availability status.
    """
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if not auth_user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required to update hospital capacity",
        )
    if auth_user.role == ROLE_HOSPITAL_STAFF:
        if auth_user.hospital_id != hospital_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: Hospital staff can only update capacity for their own assigned facility",
            )
    elif auth_user.role not in [ROLE_DISPATCHER, ROLE_SUPER_ADMIN]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: Insufficient permissions to update hospital bed capacity",
        )

    if payload.available_emergency_beds is not None:
        hospital.available_emergency_beds = max(0, payload.available_emergency_beds)
    if payload.available_icu_beds is not None:
        hospital.available_icu_beds = max(0, payload.available_icu_beds)
    if payload.available_ward_beds is not None:
        hospital.available_ward_beds = max(0, payload.available_ward_beds)
    if payload.readiness_status is not None:
        r_upper = payload.readiness_status.upper().strip()
        if r_upper in ["READY", "BUSY", "DIVERT"]:
            hospital.readiness_status = r_upper
            if r_upper == "DIVERT":
                hospital.accepting_emergencies = False
            elif payload.accepting_emergencies is None:
                hospital.accepting_emergencies = True
    if payload.accepting_emergencies is not None:
        hospital.accepting_emergencies = payload.accepting_emergencies
    if payload.doctors_availability is not None:
        hospital.doctors_availability = payload.doctors_availability
    if payload.updated_by_name:
        hospital.last_updated_by = payload.updated_by_name
    elif auth_user and auth_user.full_name:
        hospital.last_updated_by = auth_user.full_name

    db.commit()
    db.refresh(hospital)

    broadcast_sync(
        "HOSPITAL_CAPACITY_UPDATED",
        {
            "hospital_id": hospital.id,
            "facility_code": hospital.facility_code,
            "name": hospital.name,
            "available_emergency_beds": hospital.available_emergency_beds,
            "reserved_emergency_beds": hospital.reserved_emergency_beds,
            "available_icu_beds": hospital.available_icu_beds,
            "available_ward_beds": hospital.available_ward_beds,
            "readiness_status": hospital.readiness_status,
            "accepting_emergencies": hospital.accepting_emergencies,
            "doctors_availability": hospital.doctors_availability,
            "last_updated_by": hospital.last_updated_by,
        },
        hospital_id=hospital.id,
        entity_type="hospital",
        entity_id=hospital.id,
    )

    return hospital
