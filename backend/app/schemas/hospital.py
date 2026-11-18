from typing import List, Optional, Dict, Any
from datetime import datetime
from pydantic import BaseModel, ConfigDict

class HospitalCapacityUpdate(BaseModel):
    available_emergency_beds: Optional[int] = None
    available_icu_beds: Optional[int] = None
    available_ward_beds: Optional[int] = None
    readiness_status: Optional[str] = None  # READY, BUSY, DIVERT
    accepting_emergencies: Optional[bool] = None
    doctors_availability: Optional[List[Dict[str, Any]]] = None
    updated_by_name: Optional[str] = None

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
    total_emergency_beds: int
    available_emergency_beds: int
    reserved_emergency_beds: int = 0
    total_ward_beds: int = 50
    available_ward_beds: int = 20
    readiness_status: str = "READY"
    specialties: List[str]
    doctors_availability: List[Dict[str, Any]] = []
    accepting_emergencies: bool
    contact_number: str
    last_updated_by: Optional[str] = None
    last_updated: Optional[datetime] = None
