from typing import List, Optional
from datetime import datetime
from pydantic import BaseModel, ConfigDict

class HospitalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    address: str
    latitude: float
    longitude: float
    total_icu_beds: int
    available_icu_beds: int
    total_emergency_beds: int
    available_emergency_beds: int
    specialties: List[str]
    accepting_emergencies: bool
    contact_number: str
    last_updated: Optional[datetime] = None
