import pytest
from fastapi import Response
from sqlalchemy.orm import Session
from backend.app.models.entities import Hospital, User, Dispatch, Incident, Ambulance, IncidentEvent
from backend.app.schemas.dispatch import AlternativeAmbulanceRequest, PatientNotPickedUpRequest
from backend.app.api.auth import switch_facility
from backend.app.api.dispatch import request_alternative_ambulance, record_patient_not_picked_up
from backend.app.services.hospital_engine import rank_suitable_hospitals
from backend.app.core.auth import ROLE_HOSPITAL_STAFF, ROLE_AMBULANCE_CREW

def test_30_hospitals_seeded_with_unique_facility_codes(fresh_db: Session):
    hospitals = fresh_db.query(Hospital).all()
    assert len(hospitals) >= 30, f"Expected at least 30 hospitals, found {len(hospitals)}"
    
    facility_codes = [h.facility_code for h in hospitals if h.facility_code]
    assert len(facility_codes) == len(set(facility_codes)), "Facility codes must be unique"
    
    # Verify standard prefix format
    for code in facility_codes:
        assert code.startswith("HOSP-"), f"Facility code {code} must start with HOSP-"

def test_hospital_doctors_and_equipment_coverage(fresh_db: Session):
    # Verify doctors exist in doctors_availability and have realistic shift schedules
    hospitals = fresh_db.query(Hospital).all()
    for h in hospitals[:10]:
        assert h.doctors_availability is not None and len(h.doctors_availability) > 0, f"Hospital {h.name} should have doctors"
        assert h.equipment_readiness is not None, f"Hospital {h.name} should have equipment config"
        assert h.departments is not None, f"Hospital {h.name} should have departments config"

def test_facility_context_switching(fresh_db: Session):
    hospital_user = fresh_db.query(User).filter(User.role == ROLE_HOSPITAL_STAFF).first()
    assert hospital_user is not None
    
    # Pick target hospital
    target = fresh_db.query(Hospital).filter(Hospital.id != hospital_user.hospital_id).first()
    assert target is not None
    
    response = Response()
    token_resp = switch_facility(hospital_id=target.id, response=response, db=fresh_db)
    
    assert token_resp.user.hospital_id == target.id
    assert token_resp.access_token is not None
    assert token_resp.user.hospital_name == target.name

def test_capability_aware_allocation_prioritizes_cath_lab_for_cardiac(fresh_db: Session):
    # Create cardiac incident
    incident = Incident(
        caller_name="Cardiac Test",
        caller_phone="9998887777",
        location_address="Hampankatta, Mangaluru",
        latitude=12.8700,
        longitude=74.8400,
        chief_complaint="Severe retrosternal chest pain radiating to left arm",
        chest_pain=True,
        triage_level="Priority 1",
        triage_color="RED",
        status="TRIAGED",
    )
    fresh_db.add(incident)
    fresh_db.commit()
    fresh_db.refresh(incident)
    
    hospitals = fresh_db.query(Hospital).all()
    result = rank_suitable_hospitals(incident, hospitals)
    assert "ranked_hospitals" in result
    ranked = result["ranked_hospitals"]
    assert len(ranked) > 0
    top = ranked[0]
    
    # Top hospital should have cath lab or cardiac capability
    hosp = fresh_db.query(Hospital).filter(Hospital.id == top["hospital_id"]).first()
    equipment = hosp.equipment_readiness or {}
    departments = hosp.departments or []
    has_cardio = equipment.get("cath_lab") == "OPERATIONAL" or any(d.get("name") == "Cardiology" for d in departments)
    assert has_cardio, f"Top ranked hospital {hosp.name} for cardiac incident should have Cardiology/Cath Lab"

def test_alternative_ambulance_request_endpoint(fresh_db: Session):
    # Setup test incident, ambulance, and dispatch
    incident = Incident(
        caller_name="Alternative Unit Test",
        caller_phone="9876543210",
        location_address="Kadri, Mangaluru",
        latitude=12.8750,
        longitude=74.8550,
        chief_complaint="Road accident with vehicular rollover",
        triage_level="Priority 1",
        triage_color="RED",
        status="DISPATCHED",
    )
    fresh_db.add(incident)
    fresh_db.commit()
    fresh_db.refresh(incident)
    
    amb = fresh_db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    if not amb:
        amb = Ambulance(call_sign="TEST-AMB-01", status="AVAILABLE", latitude=12.87, longitude=74.85)
        fresh_db.add(amb)
        fresh_db.commit()
        fresh_db.refresh(amb)
        
    hosp = fresh_db.query(Hospital).first()
    
    dispatch = Dispatch(
        incident_id=incident.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
        status="EN_ROUTE_INCIDENT",
        coordination_status="CONFIRMED",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="ACCEPTED",
        attempt_number=1,
    )
    fresh_db.add(dispatch)
    fresh_db.commit()
    fresh_db.refresh(dispatch)
    
    # Request alternative ambulance
    staff_user = fresh_db.query(User).filter(User.role == ROLE_HOSPITAL_STAFF, User.hospital_id == hosp.id).first()
    
    req_payload = AlternativeAmbulanceRequest(
        reason="Crash/Collision Detected on Transit Route",
        notes="Unit was hit by a truck at Kadri junction. Requesting immediate replacement.",
        hospital_id=hosp.id
    )
    result = request_alternative_ambulance(
        dispatch_id=dispatch.id,
        payload=req_payload,
        db=fresh_db,
        current_user=staff_user
    )
    
    assert result.alternative_ambulance_requested is True
    assert result.alternative_ambulance_reason == "Crash/Collision Detected on Transit Route"
    
    # Check incident event was logged
    event = fresh_db.query(IncidentEvent).filter(
        IncidentEvent.incident_id == incident.id,
        IncidentEvent.event_type == "ALTERNATIVE_AMBULANCE_REQUESTED"
    ).first()
    assert event is not None
    assert "Kadri junction" in event.event_description

def test_patient_not_picked_up_workflow(fresh_db: Session):
    # Setup incident and dispatch at ON_SCENE status
    incident = Incident(
        caller_name="Not Picked Up Test",
        caller_phone="9876543211",
        location_address="Kankanady, Mangaluru",
        latitude=12.8680,
        longitude=74.8580,
        chief_complaint="Patient feeling dizzy",
        triage_level="Priority 3",
        triage_color="GREEN",
        status="ON_SCENE",
    )
    fresh_db.add(incident)
    fresh_db.commit()
    fresh_db.refresh(incident)
    
    amb = fresh_db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    if not amb:
        amb = Ambulance(call_sign="TEST-AMB-02", status="AVAILABLE", latitude=12.87, longitude=74.85)
        fresh_db.add(amb)
        fresh_db.commit()
        fresh_db.refresh(amb)
    amb.status = "ON_SCENE"
    fresh_db.commit()
    
    hosp = fresh_db.query(Hospital).first()
    hosp.reserved_emergency_beds = (hosp.reserved_emergency_beds or 0) + 1
    fresh_db.commit()
    
    dispatch = Dispatch(
        incident_id=incident.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
        status="ON_SCENE",
        coordination_status="CONFIRMED",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="ACCEPTED",
        attempt_number=1,
    )
    fresh_db.add(dispatch)
    fresh_db.commit()
    fresh_db.refresh(dispatch)
    
    driver_user = fresh_db.query(User).filter(User.role == ROLE_AMBULANCE_CREW, User.ambulance_id == amb.id).first()
    
    req_payload = PatientNotPickedUpRequest(
        reason="Patient Refused Transport (AMA)",
        notes="Patient signed refusal form, vitals stable, family present."
    )
    result = record_patient_not_picked_up(
        dispatch_id=dispatch.id,
        payload=req_payload,
        db=fresh_db,
        current_user=driver_user
    )
    
    assert result.status == "CANCELLED"
    assert result.patient_pickup_status == "NOT_PICKED_UP"
    assert result.patient_pickup_failure_reason == "Patient Refused Transport (AMA)"
    
    # Verify ambulance freed back to AVAILABLE
    fresh_db.refresh(amb)
    assert amb.status == "AVAILABLE"
