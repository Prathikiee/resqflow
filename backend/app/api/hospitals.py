from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.models.entities import Hospital
from backend.app.schemas.hospital import HospitalOut

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
