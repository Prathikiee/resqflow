from typing import List, Optional
from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict

class AmbulanceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    call_sign: str
    vehicle_type: str
    equipment: List[str]
    paramedic_level: str
    status: str
    reservation_dispatch_id: Optional[int] = None
    base_station: str
    current_latitude: float
    current_longitude: float
    fuel_level_percent: int
    is_active: bool
    last_updated: Optional[datetime] = None

class AmbulanceLocationUpdate(BaseModel):
    latitude: float = Field(..., ge=-90.0, le=90.0)
    longitude: float = Field(..., ge=-180.0, le=180.0)
    status: Optional[str] = None
    accuracy: Optional[float] = None
    heading: Optional[float] = None
    speed: Optional[float] = None
    timestamp: Optional[float] = None
    dispatch_id: Optional[int] = None
    attempt_number: Optional[int] = None
    is_simulated: Optional[bool] = False

class AmbulanceIssueReport(BaseModel):
    issue_type: str = Field(..., description="MECHANICAL, MEDICAL_EQUIPMENT, FUEL, COMMUNICATIONS, OTHER")
    notes: Optional[str] = None
    mark_maintenance: bool = False

