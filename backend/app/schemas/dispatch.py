from typing import Optional, Dict, Any, List
from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict

class DispatchRequest(BaseModel):
    incident_id: int
    ambulance_id: int
    destination_hospital_id: Optional[int] = None

class IncidentStatusUpdate(BaseModel):
    status: str = Field(..., description="REPORTED, TRIAGED, ALLOCATED, DISPATCHED, EN_ROUTE, ON_SCENE, TRANSPORTING, AT_HOSPITAL, RESOLVED, CLOSED, CANCELLED")

class IncidentCancelRequest(BaseModel):
    reason: Optional[str] = "Emergency request cancelled by reporter"

class IncidentCloseRequest(BaseModel):
    resolution_notes: Optional[str] = None

class PreflightValidationOut(BaseModel):
    is_valid: bool
    incident_id: int
    ambulance_id: Optional[int] = None
    hospital_id: Optional[int] = None
    errors: List[str] = []
    warnings: List[str] = []

class ConfirmationDecision(BaseModel):
    decision: str = Field(..., description="ACCEPTED or REJECTED")
    reason: Optional[str] = None
    attempt_number: Optional[int] = None

class SimulateDecisionRequest(BaseModel):
    party: str = Field(..., description="AMBULANCE, HOSPITAL, or BOTH")
    decision: str = Field(..., description="ACCEPTED or REJECTED")
    reason: Optional[str] = None

class HandoverAcknowledgeRequest(BaseModel):
    acknowledged_by: Optional[str] = None
    receiving_notes: Optional[str] = None
    receiving_clinician: Optional[str] = None

class HandoverReviewRequest(BaseModel):
    reviewed_by: Optional[str] = None
    receiving_notes: Optional[str] = None

class HandoverCompleteRequest(BaseModel):
    completed_by: Optional[str] = None
    receiving_notes: Optional[str] = None

class HospitalPreparationUpdate(BaseModel):
    preparation_status: str = Field(..., description="NOT_STARTED, TEAM_NOTIFIED, BAY_PREPARED, SPECIALISTS_STANDBY, READY_FOR_ARRIVAL")
    preparation_notes: Optional[str] = None
    acknowledged_by: Optional[str] = None


class HandoverPacketOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    dispatch_id: int
    incident_id: int
    status: str
    acknowledged_at: Optional[datetime] = None
    acknowledged_by: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    receiving_clinician: Optional[str] = None
    receiving_notes: Optional[str] = None

    patient_age: Optional[int] = None
    patient_gender: Optional[str] = "Unknown"
    chief_complaint: str
    reported_symptoms: List[str] = []

    triage_priority: str
    triage_color: str
    triage_score: int
    triage_justifications: List[str] = []

    incident_latitude: float
    incident_longitude: float
    incident_address: Optional[str] = None

    ambulance_call_sign: str
    ambulance_vehicle_type: str
    paramedic_level: Optional[str] = "BASIC"
    required_equipment: List[str] = []

    receiving_hospital_id: Optional[int] = None
    receiving_hospital_name: Optional[str] = None

    estimated_arrival_eta_seconds: Optional[float] = None
    route_distance_meters: Optional[float] = None

    created_at: datetime
    updated_at: datetime

class DispatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    incident_id: int
    ambulance_id: int
    destination_hospital_id: Optional[int] = None
    status: str

    # Hospital Preparation Workflow fields
    hospital_preparation_status: str = "NOT_STARTED"
    hospital_preparation_notes: Optional[str] = None
    hospital_acknowledged_at: Optional[datetime] = None
    patient_arrived_hospital_confirmed_at: Optional[datetime] = None

    # Dual confirmation & reservation fields
    coordination_status: str = "PENDING_CONFIRMATIONS"
    ambulance_confirmation_status: str = "PENDING"
    hospital_confirmation_status: str = "PENDING"
    reservation_expires_at: Optional[datetime] = None
    ambulance_confirmed_at: Optional[datetime] = None
    hospital_confirmed_at: Optional[datetime] = None
    confirmed_at: Optional[datetime] = None
    rejection_source: Optional[str] = None
    rejection_reason: Optional[str] = None
    attempt_number: int = 1
    escalation_history: Optional[List[Dict[str, Any]]] = None

    # Emergency Handover Packet
    handover_packet: Optional[HandoverPacketOut] = None

    # Embedded location coordinates for turn-by-turn navigation
    incident_latitude: Optional[float] = None
    incident_longitude: Optional[float] = None
    incident_address: Optional[str] = None
    destination_hospital_name: Optional[str] = None
    destination_hospital_address: Optional[str] = None
    destination_hospital_latitude: Optional[float] = None
    destination_hospital_longitude: Optional[float] = None
    ambulance_call_sign: Optional[str] = None

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
