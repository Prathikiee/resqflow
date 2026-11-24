from typing import Optional
from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict, model_validator

class VitalsCreate(BaseModel):
    heart_rate: int = Field(..., ge=30, le=250, description="Heart rate in bpm (30-250)")
    blood_pressure_systolic: int = Field(..., ge=50, le=260, description="Systolic blood pressure in mmHg (50-260)")
    blood_pressure_diastolic: int = Field(..., ge=30, le=160, description="Diastolic blood pressure in mmHg (30-160)")
    oxygen_saturation: int = Field(..., ge=50, le=100, description="Oxygen saturation SpO2 percentage (50-100%)")
    respiratory_rate: int = Field(..., ge=5, le=60, description="Respiratory rate in breaths/min (5-60)")
    notes: Optional[str] = Field(None, max_length=1000, description="Patient condition / paramedic clinical notes")

    @model_validator(mode="after")
    def validate_blood_pressure(self):
        if self.blood_pressure_systolic <= self.blood_pressure_diastolic:
            raise ValueError(
                f"Systolic blood pressure ({self.blood_pressure_systolic}) must be greater than diastolic blood pressure ({self.blood_pressure_diastolic})"
            )
        return self

class VitalsOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    dispatch_id: int
    incident_id: int
    recorded_by_user_id: Optional[int] = None
    heart_rate: int
    blood_pressure_systolic: int
    blood_pressure_diastolic: int
    blood_pressure_display: Optional[str] = None
    oxygen_saturation: int
    respiratory_rate: int
    notes: Optional[str] = None
    recorded_at: datetime
    created_at: datetime
