from typing import List, Optional
from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict

class IncidentCreate(BaseModel):
    caller_name: str = Field(..., min_length=2, max_length=120)
    caller_phone: str = Field(..., min_length=7, max_length=30)
    location_address: str = Field(..., min_length=3, max_length=255)
    latitude: float = Field(..., ge=-90.0, le=90.0)
    longitude: float = Field(..., ge=-180.0, le=180.0)
    chief_complaint: str = Field(..., min_length=3)

    patient_age: Optional[int] = Field(None, ge=0, le=125)
    patient_gender: Optional[str] = Field("Unknown", max_length=20)

    # Clinical assessment flags
    consciousness_level: str = Field("Alert")  # Alert, Voice, Pain, Unresponsive
    breathing_status: str = Field("Normal")     # Normal, Difficult, Absent
    severe_bleeding: bool = False
    chest_pain: bool = False
    suspected_stroke: bool = False
    severe_trauma: bool = False

class TriagePreviewRequest(BaseModel):
    chief_complaint: str
    consciousness_level: str = "Alert"
    breathing_status: str = "Normal"
    severe_bleeding: bool = False
    chest_pain: bool = False
    suspected_stroke: bool = False
    severe_trauma: bool = False
    patient_age: Optional[int] = None

class TriageAssessmentOut(BaseModel):
    triage_level: str
    triage_color: str
    triage_score: int
    required_ambulance_type: str
    justifications: List[str]
    recommended_specialty: str
    protocol_reference: str
    disclaimer: str

class IncidentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    caller_name: str
    caller_phone: str
    location_address: str
    latitude: float
    longitude: float
    chief_complaint: str
    patient_age: Optional[int] = None
    patient_gender: Optional[str] = None

    consciousness_level: str
    breathing_status: str
    severe_bleeding: bool
    chest_pain: bool
    suspected_stroke: bool
    severe_trauma: bool

    triage_level: str
    triage_color: str
    triage_score: int
    triage_justifications: List[str]
    required_ambulance_type: str
    status: str
    created_at: datetime
    updated_at: datetime
