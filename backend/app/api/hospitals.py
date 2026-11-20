from typing import List, Optional, Dict, Any
import uuid
from datetime import datetime, timezone, timedelta
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
    DoctorStatusUpdate,
    DepartmentItem,
    DepartmentListUpdate,
    DepartmentItemUpdate,
    CapabilitiesUpdate,
    BedCapacityBreakdownUpdate,
    HospitalProfileUpdate,
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
# DOCTOR MANAGEMENT & SHIFT SCHEDULING ENGINES
# =============================================================================
def compute_doctor_duty_and_availability(doctor: dict, current_dt: Optional[datetime] = None) -> dict:
    """
    Evaluates doctor's actual on-duty and real-time availability status
    based on shift start/end times, overnight shifts, working days, and status overrides.
    """
    doc = dict(doctor)
    now = current_dt or datetime.now(timezone.utc)
    curr_time_str = now.strftime("%H:%M")
    curr_day = now.strftime("%a").upper()[:3]  # MON, TUE, WED, THU, FRI, SAT, SUN

    is_active = doc.get("is_active", True)
    stored_status = str(doc.get("status", "AVAILABLE")).upper().strip()

    # Default fallback values for backward-compatibility
    if "shift_type" not in doc:
        shift_str = str(doc.get("shift", "")).upper()
        if "NIGHT" in shift_str:
            doc["shift_type"] = "NIGHT"
            doc["shift_start"] = "20:00"
            doc["shift_end"] = "08:00"
        elif "EVENING" in shift_str:
            doc["shift_type"] = "EVENING"
            doc["shift_start"] = "16:00"
            doc["shift_end"] = "00:00"
        elif "CALL" in shift_str or "24" in shift_str:
            doc["shift_type"] = "ON_CALL"
            doc["shift_start"] = "00:00"
            doc["shift_end"] = "23:59"
        else:
            doc["shift_type"] = "MORNING"
            doc["shift_start"] = "08:00"
            doc["shift_end"] = "16:00"

    if "working_days" not in doc or not doc["working_days"]:
        doc["working_days"] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]

    if not is_active:
        doc["is_on_duty"] = False
        doc["is_available"] = False
        doc["effective_status"] = "UNAVAILABLE"
        doc["duty_reason"] = "Staff profile deactivated"
        return doc

    if stored_status == "ON_LEAVE":
        doc["is_on_duty"] = False
        doc["is_available"] = False
        doc["effective_status"] = "ON_LEAVE"
        doc["duty_reason"] = "On approved clinical leave"
        return doc

    if stored_status == "UNAVAILABLE":
        doc["is_on_duty"] = False
        doc["is_available"] = False
        doc["effective_status"] = "UNAVAILABLE"
        doc["duty_reason"] = "Marked unavailable"
        return doc

    if stored_status == "OFF_DUTY":
        doc["is_on_duty"] = False
        doc["is_available"] = False
        doc["effective_status"] = "OFF_DUTY"
        doc["duty_reason"] = "Marked off duty"
        return doc

    # Evaluate Working Days and Shift Timings (supporting Overnight shifts across midnight)
    prev_day = (now - timedelta(days=1)).strftime("%a").upper()[:3]
    working_days = [str(d).upper()[:3] for d in (doc.get("working_days") or [])]

    shift_start = doc.get("shift_start") or "08:00"
    shift_end = doc.get("shift_end") or "16:00"
    shift_type = str(doc.get("shift_type", "")).upper().strip()

    if shift_type == "ON_CALL" or (shift_start == "00:00" and shift_end in ["23:59", "24:00", "00:00"]):
        is_shift_time = True
        is_working_day = (curr_day in working_days) or ("ALL" in working_days)
    elif shift_start <= shift_end:
        # Standard daytime shift
        is_shift_time = (shift_start <= curr_time_str <= shift_end)
        is_working_day = (curr_day in working_days) or ("ALL" in working_days)
    else:
        # Overnight shift (e.g. 20:00 - 08:00)
        if curr_time_str >= shift_start:
            # First half of overnight shift (before midnight): check current day
            is_shift_time = True
            is_working_day = (curr_day in working_days) or ("ALL" in working_days)
        elif curr_time_str <= shift_end:
            # Second half of overnight shift (after midnight): check shift-start day (yesterday)
            is_shift_time = True
            is_working_day = (prev_day in working_days) or ("ALL" in working_days)
        else:
            is_shift_time = False
            is_working_day = (curr_day in working_days) or ("ALL" in working_days)

    if not is_working_day:
        doc["is_on_duty"] = False
        doc["is_available"] = False
        doc["effective_status"] = "OFF_DUTY"
        doc["duty_reason"] = f"Scheduled off today ({curr_day})"
    elif not is_shift_time:
        doc["is_on_duty"] = False
        doc["is_available"] = False
        doc["effective_status"] = "OFF_DUTY"
        doc["duty_reason"] = f"Outside shift hours ({shift_start} - {shift_end})"
    else:
        doc["is_on_duty"] = True
        doc["effective_status"] = stored_status
        doc["is_available"] = (stored_status == "AVAILABLE")
        doc["duty_reason"] = f"Active on shift ({shift_start} - {shift_end})"

    return doc


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
    doctors = hospital.doctors_availability or []
    return [compute_doctor_duty_and_availability(d) for d in doctors]

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

    # Shift timing validation
    shift_start = (payload.shift_start or "08:00").strip()
    shift_end = (payload.shift_end or "16:00").strip()

    doctors = list(hospital.doctors_availability or [])
    new_doc = {
        "id": f"doc_{hospital_id}_{uuid.uuid4().hex[:6]}",
        "name": payload.name.strip(),
        "specialty": payload.specialty.strip(),
        "department": payload.department.strip(),
        "designation": (payload.designation or "Attending Physician").strip(),
        "shift": payload.shift.strip(),
        "shift_type": (payload.shift_type or "MORNING").upper().strip(),
        "shift_start": shift_start,
        "shift_end": shift_end,
        "working_days": payload.working_days or ["MON", "TUE", "WED", "THU", "FRI", "SAT"],
        "status": payload.status.upper().strip(),
        "emergency_coverage": True if payload.emergency_coverage is None else payload.emergency_coverage,
        "contact_number": payload.contact_number.strip() if payload.contact_number else None,
        "is_active": True if payload.is_active is None else payload.is_active,
        "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    doctors.append(new_doc)
    hospital.doctors_availability = doctors
    hospital.last_updated_by = auth_user.full_name or "Hospital Staff"
    hospital.last_updated = datetime.now(timezone.utc).replace(tzinfo=None)

    db.commit()
    db.refresh(hospital)

    evaluated_docs = [compute_doctor_duty_and_availability(d) for d in hospital.doctors_availability]
    broadcast_sync(
        "HOSPITAL_DOCTOR_UPDATED",
        {"hospital_id": hospital.id, "doctors_availability": evaluated_docs},
        hospital_id=hospital.id,
    )
    return evaluated_docs

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
            if payload.designation is not None:
                doc["designation"] = payload.designation.strip()
            if payload.shift is not None:
                doc["shift"] = payload.shift.strip()
            if payload.shift_type is not None:
                doc["shift_type"] = payload.shift_type.upper().strip()
            if payload.shift_start is not None:
                doc["shift_start"] = payload.shift_start.strip()
            if payload.shift_end is not None:
                doc["shift_end"] = payload.shift_end.strip()
            if payload.working_days is not None:
                doc["working_days"] = payload.working_days
            if payload.status is not None:
                doc["status"] = payload.status.upper().strip()
            if payload.emergency_coverage is not None:
                doc["emergency_coverage"] = payload.emergency_coverage
            if payload.contact_number is not None:
                doc["contact_number"] = payload.contact_number.strip()
            if payload.is_active is not None:
                doc["is_active"] = payload.is_active
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

    evaluated_docs = [compute_doctor_duty_and_availability(d) for d in hospital.doctors_availability]
    broadcast_sync(
        "HOSPITAL_DOCTOR_UPDATED",
        {"hospital_id": hospital.id, "doctors_availability": evaluated_docs},
        hospital_id=hospital.id,
    )
    return evaluated_docs

@router.patch("/{hospital_id}/doctors/{doctor_id}/status", response_model=List[Dict[str, Any]])
def update_hospital_doctor_status(
    hospital_id: int,
    doctor_id: str,
    payload: DoctorStatusUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Quick status toggle endpoint: AVAILABLE, BUSY, OFF_DUTY, UNAVAILABLE, ON_LEAVE.
    """
    new_status = payload.status.upper().strip()
    valid_statuses = ["AVAILABLE", "BUSY", "OFF_DUTY", "UNAVAILABLE", "ON_LEAVE"]
    if new_status not in valid_statuses:
        raise HTTPException(status_code=422, detail=f"Invalid doctor status '{new_status}'. Must be one of {valid_statuses}")

    return update_hospital_doctor(
        hospital_id,
        doctor_id,
        DoctorUpdate(status=new_status),
        db=db,
        current_user=current_user,
    )

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

    evaluated_docs = [compute_doctor_duty_and_availability(d) for d in hospital.doctors_availability]
    broadcast_sync(
        "HOSPITAL_DOCTOR_UPDATED",
        {"hospital_id": hospital.id, "doctors_availability": evaluated_docs},
        hospital_id=hospital.id,
    )
    return evaluated_docs

# =============================================================================
# DEPARTMENTS & CLINICAL CAPABILITIES MANAGEMENT
# =============================================================================
@router.get("/{hospital_id}/departments", response_model=List[Dict[str, Any]])
def get_hospital_departments(
    hospital_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    verify_hospital_access(hospital_id, current_user)
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")
    return hospital.departments

@router.put("/{hospital_id}/departments", response_model=List[Dict[str, Any]])
def update_hospital_departments(
    hospital_id: int,
    payload: DepartmentListUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")

    auth_user = require_hospital_staff_or_admin(hospital_id, current_user)

    depts = []
    for d in payload.departments:
        dept_dict = d.model_dump()
        if not dept_dict.get("id"):
            dept_dict["id"] = f"dept_{uuid.uuid4().hex[:6]}"
        depts.append(dept_dict)

    hospital.departments = depts
    hospital.last_updated_by = auth_user.full_name or "Hospital Staff"
    hospital.last_updated = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(hospital)

    broadcast_sync(
        "HOSPITAL_DEPARTMENTS_UPDATED",
        {"hospital_id": hospital.id, "departments": hospital.departments},
        hospital_id=hospital.id,
    )
    return hospital.departments

@router.patch("/{hospital_id}/departments/{dept_id}", response_model=List[Dict[str, Any]])
def update_single_department(
    hospital_id: int,
    dept_id: str,
    payload: DepartmentItemUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")

    auth_user = require_hospital_staff_or_admin(hospital_id, current_user)

    depts = list(hospital.departments)
    found = False
    for dept in depts:
        if dept.get("id") == dept_id or dept.get("name") == dept_id:
            if payload.operational_status is not None:
                op_status = payload.operational_status.upper().strip()
                if op_status not in ["ACTIVE", "LIMITED", "TEMPORARILY_CLOSED"]:
                    raise HTTPException(status_code=422, detail="Status must be ACTIVE, LIMITED, or TEMPORARILY_CLOSED")
                dept["operational_status"] = op_status
            if payload.operating_hours is not None:
                dept["operating_hours"] = payload.operating_hours.strip()
            if payload.emergency_coverage is not None:
                dept["emergency_coverage"] = payload.emergency_coverage
            if payload.specialty_availability is not None:
                dept["specialty_availability"] = payload.specialty_availability
            if payload.notes is not None:
                dept["notes"] = payload.notes.strip()
            found = True
            break

    if not found:
        raise HTTPException(status_code=404, detail=f"Department '{dept_id}' not found")

    hospital.departments = depts
    hospital.last_updated_by = auth_user.full_name or "Hospital Staff"
    hospital.last_updated = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(hospital)

    broadcast_sync(
        "HOSPITAL_DEPARTMENTS_UPDATED",
        {"hospital_id": hospital.id, "departments": hospital.departments},
        hospital_id=hospital.id,
    )
    return hospital.departments

@router.get("/{hospital_id}/capabilities", response_model=Dict[str, str])
def get_hospital_capabilities(
    hospital_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    verify_hospital_access(hospital_id, current_user)
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")
    return hospital.capabilities

@router.patch("/{hospital_id}/capabilities", response_model=Dict[str, str])
def update_hospital_capabilities(
    hospital_id: int,
    payload: CapabilitiesUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")

    auth_user = require_hospital_staff_or_admin(hospital_id, current_user)

    caps = dict(hospital.capabilities)
    valid_states = ["AVAILABLE", "LIMITED", "UNAVAILABLE"]

    for field, val in payload.model_dump(exclude_unset=True).items():
        if val is not None:
            v_upper = val.upper().strip()
            if v_upper not in valid_states:
                raise HTTPException(status_code=422, detail=f"Capability '{field}' value must be one of {valid_states}")
            caps[field] = v_upper

    hospital.capabilities = caps
    hospital.last_updated_by = auth_user.full_name or "Hospital Staff"
    hospital.last_updated = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(hospital)

    broadcast_sync(
        "HOSPITAL_CAPABILITIES_UPDATED",
        {"hospital_id": hospital.id, "capabilities": hospital.capabilities},
        hospital_id=hospital.id,
    )
    return hospital.capabilities

# =============================================================================
# MULTI-TIER BED CAPACITY MANAGEMENT
# =============================================================================
@router.get("/{hospital_id}/bed-capacity", response_model=Dict[str, Any])
def get_hospital_bed_capacity(
    hospital_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    verify_hospital_access(hospital_id, current_user)
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")
    return hospital.bed_capacity_breakdown

@router.patch("/{hospital_id}/bed-capacity", response_model=Dict[str, Any])
def update_hospital_bed_capacity(
    hospital_id: int,
    payload: BedCapacityBreakdownUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Updates multi-category bed capacity: Emergency, ICU, HDU, General Ward, Isolation, Pediatric.
    Strictly enforces: Available = Total - Occupied - Reserved - Unavailable
    Prevents negative numbers and over-occupancy. Synchronizes base hospital bed columns.
    """
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")

    auth_user = require_hospital_staff_or_admin(hospital_id, current_user)

    breakdown = dict(hospital.bed_capacity_breakdown)

    categories = ["emergency", "icu", "hdu", "general_ward", "isolation", "pediatric"]
    for cat in categories:
        cat_input = getattr(payload, cat, None)
        if cat_input is not None:
            tot = cat_input.total
            occ = cat_input.occupied
            res = cat_input.reserved or 0
            unavail = cat_input.unavailable or 0

            if tot < 0 or occ < 0 or res < 0 or unavail < 0:
                raise HTTPException(status_code=422, detail=f"Bed counts for {cat} cannot be negative")

            if (occ + res + unavail) > tot:
                raise HTTPException(
                    status_code=422,
                    detail=f"For {cat}: occupied ({occ}) + reserved ({res}) + unavailable ({unavail}) exceeds total ({tot})",
                )

            avail = max(0, tot - occ - res - unavail)
            name_label = breakdown.get(cat, {}).get("name", cat.replace("_", " ").title())
            breakdown[cat] = {
                "name": name_label,
                "total": tot,
                "occupied": occ,
                "reserved": res,
                "unavailable": unavail,
                "available": avail,
            }

            # Synchronize base hospital columns
            if cat == "emergency":
                hospital.total_emergency_beds = tot
                hospital.available_emergency_beds = avail
                hospital.reserved_emergency_beds = res
            elif cat == "icu":
                hospital.total_icu_beds = tot
                hospital.available_icu_beds = avail
            elif cat == "general_ward":
                hospital.total_ward_beds = tot
                hospital.available_ward_beds = avail
            elif cat == "pediatric":
                hospital.pediatric_beds_total = tot
                hospital.pediatric_beds_available = avail

    hospital.bed_capacity_breakdown = breakdown
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
            "bed_capacity_breakdown": hospital.bed_capacity_breakdown,
            "available_emergency_beds": hospital.available_emergency_beds,
            "total_emergency_beds": hospital.total_emergency_beds,
            "available_icu_beds": hospital.available_icu_beds,
            "total_icu_beds": hospital.total_icu_beds,
            "available_ward_beds": hospital.available_ward_beds,
            "total_ward_beds": hospital.total_ward_beds,
            "last_updated_by": hospital.last_updated_by,
        },
        hospital_id=hospital.id,
        entity_type="hospital",
        entity_id=hospital.id,
    )
    return hospital.bed_capacity_breakdown

# =============================================================================
# HOSPITAL FACILITY PROFILE & SETTINGS
# =============================================================================
@router.patch("/{hospital_id}/profile", response_model=HospitalOut)
def update_hospital_profile(
    hospital_id: int,
    payload: HospitalProfileUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    hospital = db.query(Hospital).filter(Hospital.id == hospital_id).first()
    if not hospital:
        raise HTTPException(status_code=404, detail="Hospital not found")

    auth_user = require_hospital_staff_or_admin(hospital_id, current_user)

    if payload.name is not None:
        name_clean = payload.name.strip()
        if not name_clean:
            raise HTTPException(status_code=422, detail="Hospital name cannot be empty")
        hospital.name = name_clean

    if payload.address is not None:
        hospital.address = payload.address.strip()

    if payload.latitude is not None:
        if not (-90.0 <= payload.latitude <= 90.0):
            raise HTTPException(status_code=422, detail="Latitude must be between -90.0 and +90.0")
        hospital.latitude = payload.latitude

    if payload.longitude is not None:
        if not (-180.0 <= payload.longitude <= 180.0):
            raise HTTPException(status_code=422, detail="Longitude must be between -180.0 and +180.0")
        hospital.longitude = payload.longitude

    if payload.contact_number is not None:
        contact_clean = payload.contact_number.strip()
        if not contact_clean:
            raise HTTPException(status_code=422, detail="Contact phone cannot be empty")
        hospital.contact_number = contact_clean

    if payload.facility_type is not None:
        hospital.facility_type = payload.facility_type.strip()

    if payload.emergency_department_hours is not None:
        hospital.emergency_department_hours = payload.emergency_department_hours.strip()

    if payload.emergency_contact_person is not None:
        hospital.emergency_contact_person = payload.emergency_contact_person.strip()

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

    hospital.last_updated_by = auth_user.full_name or "Hospital Staff"
    hospital.last_updated = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(hospital)

    broadcast_sync(
        "HOSPITAL_PROFILE_UPDATED",
        {
            "hospital_id": hospital.id,
            "facility_code": hospital.facility_code,
            "name": hospital.name,
            "address": hospital.address,
            "latitude": hospital.latitude,
            "longitude": hospital.longitude,
            "contact_number": hospital.contact_number,
            "facility_type": hospital.facility_type,
            "emergency_department_hours": hospital.emergency_department_hours,
            "emergency_contact_person": hospital.emergency_contact_person,
            "readiness_status": hospital.readiness_status,
            "accepting_emergencies": hospital.accepting_emergencies,
        },
        hospital_id=hospital.id,
        entity_type="hospital",
        entity_id=hospital.id,
    )
    return hospital

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
