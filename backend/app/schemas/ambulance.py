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
