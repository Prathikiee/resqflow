from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field, ConfigDict

class LoginRequest(BaseModel):
    email: str = Field(..., description="User login email")
    password: str = Field(..., min_length=4, description="User password")

class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    full_name: str
    role: str
    hospital_id: Optional[int] = None
    hospital_name: Optional[str] = None
    hospital_facility_code: Optional[str] = None
    ambulance_id: Optional[int] = None
    ambulance_call_sign: Optional[str] = None
    phone_number: Optional[str] = None
    is_active: bool = True
    created_at: Optional[datetime] = None

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut

class UserCreateRequest(BaseModel):
    email: str = Field(..., description="User email address")
    password: str = Field(..., min_length=6, description="Password (min 6 characters)")
    full_name: str = Field(..., description="Full display name")
    role: str = Field(..., description="Role: CITIZEN, AMBULANCE_CREW, HOSPITAL_STAFF, DISPATCHER, SUPER_ADMIN")
    hospital_id: Optional[int] = None
    ambulance_id: Optional[int] = None
    phone_number: Optional[str] = None
