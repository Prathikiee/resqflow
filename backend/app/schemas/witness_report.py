from typing import Optional, List, Dict, Any
from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict

class WitnessReportCreate(BaseModel):
    reporter_identifier: str = Field(..., description="Anonymous identifier or witness handle, e.g. 'Citizen #402'")
    incident_description: str = Field(..., description="Eyewitness description of the emergency")
    incident_type: str = Field("Road Traffic Accident", description="Reported category, e.g. Road Traffic Accident, Cardiac, Fire")
    latitude: float = Field(..., description="GPS Latitude of witness / incident observation")
    longitude: float = Field(..., description="GPS Longitude of witness / incident observation")
    reported_at: Optional[datetime] = Field(None, description="Timestamp of observation")

class WitnessReportLinkRequest(BaseModel):
    master_incident_id: Optional[int] = Field(None, description="Master incident to link to. If omitted, uses matching_incident_id.")
    notes: Optional[str] = Field(None, description="Dispatcher review notes")

class WitnessReportMarkDistinctRequest(BaseModel):
    notes: Optional[str] = Field(None, description="Dispatcher rationale for marking distinct")
    promote_to_incident: Optional[bool] = Field(False, description="Whether to spawn a new master incident from this distinct report")

class WitnessReportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    master_incident_id: Optional[int] = None
    reporter_identifier: str
    incident_description: str
    incident_type: str
    latitude: float
    longitude: float
    reported_at: datetime

    duplicate_probability: Optional[float] = None
    matching_incident_id: Optional[int] = None
    matching_distance_meters: Optional[float] = None
    matching_time_difference_seconds: Optional[float] = None
    matching_explanation: Optional[str] = None

    review_status: str  # NEW, POSSIBLE_DUPLICATE, CONFIRMED_DUPLICATE, DISTINCT
    audit_trail: Optional[List[Dict[str, Any]]] = None

    created_at: datetime
    updated_at: datetime
