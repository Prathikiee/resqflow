from typing import List, Optional, Dict, Any
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.models.entities import Hospital, User, Dispatch, Incident
from backend.app.schemas.hospital import (
    HospitalOut,
    HospitalCapacityUpdate,
    HospitalBedsUpdate,
    HospitalReadinessUpdate,
    DoctorCreate,
    DoctorUpdate,
)
from backend.app.schemas.dispatch import DispatchOut
from backend.app.core.auth import (
    get_optional_current_user,
    ROLE_HOSPITAL_STAFF,
    ROLE_DISPATCHER,
    ROLE_SUPER_ADMIN,
    ROLE_AMBULANCE_CREW,
    ROLE_CITIZEN,
)
from backend.app.core.ws import broadcast_sync

router = APIRouter(prefix="/api/hospitals", tags=["hospitals"])

def verify_hospital_access(hospital_id: int, current_user: Optional[User], allow_public: bool = False):
    """
    STRICT HOSPITAL DATA ISOLATION:
    Hospital staff can only inspect and manage their own facility.
    Regional dispatchers and super administrators retain supervisory oversight.
    """
    auth_user = current_user if isinstance(current_user, User) else None
    if not auth_user:
        if allow_public:
            return
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required to access protected hospital resources.",
        )

    if auth_user.role == ROLE_HOSPITAL_STAFF:
        if auth_user.hospital_id != hospital_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: Cannot access information belonging to another hospital facility.",
            )

def require_hospital_staff_or_admin(hospital_id: int, current_user: Optional[User]) -> User:
    auth_user = current_user if isinstance(current_user, User) else None
    if not auth_user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required to modify hospital resources.",
        )
    if auth_user.role == ROLE_HOSPITAL_STAFF:
        if auth_user.hospital_id != hospital_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: Hospital staff can only update resources for their assigned facility.",
            )
    elif auth_user.role not in [ROLE_DISPATCHER, ROLE_SUPER_ADMIN]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: Insufficient permissions to modify hospital resources.",
        )
    return auth_user

@router.get("", response_model=List[HospitalOut])
def list_hospitals(
    accepting_only: bool = False,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Returns registered hospitals in Mangaluru with live bed capacity and department specialties.
    Role-based filtering:
      - HOSPITAL_STAFF: Strict data isolation -> Only returns their own assigned hospital.
      - DISPATCHER / SUPER_ADMIN / CREW: Returns all facilities for regional coordination.
    """
    query = db.query(Hospital)
    auth_user = current_user if isinstance(current_user, User) else None

    if auth_user and auth_user.role == ROLE_HOSPITAL_STAFF and auth_user.hospital_id:
        query = query.filter(Hospital.id == auth_user.hospital_id)
    elif accepting_only:
        query = query.filter(Hospital.accepting_emergencies == True)

    return query.order_by(Hospital.available_emergency_beds.desc()).all()

@router.get("/{hospital_id}", response_model=HospitalOut)
def get_hospital(
    hospital_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    verify_hospital_access(hospital_id, current_user)
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
    Updates bed capacity, readiness status, on-shift doctors, and readiness parameters.
    Enforces strict hospital ownership and mathematical bed consistency.
    """
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")

    auth_user = require_hospital_staff_or_admin(hospital_id, current_user)

    # 1. Emergency Beds Validation & Calculation
    if payload.total_emergency_beds is not None:
        if payload.total_emergency_beds < 0:
            raise HTTPException(status_code=422, detail="Total emergency beds cannot be negative")
        hospital.total_emergency_beds = payload.total_emergency_beds

    if payload.occupied_emergency_beds is not None:
        if payload.occupied_emergency_beds < 0:
            raise HTTPException(status_code=422, detail="Occupied emergency beds cannot be negative")
        if payload.occupied_emergency_beds > hospital.total_emergency_beds:
            raise HTTPException(status_code=422, detail="Occupied emergency beds cannot exceed total emergency beds")
        hospital.available_emergency_beds = max(0, hospital.total_emergency_beds - payload.occupied_emergency_beds)
    elif payload.available_emergency_beds is not None:
        if payload.available_emergency_beds < 0:
            raise HTTPException(status_code=422, detail="Available emergency beds cannot be negative")
        if payload.available_emergency_beds > hospital.total_emergency_beds:
            raise HTTPException(status_code=422, detail="Available emergency beds cannot exceed total emergency beds")
        hospital.available_emergency_beds = payload.available_emergency_beds

    # 2. ICU Beds Validation & Calculation
    if payload.total_icu_beds is not None:
        if payload.total_icu_beds < 0:
            raise HTTPException(status_code=422, detail="Total ICU beds cannot be negative")
        hospital.total_icu_beds = payload.total_icu_beds

    if payload.occupied_icu_beds is not None:
        if payload.occupied_icu_beds < 0:
            raise HTTPException(status_code=422, detail="Occupied ICU beds cannot be negative")
        if payload.occupied_icu_beds > hospital.total_icu_beds:
            raise HTTPException(status_code=422, detail="Occupied ICU beds cannot exceed total ICU beds")
        hospital.available_icu_beds = max(0, hospital.total_icu_beds - payload.occupied_icu_beds)
    elif payload.available_icu_beds is not None:
        if payload.available_icu_beds < 0:
            raise HTTPException(status_code=422, detail="Available ICU beds cannot be negative")
        if payload.available_icu_beds > hospital.total_icu_beds:
            raise HTTPException(status_code=422, detail="Available ICU beds cannot exceed total ICU beds")
        hospital.available_icu_beds = payload.available_icu_beds

    # 3. Ward Beds Validation & Calculation
    if payload.total_ward_beds is not None:
        if payload.total_ward_beds < 0:
            raise HTTPException(status_code=422, detail="Total ward beds cannot be negative")
        hospital.total_ward_beds = payload.total_ward_beds

    if payload.occupied_ward_beds is not None:
        if payload.occupied_ward_beds < 0:
            raise HTTPException(status_code=422, detail="Occupied ward beds cannot be negative")
        if payload.occupied_ward_beds > hospital.total_ward_beds:
            raise HTTPException(status_code=422, detail="Occupied ward beds cannot exceed total ward beds")
        hospital.available_ward_beds = max(0, hospital.total_ward_beds - payload.occupied_ward_beds)
    elif payload.available_ward_beds is not None:
        if payload.available_ward_beds < 0:
            raise HTTPException(status_code=422, detail="Available ward beds cannot be negative")
        if payload.available_ward_beds > hospital.total_ward_beds:
            raise HTTPException(status_code=422, detail="Available ward beds cannot exceed total ward beds")
        hospital.available_ward_beds = payload.available_ward_beds

    # 4. Pediatric Beds Validation & Calculation
    tot_ped = payload.pediatric_beds_total if payload.pediatric_beds_total is not None else payload.total_pediatric_beds
    if tot_ped is not None:
        if tot_ped < 0:
            raise HTTPException(status_code=422, detail="Total pediatric beds cannot be negative")
        hospital.pediatric_beds_total = tot_ped

    if payload.occupied_pediatric_beds is not None:
        if payload.occupied_pediatric_beds < 0:
            raise HTTPException(status_code=422, detail="Occupied pediatric beds cannot be negative")
        if payload.occupied_pediatric_beds > (hospital.pediatric_beds_total or 0):
            raise HTTPException(status_code=422, detail="Occupied pediatric beds cannot exceed total pediatric beds")
        hospital.pediatric_beds_available = max(0, (hospital.pediatric_beds_total or 0) - payload.occupied_pediatric_beds)
    elif payload.available_pediatric_beds is not None or payload.pediatric_beds_available is not None:
        avail_ped = payload.available_pediatric_beds if payload.available_pediatric_beds is not None else payload.pediatric_beds_available
        if avail_ped < 0:
            raise HTTPException(status_code=422, detail="Available pediatric beds cannot be negative")
        if avail_ped > (hospital.pediatric_beds_total or 0):
            raise HTTPException(status_code=422, detail="Available pediatric beds cannot exceed total pediatric beds")
        hospital.pediatric_beds_available = avail_ped

    # 5. Operational Readiness Status
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

    # 5. Additional Readiness Attributes
    if payload.oxygen_status is not None:
        hospital.oxygen_status = payload.oxygen_status.upper().strip()
    if payload.ventilators_total is not None:
        hospital.ventilators_total = max(0, payload.ventilators_total)
    if payload.ventilators_available is not None:
        hospital.ventilators_available = max(0, min(hospital.ventilators_total, payload.ventilators_available))
    if payload.equipment_readiness is not None:
        hospital.equipment_readiness = payload.equipment_readiness
    if payload.blood_bank_status is not None:
        hospital.blood_bank_status = payload.blood_bank_status
    if payload.emergency_contact_person is not None:
        hospital.emergency_contact_person = payload.emergency_contact_person

    if payload.doctors_availability is not None:
        hospital.doctors_availability = payload.doctors_availability

    if payload.updated_by_name:
        hospital.last_updated_by = payload.updated_by_name
    elif auth_user and auth_user.full_name:
        hospital.last_updated_by = auth_user.full_name

    hospital.last_updated = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(hospital)

    broadcast_sync(
        "HOSPITAL_CAPACITY_UPDATED",
        {
            "hospital_id": hospital.id,
            "facility_code": hospital.facility_code,
            "name": hospital.name,
            "available_emergency_beds": hospital.available_emergency_beds,
            "total_emergency_beds": hospital.total_emergency_beds,
            "occupied_emergency_beds": hospital.occupied_emergency_beds,
            "reserved_emergency_beds": hospital.reserved_emergency_beds,
            "available_icu_beds": hospital.available_icu_beds,
            "total_icu_beds": hospital.total_icu_beds,
            "occupied_icu_beds": hospital.occupied_icu_beds,
            "available_ward_beds": hospital.available_ward_beds,
            "total_ward_beds": hospital.total_ward_beds,
            "occupied_ward_beds": hospital.occupied_ward_beds,
            "readiness_status": hospital.readiness_status,
            "accepting_emergencies": hospital.accepting_emergencies,
            "oxygen_status": hospital.oxygen_status,
            "ventilators_available": hospital.ventilators_available,
            "ventilators_total": hospital.ventilators_total,
            "doctors_availability": hospital.doctors_availability,
            "last_updated_by": hospital.last_updated_by,
        },
        hospital_id=hospital.id,
        entity_type="hospital",
        entity_id=hospital.id,
    )

    return hospital

@router.patch("/{hospital_id}/beds", response_model=HospitalOut)
def update_hospital_beds(
    hospital_id: int,
    payload: HospitalBedsUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Dedicated endpoint for granular ward and bed capacity updates with validation.
    """
    cap_payload = HospitalCapacityUpdate(
        total_emergency_beds=payload.total_emergency_beds,
        occupied_emergency_beds=payload.occupied_emergency_beds,
        available_emergency_beds=payload.available_emergency_beds,
        total_icu_beds=payload.total_icu_beds,
        occupied_icu_beds=payload.occupied_icu_beds,
        available_icu_beds=payload.available_icu_beds,
        total_ward_beds=payload.total_ward_beds,
        occupied_ward_beds=payload.occupied_ward_beds,
        available_ward_beds=payload.available_ward_beds,
        total_pediatric_beds=payload.total_pediatric_beds if payload.total_pediatric_beds is not None else payload.pediatric_beds_total,
        occupied_pediatric_beds=payload.occupied_pediatric_beds,
        available_pediatric_beds=payload.available_pediatric_beds if payload.available_pediatric_beds is not None else payload.pediatric_beds_available,
        updated_by_name=payload.updated_by_name,
    )
    return update_hospital_capacity(hospital_id, cap_payload, db=db, current_user=current_user)

@router.patch("/{hospital_id}/readiness", response_model=HospitalOut)
def update_hospital_readiness(
    hospital_id: int,
    payload: HospitalReadinessUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Dedicated endpoint for operational readiness, oxygen, ventilator, and equipment updates.
    """
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")

    auth_user = require_hospital_staff_or_admin(hospital_id, current_user)

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
    if payload.oxygen_status is not None:
        hospital.oxygen_status = payload.oxygen_status.upper().strip()
    if payload.ventilators_total is not None:
        hospital.ventilators_total = max(0, payload.ventilators_total)
    if payload.ventilators_available is not None:
        hospital.ventilators_available = max(0, min(hospital.ventilators_total, payload.ventilators_available))
    if payload.equipment_readiness is not None:
        hospital.equipment_readiness = payload.equipment_readiness
    if payload.blood_bank_status is not None:
        hospital.blood_bank_status = payload.blood_bank_status
    elif payload.blood_bank is not None:
        hospital.blood_bank_status = payload.blood_bank
    if payload.contact_number is not None:
        hospital.contact_number = payload.contact_number
    if payload.emergency_contact_person is not None:
        hospital.emergency_contact_person = payload.emergency_contact_person

    if payload.updated_by_name:
        hospital.last_updated_by = payload.updated_by_name
    elif auth_user and auth_user.full_name:
        hospital.last_updated_by = auth_user.full_name

    hospital.last_updated = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(hospital)

    broadcast_sync(
        "HOSPITAL_CAPACITY_UPDATED",
        {
            "hospital_id": hospital.id,
            "facility_code": hospital.facility_code,
            "name": hospital.name,
            "readiness_status": hospital.readiness_status,
            "accepting_emergencies": hospital.accepting_emergencies,
            "oxygen_status": hospital.oxygen_status,
            "ventilators_available": hospital.ventilators_available,
            "ventilators_total": hospital.ventilators_total,
            "equipment_readiness": hospital.equipment_readiness,
            "blood_bank_status": hospital.blood_bank_status,
            "emergency_contact_person": hospital.emergency_contact_person,
            "last_updated_by": hospital.last_updated_by,
        },
        hospital_id=hospital.id,
        entity_type="hospital",
        entity_id=hospital.id,
    )

    return hospital

# =============================================================================
# DOCTOR MANAGEMENT CRUD APIS
# =============================================================================
@router.get("/{hospital_id}/doctors", response_model=List[Dict[str, Any]])
def list_hospital_doctors(
    hospital_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    verify_hospital_access(hospital_id, current_user)
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")
    return hospital.doctors_availability or []

@router.post("/{hospital_id}/doctors", response_model=List[Dict[str, Any]], status_code=status.HTTP_201_CREATED)
def add_hospital_doctor(
    hospital_id: int,
    payload: DoctorCreate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")

    auth_user = require_hospital_staff_or_admin(hospital_id, current_user)

    doctors = list(hospital.doctors_availability or [])
    new_doc = {
        "id": f"doc_{hospital_id}_{uuid.uuid4().hex[:6]}",
        "name": payload.name.strip(),
        "specialty": payload.specialty.strip(),
        "department": payload.department.strip(),
        "shift": payload.shift.strip(),
        "status": payload.status.upper().strip(),
        "contact_number": payload.contact_number.strip() if payload.contact_number else None,
        "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    doctors.append(new_doc)
    hospital.doctors_availability = doctors
    hospital.last_updated_by = auth_user.full_name or "Hospital Staff"
    hospital.last_updated = datetime.now(timezone.utc).replace(tzinfo=None)

    db.commit()
    db.refresh(hospital)

    broadcast_sync(
        "HOSPITAL_DOCTOR_UPDATED",
        {"hospital_id": hospital.id, "doctors_availability": hospital.doctors_availability},
        hospital_id=hospital.id,
    )
    return hospital.doctors_availability

@router.put("/{hospital_id}/doctors/{doctor_id}", response_model=List[Dict[str, Any]])
def update_hospital_doctor(
    hospital_id: int,
    doctor_id: str,
    payload: DoctorUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")

    auth_user = require_hospital_staff_or_admin(hospital_id, current_user)

    doctors = list(hospital.doctors_availability or [])
    found = False
    for doc in doctors:
        if str(doc.get("id")) == str(doctor_id) or doc.get("name") == doctor_id:
            if payload.name is not None:
                doc["name"] = payload.name.strip()
            if payload.specialty is not None:
                doc["specialty"] = payload.specialty.strip()
            if payload.department is not None:
                doc["department"] = payload.department.strip()
            if payload.shift is not None:
                doc["shift"] = payload.shift.strip()
            if payload.status is not None:
                doc["status"] = payload.status.upper().strip()
            if payload.contact_number is not None:
                doc["contact_number"] = payload.contact_number.strip()
            doc["last_updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            found = True
            break

    if not found:
        raise HTTPException(status_code=404, detail=f"Doctor '{doctor_id}' not found at this hospital")

    hospital.doctors_availability = doctors
    hospital.last_updated_by = auth_user.full_name or "Hospital Staff"
    hospital.last_updated = datetime.now(timezone.utc).replace(tzinfo=None)

    db.commit()
    db.refresh(hospital)

    broadcast_sync(
        "HOSPITAL_DOCTOR_UPDATED",
        {"hospital_id": hospital.id, "doctors_availability": hospital.doctors_availability},
        hospital_id=hospital.id,
    )
    return hospital.doctors_availability

@router.delete("/{hospital_id}/doctors/{doctor_id}", response_model=List[Dict[str, Any]])
def delete_hospital_doctor(
    hospital_id: int,
    doctor_id: str,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")

    auth_user = require_hospital_staff_or_admin(hospital_id, current_user)

    doctors = list(hospital.doctors_availability or [])
    updated = [d for d in doctors if str(d.get("id")) != str(doctor_id) and d.get("name") != doctor_id]
    if len(updated) == len(doctors):
        raise HTTPException(status_code=404, detail=f"Doctor '{doctor_id}' not found")

    hospital.doctors_availability = updated
    hospital.last_updated_by = auth_user.full_name or "Hospital Staff"
    hospital.last_updated = datetime.now(timezone.utc).replace(tzinfo=None)

    db.commit()
    db.refresh(hospital)

    broadcast_sync(
        "HOSPITAL_DOCTOR_UPDATED",
        {"hospital_id": hospital.id, "doctors_availability": hospital.doctors_availability},
        hospital_id=hospital.id,
    )
    return hospital.doctors_availability

# =============================================================================
# INCOMING ALLOCATIONS WORKFLOW FOR THIS HOSPITAL
# =============================================================================
@router.get("/{hospital_id}/allocated-incidents", response_model=List[DispatchOut])
def get_allocated_incidents(
    hospital_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Returns only the emergency incidents allocated to this specific hospital.
    Strictly isolated: Staff from Hospital A cannot view incidents allocated to Hospital B.
    """
    verify_hospital_access(hospital_id, current_user)
    query = (
        db.query(Dispatch)
        .filter(Dispatch.destination_hospital_id == hospital_id)
        .order_by(Dispatch.created_at.desc())
    )
    return query.all()
