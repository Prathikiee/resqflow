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
    shift: str = Field(default="Morning", max_length=50)  # Morning, Evening, Night, On-Call
    status: str = Field(default="AVAILABLE", max_length=40)  # AVAILABLE, BUSY, ON_LEAVE, UNAVAILABLE
    contact_number: Optional[str] = None

class DoctorUpdate(BaseModel):
    name: Optional[str] = None
    specialty: Optional[str] = None
    department: Optional[str] = None
    shift: Optional[str] = None
    status: Optional[str] = None
    contact_number: Optional[str] = None

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
