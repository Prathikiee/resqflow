from typing import Optional, Dict, Any, List
from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict
from backend.app.schemas.vitals import VitalsOut

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

class MissionAssistanceRequest(BaseModel):
    assistance_type: str = Field(..., description="POLICE, FIRE, BACKUP_AMBULANCE, or CONTROL_ROOM")
    notes: Optional[str] = None

class AlternativeAmbulanceRequest(BaseModel):
    reason: str = Field(..., description="Reason for requesting alternative ambulance (e.g. Collision Detected on Route, Unit Delayed, Vehicle Breakdown, High Acuity Critical Care Needed)")
    notes: Optional[str] = None
    hospital_id: Optional[int] = None

class PatientNotPickedUpRequest(BaseModel):
    reason: str = Field(..., description="Reason patient was not picked up (e.g. Patient Refused Transport (AMA), Patient Deceased on Scene, Gone on Arrival (GOA), Treated at Scene - No Transport Needed, Cancelled by Police)")
    notes: Optional[str] = None


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

    # Pre-hospital Clinical Vitals & Mission Status
    latest_vitals: Optional[VitalsOut] = None
    vitals: List[VitalsOut] = []
    mission_status: Optional[str] = None
    incident_status: Optional[str] = None

    created_at: datetime
    updated_at: datetime

class IncidentSummaryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    caller_name: str
    caller_phone: str
    location_address: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    chief_complaint: str
    triage_level: str
    triage_color: str
    status: str

class DispatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    incident_id: int
    ambulance_id: int
    destination_hospital_id: Optional[int] = None
    status: str

    # Embedded incident details for field responder and hospital context
    incident: Optional[IncidentSummaryOut] = None

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

    # Alternative ambulance & pickup failure tracking
    alternative_ambulance_requested: Optional[bool] = False
    alternative_ambulance_reason: Optional[str] = None
    patient_pickup_status: Optional[str] = None
    patient_pickup_failure_reason: Optional[str] = None

    # Emergency Handover Packet
    handover_packet: Optional[HandoverPacketOut] = None

    # Patient Vitals Telemetry
    vitals: List[VitalsOut] = []
    latest_vitals: Optional[VitalsOut] = None

    # Embedded location coordinates for turn-by-turn navigation
    incident_latitude: Optional[float] = None
    incident_longitude: Optional[float] = None
    incident_address: Optional[str] = None
    destination_hospital_name: Optional[str] = None
    destination_hospital_address: Optional[str] = None
    destination_hospital_latitude: Optional[float] = None
    destination_hospital_longitude: Optional[float] = None
    ambulance_call_sign: Optional[str] = None
    ambulance_vehicle_type: Optional[str] = None
    ambulance_current_latitude: Optional[float] = None
    ambulance_current_longitude: Optional[float] = None

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
