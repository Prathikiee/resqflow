from typing import Optional, Dict, Any, List
from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict

class DispatchRequest(BaseModel):
    incident_id: int
    ambulance_id: int
    destination_hospital_id: Optional[int] = None

class IncidentStatusUpdate(BaseModel):
    status: str = Field(..., description="REPORTED, TRIAGED, ALLOCATED, DISPATCHED, EN_ROUTE, ON_SCENE, TRANSPORTING, AT_HOSPITAL, RESOLVED, CANCELLED")

class DispatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    incident_id: int
    ambulance_id: int
    destination_hospital_id: Optional[int] = None
    status: str
    dispatched_at: datetime
    arrived_incident_at: Optional[datetime] = None
    departed_incident_at: Optional[datetime] = None
    arrived_hospital_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    estimated_eta_seconds: Optional[float] = None
    actual_response_seconds: Optional[float] = None
    route_distance_meters: Optional[float] = None
    allocation_score: Optional[float] = None
    allocation_breakdown: Optional[Dict[str, Any]] = None
    route_geometry: Optional[List[List[float]]] = None
