from typing import List, Optional, Dict, Any
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field

class HospitalCapacityUpdate(BaseModel):
    available_emergency_beds: Optional[int] = None
    total_emergency_beds: Optional[int] = None
    occupied_emergency_beds: Optional[int] = None
    available_icu_beds: Optional[int] = None
    total_icu_beds: Optional[int] = None
    occupied_icu_beds: Optional[int] = None
    available_ward_beds: Optional[int] = None
    total_ward_beds: Optional[int] = None
    occupied_ward_beds: Optional[int] = None
    pediatric_beds_total: Optional[int] = None
    total_pediatric_beds: Optional[int] = None
    occupied_pediatric_beds: Optional[int] = None
    pediatric_beds_available: Optional[int] = None
    available_pediatric_beds: Optional[int] = None
    readiness_status: Optional[str] = None  # READY, BUSY, DIVERT
    accepting_emergencies: Optional[bool] = None
    doctors_availability: Optional[List[Dict[str, Any]]] = None
    oxygen_status: Optional[str] = None
    ventilators_total: Optional[int] = None
    ventilators_available: Optional[int] = None
    equipment_readiness: Optional[Dict[str, Any]] = None
    blood_bank_status: Optional[Dict[str, Any]] = None
    blood_bank: Optional[Dict[str, Any]] = None
    emergency_contact_person: Optional[str] = None
    updated_by_name: Optional[str] = None

class HospitalBedsUpdate(BaseModel):
    total_emergency_beds: Optional[int] = None
    occupied_emergency_beds: Optional[int] = None
    available_emergency_beds: Optional[int] = None
    total_icu_beds: Optional[int] = None
    occupied_icu_beds: Optional[int] = None
    available_icu_beds: Optional[int] = None
    total_ward_beds: Optional[int] = None
    occupied_ward_beds: Optional[int] = None
    available_ward_beds: Optional[int] = None
    pediatric_beds_total: Optional[int] = None
    total_pediatric_beds: Optional[int] = None
    occupied_pediatric_beds: Optional[int] = None
    pediatric_beds_available: Optional[int] = None
    available_pediatric_beds: Optional[int] = None
    updated_by_name: Optional[str] = None

class HospitalReadinessUpdate(BaseModel):
    readiness_status: Optional[str] = None  # READY, BUSY, DIVERT
    accepting_emergencies: Optional[bool] = None
    oxygen_status: Optional[str] = None    # NORMAL, REFILL_SCHEDULED, LOW, CRITICAL
    ventilators_total: Optional[int] = None
    ventilators_available: Optional[int] = None
    equipment_readiness: Optional[Dict[str, Any]] = None
    blood_bank_status: Optional[Dict[str, Any]] = None
    blood_bank: Optional[Dict[str, Any]] = None
    contact_number: Optional[str] = None
    emergency_contact_person: Optional[str] = None
    updated_by_name: Optional[str] = None

class DoctorCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    specialty: str = Field(..., min_length=2, max_length=100)
    department: str = Field(..., min_length=2, max_length=100)
    designation: Optional[str] = Field(default="Attending Physician", max_length=100)
    shift: str = Field(default="Morning (08:00 - 16:00)", max_length=60)
    shift_type: Optional[str] = Field(default="MORNING", max_length=40)  # MORNING, EVENING, NIGHT, CUSTOM, ON_CALL
    shift_start: Optional[str] = Field(default="08:00", max_length=10)
    shift_end: Optional[str] = Field(default="16:00", max_length=10)
    working_days: Optional[List[str]] = Field(default=["MON", "TUE", "WED", "THU", "FRI", "SAT"])
    status: str = Field(default="AVAILABLE", max_length=40)  # AVAILABLE, BUSY, OFF_DUTY, UNAVAILABLE, ON_LEAVE
    emergency_coverage: Optional[bool] = True
    contact_number: Optional[str] = None
    is_active: Optional[bool] = True

class DoctorUpdate(BaseModel):
    name: Optional[str] = None
    specialty: Optional[str] = None
    department: Optional[str] = None
    designation: Optional[str] = None
    shift: Optional[str] = None
    shift_type: Optional[str] = None
    shift_start: Optional[str] = None
    shift_end: Optional[str] = None
    working_days: Optional[List[str]] = None
    status: Optional[str] = None
    emergency_coverage: Optional[bool] = None
    contact_number: Optional[str] = None
    is_active: Optional[bool] = None

class DoctorStatusUpdate(BaseModel):
    status: str = Field(..., description="AVAILABLE, BUSY, OFF_DUTY, UNAVAILABLE, ON_LEAVE")
    reason: Optional[str] = None

class DepartmentItem(BaseModel):
    id: Optional[str] = None
    name: str = Field(..., min_length=2, max_length=120)
    operational_status: str = Field(default="ACTIVE", description="ACTIVE, LIMITED, TEMPORARILY_CLOSED")
    operating_hours: str = Field(default="24/7", max_length=60)
    emergency_coverage: bool = True
    specialty_availability: List[str] = []
    notes: Optional[str] = ""

class DepartmentListUpdate(BaseModel):
    departments: List[DepartmentItem]

class DepartmentItemUpdate(BaseModel):
    operational_status: Optional[str] = None
    operating_hours: Optional[str] = None
    emergency_coverage: Optional[bool] = None
    specialty_availability: Optional[List[str]] = None
    notes: Optional[str] = None

class CapabilitiesUpdate(BaseModel):
    cardiac_emergency: Optional[str] = None  # AVAILABLE, LIMITED, UNAVAILABLE
    trauma_capability: Optional[str] = None
    icu_availability: Optional[str] = None
    ventilator_availability: Optional[str] = None
    defibrillator_availability: Optional[str] = None
    emergency_imaging: Optional[str] = None
    operating_theatre: Optional[str] = None
    blood_bank: Optional[str] = None

class BedCategoryInput(BaseModel):
    model_config = ConfigDict(extra="ignore")

    total: int = Field(..., ge=0)
    occupied: int = Field(..., ge=0)
    reserved: Optional[int] = Field(default=0, ge=0)
    unavailable: Optional[int] = Field(default=0, ge=0)
    name: Optional[str] = None
    available: Optional[int] = None

class BedCapacityBreakdownUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    emergency: Optional[BedCategoryInput] = None
    icu: Optional[BedCategoryInput] = None
    hdu: Optional[BedCategoryInput] = None
    general_ward: Optional[BedCategoryInput] = None
    isolation: Optional[BedCategoryInput] = None
    pediatric: Optional[BedCategoryInput] = None
    updated_by_name: Optional[str] = None

class HospitalProfileUpdate(BaseModel):
    name: Optional[str] = None
    address: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    contact_number: Optional[str] = None
    facility_type: Optional[str] = None
    emergency_department_hours: Optional[str] = None
    emergency_contact_person: Optional[str] = None
    readiness_status: Optional[str] = None
    accepting_emergencies: Optional[bool] = None

class HospitalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    facility_code: Optional[str] = None
    address: str
    latitude: float
    longitude: float
    total_icu_beds: int
    available_icu_beds: int
    occupied_icu_beds: int = 0
    total_emergency_beds: int
    available_emergency_beds: int
    occupied_emergency_beds: int = 0
    reserved_emergency_beds: int = 0
    total_ward_beds: int = 50
    available_ward_beds: int = 20
    occupied_ward_beds: int = 0
    pediatric_beds_total: int = 10
    pediatric_beds_available: int = 5
    occupied_pediatric_beds: int = 0
    readiness_status: str = "READY"
    specialties: List[str]
    doctors_availability: List[Dict[str, Any]] = []
    departments: List[Dict[str, Any]] = []
    capabilities: Dict[str, str] = {}
    bed_capacity_breakdown: Dict[str, Any] = {}
    facility_type: str = "Tertiary Multi-Specialty Hospital"
    emergency_department_hours: str = "24/7 Rapid Response"
    accepting_emergencies: bool
    contact_number: str
    emergency_contact_person: Optional[str] = None
    oxygen_status: str = "NORMAL"
    ventilators_total: int = 10
    ventilators_available: int = 6
    equipment_readiness: Dict[str, Any] = {}
    blood_bank_status: Dict[str, Any] = {}
    last_updated_by: Optional[str] = None
    last_updated: Optional[datetime] = None
