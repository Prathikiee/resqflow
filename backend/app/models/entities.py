from datetime import datetime, timezone
import json
from typing import List, Optional
from sqlalchemy import (
    Column,
    Integer,
    String,
    Float,
    Boolean,
    DateTime,
    ForeignKey,
    Text,
)
from sqlalchemy.orm import relationship
from backend.app.core.database import Base

def utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)

class Incident(Base):
    __tablename__ = "incidents"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    caller_name = Column(String(120), nullable=False)
    caller_phone = Column(String(30), nullable=False)
    location_address = Column(String(255), nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    chief_complaint = Column(Text, nullable=False)

    patient_age = Column(Integer, nullable=True)
    patient_gender = Column(String(20), nullable=True)

    # Clinical assessment flags
    consciousness_level = Column(String(30), default="Alert")  # Alert, Voice, Pain, Unresponsive
    breathing_status = Column(String(30), default="Normal")     # Normal, Difficult, Absent
    severe_bleeding = Column(Boolean, default=False)
    chest_pain = Column(Boolean, default=False)
    suspected_stroke = Column(Boolean, default=False)
    severe_trauma = Column(Boolean, default=False)

    # Explainable Triage Output
    triage_level = Column(String(40), default="Priority 3 (Standard)")  # Priority 1, Priority 2, Priority 3
    triage_color = Column(String(20), default="GREEN")                  # RED, YELLOW, GREEN
    triage_score = Column(Integer, default=30)                          # 0 - 100
    triage_justifications_json = Column(Text, default="[]")            # JSON serialized list of rule triggers
    required_ambulance_type = Column(String(20), default="BLS")         # ALS, BLS

    # Lifecycle status
    # REPORTED -> TRIAGED -> ALLOCATED -> DISPATCHED -> EN_ROUTE -> ON_SCENE -> TRANSPORTING -> AT_HOSPITAL -> RESOLVED
    status = Column(String(40), default="REPORTED", index=True)

    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    # Relationships
    dispatches = relationship("Dispatch", back_populates="incident", cascade="all, delete-orphan")

    @property
    def triage_justifications(self) -> List[str]:
        try:
            return json.loads(self.triage_justifications_json or "[]")
        except Exception:
            return []

    @triage_justifications.setter
    def triage_justifications(self, val: List[str]):
        self.triage_justifications_json = json.dumps(val or [])


class Ambulance(Base):
    __tablename__ = "ambulances"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    call_sign = Column(String(60), unique=True, index=True, nullable=False)
    vehicle_type = Column(String(30), nullable=False)  # ALS, BLS, PATIENT_TRANSPORT
    equipment_json = Column(Text, default="[]")        # ["ventilator", "defibrillator", "oxygen", "ecg_monitor"]
    paramedic_level = Column(String(30), default="BASIC")  # ADVANCED, BASIC

    # Status: AVAILABLE, DISPATCHED, EN_ROUTE, ON_SCENE, TRANSPORTING, MAINTENANCE, OFF_DUTY
    status = Column(String(40), default="AVAILABLE", index=True)

    base_station = Column(String(120), nullable=False)
    current_latitude = Column(Float, nullable=False)
    current_longitude = Column(Float, nullable=False)
    fuel_level_percent = Column(Integer, default=100)
    is_active = Column(Boolean, default=True)

    last_updated = Column(DateTime, default=utc_now, onupdate=utc_now)

    # Relationships
    dispatches = relationship("Dispatch", back_populates="ambulance")

    @property
    def equipment(self) -> List[str]:
        try:
            return json.loads(self.equipment_json or "[]")
        except Exception:
            return []

    @equipment.setter
    def equipment(self, val: List[str]):
        self.equipment_json = json.dumps(val or [])


class Hospital(Base):
    __tablename__ = "hospitals"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(160), unique=True, index=True, nullable=False)
    address = Column(String(255), nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)

    total_icu_beds = Column(Integer, default=10)
    available_icu_beds = Column(Integer, default=5)
    total_emergency_beds = Column(Integer, default=20)
    available_emergency_beds = Column(Integer, default=10)

    # Specialized departments
    # ["Trauma Level 1", "Cardiology", "Stroke Unit", "Pediatrics", "Burn Care", "Neurosurgery"]
    specialties_json = Column(Text, default="[]")
    accepting_emergencies = Column(Boolean, default=True)
    contact_number = Column(String(40), nullable=False)

    last_updated = Column(DateTime, default=utc_now, onupdate=utc_now)

    # Relationships
    dispatches = relationship("Dispatch", back_populates="destination_hospital")

    @property
    def specialties(self) -> List[str]:
        try:
            return json.loads(self.specialties_json or "[]")
        except Exception:
            return []

    @specialties.setter
    def specialties(self, val: List[str]):
        self.specialties_json = json.dumps(val or [])


class Dispatch(Base):
    __tablename__ = "dispatches"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    incident_id = Column(Integer, ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False, index=True)
    ambulance_id = Column(Integer, ForeignKey("ambulances.id", ondelete="CASCADE"), nullable=False, index=True)
    destination_hospital_id = Column(Integer, ForeignKey("hospitals.id", ondelete="SET NULL"), nullable=True, index=True)

    # Lifecycle status: ASSIGNED, ACKNOWLEDGED, EN_ROUTE_INCIDENT, ON_SCENE, EN_ROUTE_HOSPITAL, COMPLETED, CANCELLED
    status = Column(String(40), default="ASSIGNED", index=True)

    dispatched_at = Column(DateTime, default=utc_now, nullable=False)
    arrived_incident_at = Column(DateTime, nullable=True)
    departed_incident_at = Column(DateTime, nullable=True)
    arrived_hospital_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)

    estimated_eta_seconds = Column(Float, nullable=True)
    actual_response_seconds = Column(Float, nullable=True)
    route_distance_meters = Column(Float, nullable=True)

    # Multi-factor explainability trace
    allocation_score = Column(Float, nullable=True)
    allocation_breakdown_json = Column(Text, nullable=True)  # JSON dictionary with weights & sub-scores
    route_geometry_json = Column(Text, nullable=True)        # JSON coordinates array for map line

    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    # Relationships
    incident = relationship("Incident", back_populates="dispatches")
    ambulance = relationship("Ambulance", back_populates="dispatches")
    destination_hospital = relationship("Hospital", back_populates="dispatches")

    @property
    def allocation_breakdown(self) -> dict:
        try:
            return json.loads(self.allocation_breakdown_json or "{}")
        except Exception:
            return {}

    @allocation_breakdown.setter
    def allocation_breakdown(self, val: dict):
        self.allocation_breakdown_json = json.dumps(val or {})

    @property
    def route_geometry(self) -> list:
        try:
            return json.loads(self.route_geometry_json or "[]")
        except Exception:
            return []

    @route_geometry.setter
    def route_geometry(self, val: list):
        self.route_geometry_json = json.dumps(val or [])
