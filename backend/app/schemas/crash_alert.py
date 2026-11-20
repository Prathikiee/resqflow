from typing import Optional, Dict, Any
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field

class CrashAlertIngest(BaseModel):
    ambulance_id: int
    latitude: float
    longitude: float
    timestamp: Optional[datetime] = None
    severity: str = Field(default="CRITICAL", pattern="^(?i)(MINOR|MODERATE|SEVERE|CRITICAL)$")
    location_description: Optional[str] = None
    sensor_data: Optional[Dict[str, Any]] = None
    source: str = Field(default="HARDWARE_IOT", pattern="^(?i)(HARDWARE_IOT|DEMO_SIMULATION|ESP32|HARDWARE|IOT)$")

class CrashAlertSimulate(BaseModel):
    ambulance_id: Optional[int] = None
    severity: str = "CRITICAL"
    location_description: Optional[str] = None

class CrashAlertResponseUpdate(BaseModel):
    status: str = Field(..., pattern="^(TRIGGERED|ACKNOWLEDGED|TEAM_NOTIFIED|BACKUP_REQUESTED|RESOLVED)$")
    response_notes: Optional[str] = None
    acknowledged_by: Optional[str] = None

class CrashAlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    ambulance_id: int
    ambulance_call_sign: Optional[str] = None
    incident_id: Optional[int] = None
    hospital_id: int
    hospital_name: Optional[str] = None
    dispatch_id: Optional[int] = None
    source: str
    severity: str
    latitude: float
    longitude: float
    location_description: Optional[str] = None
    sensor_data: Dict[str, Any] = {}
    status: str
    acknowledged_at: Optional[datetime] = None
    acknowledged_by: Optional[str] = None
    response_notes: Optional[str] = None
    created_at: datetime
    updated_at: datetime
