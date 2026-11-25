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

    # Citizen Reporter linkage (nullable for walk-ins / legacy / anonymous calls)
    reporter_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)

    # Collision Alert Identification (e.g. ESP32 Ambulance Collision Simulator)
    is_collision_alert = Column(Boolean, default=False, index=True)
    incident_source = Column(String(50), default="MANUAL")

    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    # Relationships
    reporter = relationship("User", back_populates="reported_incidents")
    dispatches = relationship("Dispatch", back_populates="incident", cascade="all, delete-orphan")
    witness_reports = relationship("WitnessReport", foreign_keys="[WitnessReport.master_incident_id]", back_populates="master_incident")
    events = relationship("IncidentEvent", back_populates="incident", order_by="IncidentEvent.created_at.asc()", cascade="all, delete-orphan")

    @property
    def triage_justifications(self) -> List[str]:
        try:
            return json.loads(self.triage_justifications_json or "[]")
        except Exception:
            return []

    @triage_justifications.setter
    def triage_justifications(self, val: List[str]):
        self.triage_justifications_json = json.dumps(val or [])

    @property
    def witness_count(self) -> int:
        try:
            return len(self.witness_reports or [])
        except Exception:
            return 0


class Ambulance(Base):
    __tablename__ = "ambulances"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    call_sign = Column(String(60), unique=True, index=True, nullable=False)
    vehicle_type = Column(String(30), nullable=False)  # ALS, BLS, PATIENT_TRANSPORT
    equipment_json = Column(Text, default="[]")        # ["ventilator", "defibrillator", "oxygen", "ecg_monitor"]
    paramedic_level = Column(String(30), default="BASIC")  # ADVANCED, BASIC

    # Status: AVAILABLE, RESERVED, DISPATCHED, EN_ROUTE, ON_SCENE, TRANSPORTING, MAINTENANCE, OFF_DUTY
    status = Column(String(40), default="AVAILABLE", index=True)
    reservation_dispatch_id = Column(Integer, nullable=True)  # ID of dispatch holding provisional reservation

    base_station = Column(String(120), nullable=False)
    current_latitude = Column(Float, nullable=False)
    current_longitude = Column(Float, nullable=False)
    fuel_level_percent = Column(Integer, default=100)
    is_active = Column(Boolean, default=True)

    last_updated = Column(DateTime, default=utc_now, onupdate=utc_now)

    # Relationships
    dispatches = relationship("Dispatch", back_populates="ambulance")
    crew_users = relationship("User", back_populates="ambulance")

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
    facility_code = Column(String(50), unique=True, index=True, nullable=True)
    address = Column(String(255), nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)

    total_icu_beds = Column(Integer, default=10)
    available_icu_beds = Column(Integer, default=5)
    total_emergency_beds = Column(Integer, default=20)
    available_emergency_beds = Column(Integer, default=10)
    reserved_emergency_beds = Column(Integer, default=0, nullable=False)
    total_ward_beds = Column(Integer, default=50)
    available_ward_beds = Column(Integer, default=20)

    # Operational Readiness: READY, BUSY, DIVERT
    readiness_status = Column(String(30), default="READY", nullable=False)

    # Specialized departments
    # ["Trauma Level 1", "Cardiology", "Stroke Unit", "Pediatrics", "Burn Care", "Neurosurgery"]
    specialties_json = Column(Text, default="[]")

    # Doctors on shift and their availability: [{"name": "Dr. ...", "specialty": "...", "shift": "Day", "status": "AVAILABLE"}]
    doctors_availability_json = Column(Text, default="[]")

    accepting_emergencies = Column(Boolean, default=True)
    contact_number = Column(String(40), nullable=False)
    emergency_contact_person = Column(String(120), nullable=True)
    last_updated_by = Column(String(120), default="System Seed")

    # Additional Hospital Readiness Information
    oxygen_status = Column(String(50), default="NORMAL")  # NORMAL, REFILL_SCHEDULED, LOW, CRITICAL
    ventilators_total = Column(Integer, default=10)
    ventilators_available = Column(Integer, default=6)
    pediatric_beds_total = Column(Integer, default=10)
    pediatric_beds_available = Column(Integer, default=5)
    equipment_readiness_json = Column(Text, default="{}")  # {"ct_scanner": "OPERATIONAL", "cath_lab": "OPERATIONAL", ...}
    blood_bank_status_json = Column(Text, default="{}")    # {"O_NEG": "ADEQUATE", "O_POS": "ADEQUATE", ...}

    # Department & Operational Capability Management
    departments_json = Column(Text, default="[]")
    capabilities_json = Column(Text, default="{}")
    bed_capacity_breakdown_json = Column(Text, default="{}")
    facility_type = Column(String(100), default="Tertiary Multi-Specialty Hospital")
    emergency_department_hours = Column(String(60), default="24/7 Rapid Response")

    last_updated = Column(DateTime, default=utc_now, onupdate=utc_now)

    # Relationships
    dispatches = relationship("Dispatch", back_populates="destination_hospital")
    staff_users = relationship("User", back_populates="hospital")

    @property
    def occupied_emergency_beds(self) -> int:
        return max(
            0,
            (self.total_emergency_beds or 0)
            - (self.available_emergency_beds or 0)
            - (self.reserved_emergency_beds or 0),
        )

    @property
    def occupied_icu_beds(self) -> int:
        return max(0, (self.total_icu_beds or 0) - (self.available_icu_beds or 0))

    @property
    def occupied_ward_beds(self) -> int:
        return max(0, (self.total_ward_beds or 0) - (self.available_ward_beds or 0))

    @property
    def occupied_pediatric_beds(self) -> int:
        return max(0, (self.pediatric_beds_total or 0) - (self.pediatric_beds_available or 0))

    @property
    def equipment_readiness(self) -> dict:
        try:
            return json.loads(self.equipment_readiness_json or "{}")
        except Exception:
            return {}

    @equipment_readiness.setter
    def equipment_readiness(self, val: dict):
        self.equipment_readiness_json = json.dumps(val or {})

    @property
    def blood_bank_status(self) -> dict:
        try:
            return json.loads(self.blood_bank_status_json or "{}")
        except Exception:
            return {}

    @blood_bank_status.setter
    def blood_bank_status(self, val: dict):
        self.blood_bank_status_json = json.dumps(val or {})

    @property
    def specialties(self) -> List[str]:
        try:
            return json.loads(self.specialties_json or "[]")
        except Exception:
            return []

    @specialties.setter
    def specialties(self, val: List[str]):
        self.specialties_json = json.dumps(val or [])

    @property
    def doctors_availability(self) -> List[dict]:
        try:
            return json.loads(self.doctors_availability_json or "[]")
        except Exception:
            return []

    @doctors_availability.setter
    def doctors_availability(self, val: List[dict]):
        self.doctors_availability_json = json.dumps(val or [])

    @property
    def departments(self) -> List[dict]:
        try:
            depts = json.loads(self.departments_json or "[]")
            if depts:
                return depts
        except Exception:
            pass
        return [
            {
                "id": "dept_er",
                "name": "Emergency Medicine",
                "operational_status": "ACTIVE",
                "operating_hours": "24/7",
                "emergency_coverage": True,
                "specialty_availability": ["Emergency Medicine", "Resuscitation", "Acute Triage"],
                "notes": "Level 1 Emergency & Resuscitation Bays open 24/7",
            },
            {
                "id": "dept_icu",
                "name": "Critical Care / ICU",
                "operational_status": "ACTIVE",
                "operating_hours": "24/7",
                "emergency_coverage": True,
                "specialty_availability": ["Intensive Care", "Mechanical Ventilation"],
                "notes": "Multidisciplinary Adult & Neuro ICU",
            },
            {
                "id": "dept_cardio",
                "name": "Cardiology",
                "operational_status": "ACTIVE",
                "operating_hours": "24/7",
                "emergency_coverage": True,
                "specialty_availability": ["Cardiology", "Interventional Cardiology"],
                "notes": "Primary PCI / Digital Cath Lab on 24/7 standby",
            },
            {
                "id": "dept_trauma",
                "name": "Trauma & Orthopedics",
                "operational_status": "ACTIVE",
                "operating_hours": "24/7",
                "emergency_coverage": True,
                "specialty_availability": ["Trauma Surgery", "Orthopedic Surgery"],
                "notes": "Polytrauma resuscitation and surgical suites",
            },
            {
                "id": "dept_neuro",
                "name": "Neurology & Stroke",
                "operational_status": "ACTIVE",
                "operating_hours": "24/7",
                "emergency_coverage": True,
                "specialty_availability": ["Neurology", "Stroke Thrombolysis"],
                "notes": "Rapid Code Stroke protocol with immediate CT angiography",
            },
            {
                "id": "dept_surgery",
                "name": "General Surgery",
                "operational_status": "ACTIVE",
                "operating_hours": "24/7",
                "emergency_coverage": True,
                "specialty_availability": ["General Surgery", "Acute Abdominal Surgery"],
                "notes": "Emergency laparotomy and acute abdominal coverage",
            },
            {
                "id": "dept_peds",
                "name": "Pediatrics",
                "operational_status": "ACTIVE",
                "operating_hours": "24/7",
                "emergency_coverage": True,
                "specialty_availability": ["Pediatric Emergency", "Neonatology"],
                "notes": "Dedicated PICU/NICU bays and pediatric resuscitation",
            },
            {
                "id": "dept_obgyn",
                "name": "Obstetrics & Gynecology",
                "operational_status": "ACTIVE",
                "operating_hours": "24/7",
                "emergency_coverage": True,
                "specialty_availability": ["Obstetrics", "Emergency C-Section"],
                "notes": "Immediate emergency delivery suite and fetal monitoring",
            },
            {
                "id": "dept_anesth",
                "name": "Anesthesiology",
                "operational_status": "ACTIVE",
                "operating_hours": "24/7",
                "emergency_coverage": True,
                "specialty_availability": ["Trauma Anesthesia", "Airway Management"],
                "notes": "24/7 resident trauma anesthesiology team",
            },
            {
                "id": "dept_radiology",
                "name": "Radiology & Imaging",
                "operational_status": "ACTIVE",
                "operating_hours": "24/7",
                "emergency_coverage": True,
                "specialty_availability": ["Multi-Slice CT", "Emergency Ultrasound", "X-Ray"],
                "notes": "24/7 emergency diagnostic radiologist on duty",
            },
        ]

    @departments.setter
    def departments(self, val: List[dict]):
        self.departments_json = json.dumps(val or [])

    @property
    def capabilities(self) -> dict:
        try:
            caps = json.loads(self.capabilities_json or "{}")
            if caps:
                return caps
        except Exception:
            pass
        return {
            "cardiac_emergency": "AVAILABLE",
            "trauma_capability": "AVAILABLE",
            "icu_availability": "AVAILABLE",
            "ventilator_availability": "AVAILABLE",
            "defibrillator_availability": "AVAILABLE",
            "emergency_imaging": "AVAILABLE",
            "operating_theatre": "AVAILABLE",
            "blood_bank": "AVAILABLE",
        }

    @capabilities.setter
    def capabilities(self, val: dict):
        self.capabilities_json = json.dumps(val or {})

    @property
    def bed_capacity_breakdown(self) -> dict:
        try:
            b = json.loads(self.bed_capacity_breakdown_json or "{}")
            if b and "emergency" in b and "icu" in b:
                return b
        except Exception:
            pass
        # Derive defaults from existing columns
        er_tot = self.total_emergency_beds or 20
        er_occ = self.occupied_emergency_beds
        er_res = self.reserved_emergency_beds or 0
        er_unavail = 0
        er_avail = max(0, er_tot - er_occ - er_res - er_unavail)

        icu_tot = self.total_icu_beds or 10
        icu_occ = self.occupied_icu_beds
        icu_res = 0
        icu_unavail = 0
        icu_avail = max(0, icu_tot - icu_occ - icu_res - icu_unavail)

        hdu_tot = 8
        hdu_occ = 2
        hdu_res = 0
        hdu_unavail = 0
        hdu_avail = max(0, hdu_tot - hdu_occ - hdu_res - hdu_unavail)

        ward_tot = self.total_ward_beds or 50
        ward_occ = self.occupied_ward_beds
        ward_res = 0
        ward_unavail = 0
        ward_avail = max(0, ward_tot - ward_occ - ward_res - ward_unavail)

        iso_tot = 6
        iso_occ = 1
        iso_res = 0
        iso_unavail = 0
        iso_avail = max(0, iso_tot - iso_occ - iso_res - iso_unavail)

        ped_tot = self.pediatric_beds_total or 10
        ped_occ = self.occupied_pediatric_beds
        ped_res = 0
        ped_unavail = 0
        ped_avail = max(0, ped_tot - ped_occ - ped_res - ped_unavail)

        return {
            "emergency": {"name": "Emergency / ER", "total": er_tot, "occupied": er_occ, "reserved": er_res, "unavailable": er_unavail, "available": er_avail},
            "icu": {"name": "Intensive Care Unit (ICU)", "total": icu_tot, "occupied": icu_occ, "reserved": icu_res, "unavailable": icu_unavail, "available": icu_avail},
            "hdu": {"name": "High Dependency Unit (HDU)", "total": hdu_tot, "occupied": hdu_occ, "reserved": hdu_res, "unavailable": hdu_unavail, "available": hdu_avail},
            "general_ward": {"name": "General Inpatient Ward", "total": ward_tot, "occupied": ward_occ, "reserved": ward_res, "unavailable": ward_unavail, "available": ward_avail},
            "isolation": {"name": "Isolation / Airborne Infection", "total": iso_tot, "occupied": iso_occ, "reserved": iso_res, "unavailable": iso_unavail, "available": iso_avail},
            "pediatric": {"name": "Pediatric Ward", "total": ped_tot, "occupied": ped_occ, "reserved": ped_res, "unavailable": ped_unavail, "available": ped_avail},
        }

    @bed_capacity_breakdown.setter
    def bed_capacity_breakdown(self, val: dict):
        self.bed_capacity_breakdown_json = json.dumps(val or {})


class Dispatch(Base):
    __tablename__ = "dispatches"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    incident_id = Column(Integer, ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False, index=True)
    ambulance_id = Column(Integer, ForeignKey("ambulances.id", ondelete="CASCADE"), nullable=False, index=True)
    destination_hospital_id = Column(Integer, ForeignKey("hospitals.id", ondelete="SET NULL"), nullable=True, index=True)

    # Lifecycle status: ASSIGNED, ACKNOWLEDGED, EN_ROUTE_INCIDENT, ON_SCENE, EN_ROUTE_HOSPITAL, COMPLETED, CANCELLED
    status = Column(String(40), default="ASSIGNED", index=True)

    # Hospital Preparation Workflow Status
    # NOT_STARTED, TEAM_NOTIFIED, BAY_PREPARED, SPECIALISTS_STANDBY, READY_FOR_ARRIVAL
    hospital_preparation_status = Column(String(40), default="NOT_STARTED", nullable=False)
    hospital_preparation_notes = Column(Text, nullable=True)
    hospital_acknowledged_at = Column(DateTime, nullable=True)
    patient_arrived_hospital_confirmed_at = Column(DateTime, nullable=True)

    # Dual Confirmation & Reservation State
    # PENDING_CONFIRMATIONS, CONFIRMED, REJECTED, EXPIRED, REASSIGNMENT_REQUIRED
    coordination_status = Column(String(40), default="PENDING_CONFIRMATIONS", index=True, nullable=False)
    ambulance_confirmation_status = Column(String(20), default="PENDING", nullable=False)  # PENDING, ACCEPTED, REJECTED
    hospital_confirmation_status = Column(String(20), default="PENDING", nullable=False)   # PENDING, ACCEPTED, REJECTED

    reservation_expires_at = Column(DateTime, nullable=True)
    ambulance_confirmed_at = Column(DateTime, nullable=True)
    hospital_confirmed_at = Column(DateTime, nullable=True)
    confirmed_at = Column(DateTime, nullable=True)

    rejection_source = Column(String(30), nullable=True)  # AMBULANCE, HOSPITAL, TIMEOUT
    rejection_reason = Column(Text, nullable=True)
    attempt_number = Column(Integer, default=1, nullable=False)
    escalation_history_json = Column(Text, default="[]")  # JSON audit trail of all escalation attempts

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
    handover_packet = relationship("HandoverPacket", back_populates="dispatch", uselist=False, cascade="all, delete-orphan")
    vitals = relationship("PatientVitals", back_populates="dispatch", order_by="PatientVitals.recorded_at.desc()", cascade="all, delete-orphan")

    @property
    def latest_vitals(self):
        if self.vitals:
            return self.vitals[0]
        return None

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
    def escalation_history(self) -> list:
        try:
            return json.loads(self.escalation_history_json or "[]")
        except Exception:
            return []

    @escalation_history.setter
    def escalation_history(self, val: list):
        self.escalation_history_json = json.dumps(val or [])

    @property
    def route_geometry(self) -> list:
        try:
            return json.loads(self.route_geometry_json or "[]")
        except Exception:
            return []

    @route_geometry.setter
    def route_geometry(self, val: list):
        self.route_geometry_json = json.dumps(val or [])

    @property
    def incident_latitude(self) -> Optional[float]:
        return self.incident.latitude if self.incident else None

    @property
    def incident_longitude(self) -> Optional[float]:
        return self.incident.longitude if self.incident else None

    @property
    def incident_address(self) -> Optional[str]:
        return self.incident.location_address if self.incident else None

    @property
    def destination_hospital_latitude(self) -> Optional[float]:
        return self.destination_hospital.latitude if self.destination_hospital else None

    @property
    def destination_hospital_longitude(self) -> Optional[float]:
        return self.destination_hospital.longitude if self.destination_hospital else None

    @property
    def destination_hospital_address(self) -> Optional[str]:
        return self.destination_hospital.address if self.destination_hospital else None

    @property
    def destination_hospital_name(self) -> Optional[str]:
        return self.destination_hospital.name if self.destination_hospital else None

    @property
    def ambulance_call_sign(self) -> Optional[str]:
        return self.ambulance.call_sign if self.ambulance else None

    @property
    def ambulance_vehicle_type(self) -> Optional[str]:
        return self.ambulance.vehicle_type if self.ambulance else None

    @property
    def ambulance_current_latitude(self) -> Optional[float]:
        return self.ambulance.current_latitude if self.ambulance else None

    @property
    def ambulance_current_longitude(self) -> Optional[float]:
        return self.ambulance.current_longitude if self.ambulance else None


class HandoverPacket(Base):
    __tablename__ = "handover_packets"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    dispatch_id = Column(Integer, ForeignKey("dispatches.id", ondelete="CASCADE"), unique=True, nullable=False, index=True)
    incident_id = Column(Integer, ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False, index=True)

    status = Column(String(30), default="SENT", nullable=False)  # PENDING, SENT, REVIEWED, ACKNOWLEDGED, COMPLETED
    acknowledged_at = Column(DateTime, nullable=True)
    acknowledged_by = Column(String(120), nullable=True)
    reviewed_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    receiving_clinician = Column(String(120), nullable=True)
    receiving_notes = Column(Text, nullable=True)

    patient_age = Column(Integer, nullable=True)
    patient_gender = Column(String(30), nullable=True)
    chief_complaint = Column(Text, nullable=False)
    reported_symptoms_json = Column(Text, default="[]")

    triage_priority = Column(String(40), nullable=False)
    triage_color = Column(String(20), default="GREEN")
    triage_score = Column(Integer, default=30)
    triage_justifications_json = Column(Text, default="[]")

    incident_latitude = Column(Float, nullable=False)
    incident_longitude = Column(Float, nullable=False)
    incident_address = Column(String(255), nullable=True)

    ambulance_call_sign = Column(String(60), nullable=False)
    ambulance_vehicle_type = Column(String(30), nullable=False)
    paramedic_level = Column(String(30), default="BASIC")
    required_equipment_json = Column(Text, default="[]")

    receiving_hospital_id = Column(Integer, nullable=True)
    receiving_hospital_name = Column(String(120), nullable=True)

    estimated_arrival_eta_seconds = Column(Float, nullable=True)
    route_distance_meters = Column(Float, nullable=True)

    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    # Relationships
    dispatch = relationship("Dispatch", back_populates="handover_packet")
    incident = relationship("Incident")

    @property
    def reported_symptoms(self) -> List[str]:
        try:
            return json.loads(self.reported_symptoms_json or "[]")
        except Exception:
            return []

    @reported_symptoms.setter
    def reported_symptoms(self, val: List[str]):
        self.reported_symptoms_json = json.dumps(val or [])

    @property
    def triage_justifications(self) -> List[str]:
        try:
            return json.loads(self.triage_justifications_json or "[]")
        except Exception:
            return []

    @triage_justifications.setter
    def triage_justifications(self, val: List[str]):
        self.triage_justifications_json = json.dumps(val or [])

    @property
    def required_equipment(self) -> List[str]:
        try:
            return json.loads(self.required_equipment_json or "[]")
        except Exception:
            return []

    @required_equipment.setter
    def required_equipment(self, val: List[str]):
        self.required_equipment_json = json.dumps(val or [])

    @property
    def latest_vitals(self):
        if self.dispatch and self.dispatch.latest_vitals:
            return self.dispatch.latest_vitals
        return None

    @property
    def vitals(self):
        if self.dispatch and self.dispatch.vitals:
            return self.dispatch.vitals
        return []

    @property
    def mission_status(self) -> Optional[str]:
        if self.dispatch:
            return self.dispatch.status
        return None

    @property
    def incident_status(self) -> Optional[str]:
        if self.incident:
            return self.incident.status
        if self.dispatch and self.dispatch.incident:
            return self.dispatch.incident.status
        return None


class WitnessReport(Base):
    __tablename__ = "witness_reports"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    master_incident_id = Column(Integer, ForeignKey("incidents.id", ondelete="SET NULL"), nullable=True, index=True)
    reporter_identifier = Column(String(100), nullable=False)  # e.g. "Witness A", "Anonymous Passerby"
    incident_description = Column(Text, nullable=False)
    incident_type = Column(String(60), default="Road Traffic Accident", nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    reported_at = Column(DateTime, default=utc_now, nullable=False)

    duplicate_probability = Column(Float, nullable=True)  # 0.0 - 1.0 (or percentage)
    matching_incident_id = Column(Integer, ForeignKey("incidents.id", ondelete="SET NULL"), nullable=True)
    matching_distance_meters = Column(Float, nullable=True)
    matching_time_difference_seconds = Column(Float, nullable=True)
    matching_explanation = Column(Text, nullable=True)

    # Status: NEW, POSSIBLE_DUPLICATE, CONFIRMED_DUPLICATE, DISTINCT
    review_status = Column(String(30), default="NEW", index=True, nullable=False)
    audit_trail_json = Column(Text, default="[]")

    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    # Relationships
    master_incident = relationship("Incident", foreign_keys=[master_incident_id], back_populates="witness_reports")
    suggested_incident = relationship("Incident", foreign_keys=[matching_incident_id])

    @property
    def audit_trail(self) -> list:
        try:
            return json.loads(self.audit_trail_json or "[]")
        except Exception:
            return []

    @audit_trail.setter
    def audit_trail(self, val: list):
        self.audit_trail_json = json.dumps(val or [])


class IncidentEvent(Base):
    __tablename__ = "incident_events"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    incident_id = Column(Integer, ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False, index=True)
    dispatch_id = Column(Integer, ForeignKey("dispatches.id", ondelete="SET NULL"), nullable=True, index=True)

    event_type = Column(String(60), nullable=False, index=True)
    event_title = Column(String(120), nullable=False)
    event_description = Column(Text, nullable=False)
    actor_type = Column(String(40), default="SYSTEM", nullable=False)  # SYSTEM, DISPATCHER, AMBULANCE_CREW, HOSPITAL_ER, WITNESS, CALLER
    actor_reference = Column(String(120), nullable=True)
    event_metadata_json = Column(Text, default="{}")

    created_at = Column(DateTime, default=utc_now, nullable=False, index=True)

    # Relationships
    incident = relationship("Incident", back_populates="events")
    dispatch = relationship("Dispatch")

    @property
    def event_metadata(self) -> dict:
        try:
            return json.loads(self.event_metadata_json or "{}")
        except Exception:
            return {}

    @event_metadata.setter
    def event_metadata(self, val: dict):
        self.event_metadata_json = json.dumps(val or {})


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    email = Column(String(160), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    full_name = Column(String(160), nullable=False)
    # Role: CITIZEN, AMBULANCE_CREW, HOSPITAL_STAFF, DISPATCHER, SUPER_ADMIN
    role = Column(String(40), index=True, nullable=False)

    # Scoped affiliations
    hospital_id = Column(Integer, ForeignKey("hospitals.id", ondelete="SET NULL"), nullable=True)
    ambulance_id = Column(Integer, ForeignKey("ambulances.id", ondelete="SET NULL"), nullable=True)

    phone_number = Column(String(40), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)

    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    # Relationships
    hospital = relationship("Hospital", back_populates="staff_users")
    ambulance = relationship("Ambulance", back_populates="crew_users")
    reported_incidents = relationship("Incident", back_populates="reporter")


class CrashAlert(Base):
    __tablename__ = "crash_alerts"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    ambulance_id = Column(Integer, ForeignKey("ambulances.id", ondelete="CASCADE"), nullable=False, index=True)
    incident_id = Column(Integer, ForeignKey("incidents.id", ondelete="SET NULL"), nullable=True, index=True)
    hospital_id = Column(Integer, ForeignKey("hospitals.id", ondelete="CASCADE"), nullable=False, index=True)
    dispatch_id = Column(Integer, ForeignKey("dispatches.id", ondelete="SET NULL"), nullable=True, index=True)

    # Source: HARDWARE_IOT (future ESP32/GPS/IMU hardware), DEMO_SIMULATION
    source = Column(String(30), default="DEMO_SIMULATION", nullable=False)
    # Severity: MINOR, MODERATE, SEVERE, CRITICAL
    severity = Column(String(30), default="CRITICAL", nullable=False)

    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    location_description = Column(String(255), nullable=True)

    # Telemetry / Sensor Information: {"g_force": 4.8, "rollover": True, "impact_velocity_kmh": 62, "airbag_deployed": True}
    sensor_data_json = Column(Text, default="{}")

    # Acknowledgment & Hospital Response Status:
    # TRIGGERED, ACKNOWLEDGED, TEAM_NOTIFIED, BACKUP_REQUESTED, RESOLVED
    status = Column(String(40), default="TRIGGERED", nullable=False)
    acknowledged_at = Column(DateTime, nullable=True)
    acknowledged_by = Column(String(120), nullable=True)
    response_notes = Column(Text, nullable=True)

    created_at = Column(DateTime, default=utc_now, nullable=False, index=True)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    # Relationships
    ambulance = relationship("Ambulance")
    hospital = relationship("Hospital")
    incident = relationship("Incident")
    dispatch = relationship("Dispatch")

    @property
    def ambulance_call_sign(self) -> Optional[str]:
        return self.ambulance.call_sign if self.ambulance else None

    @property
    def hospital_name(self) -> Optional[str]:
        return self.hospital.name if self.hospital else None

    @property
    def sensor_data(self) -> dict:
        try:
            return json.loads(self.sensor_data_json or "{}")
        except Exception:
            return {}

    @sensor_data.setter
    def sensor_data(self, val: dict):
        self.sensor_data_json = json.dumps(val or {})


class PatientVitals(Base):
    __tablename__ = "patient_vitals"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    dispatch_id = Column(Integer, ForeignKey("dispatches.id", ondelete="CASCADE"), nullable=False, index=True)
    incident_id = Column(Integer, ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False, index=True)
    recorded_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    heart_rate = Column(Integer, nullable=False)               # bpm (30-250)
    blood_pressure_systolic = Column(Integer, nullable=False)   # mmHg (50-260)
    blood_pressure_diastolic = Column(Integer, nullable=False)  # mmHg (30-160)
    oxygen_saturation = Column(Integer, nullable=False)        # SpO2 % (50-100)
    respiratory_rate = Column(Integer, nullable=False)         # breaths/min (5-60)
    notes = Column(Text, nullable=True)                        # Paramedic notes / condition description

    recorded_at = Column(DateTime, default=utc_now, nullable=False)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    # Relationships
    dispatch = relationship("Dispatch", back_populates="vitals")
    incident = relationship("Incident")
    recorded_by = relationship("User")

    @property
    def blood_pressure_display(self) -> str:
        return f"{self.blood_pressure_systolic}/{self.blood_pressure_diastolic}"


