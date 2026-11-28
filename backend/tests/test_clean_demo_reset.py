import pytest
from sqlalchemy.orm import Session
from backend.app.models.entities import (
    Hospital,
    User,
    Dispatch,
    Incident,
    Ambulance,
    IncidentEvent,
    HandoverPacket,
    CrashAlert,
    PatientVitals,
)
from backend.app.services.clean_reset_service import execute_clean_demo_reset

def test_clean_demo_reset_clears_all_cases_and_preserves_master_records(fresh_db: Session):
    db = fresh_db
    
    # 1. Create a dummy active incident, dispatch, handover, vitals, and event
    hosp = db.query(Hospital).first()
    amb = db.query(Ambulance).first()
    user = db.query(User).first()
    
    inc = Incident(
        caller_name="Reset Test Subject",
        caller_phone="+919876543299",
        location_address="Bunts Hostel, Mangaluru",
        latitude=12.8710,
        longitude=74.8450,
        chief_complaint="Severe test accident",
        triage_level="Priority 1",
        triage_color="RED",
        status="DISPATCHED",
    )
    db.add(inc)
    db.commit()
    db.refresh(inc)
    
    amb.status = "DISPATCHED"
    amb.reservation_dispatch_id = 999
    hosp.reserved_emergency_beds = 2
    db.commit()
    
    disp = Dispatch(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
        status="EN_ROUTE_INCIDENT",
        coordination_status="CONFIRMED",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="ACCEPTED",
        attempt_number=1,
    )
    db.add(disp)
    db.commit()
    db.refresh(disp)
    
    hp = HandoverPacket(
        dispatch_id=disp.id,
        incident_id=inc.id,
        status="SENT",
        chief_complaint="Severe test accident",
        triage_priority="Priority 1",
        incident_latitude=12.8710,
        incident_longitude=74.8450,
        incident_address="Bunts Hostel, Mangaluru",
        ambulance_call_sign=amb.call_sign,
        ambulance_vehicle_type=amb.vehicle_type,
    )
    db.add(hp)
    
    ev = IncidentEvent(
        incident_id=inc.id,
        dispatch_id=disp.id,
        event_type="DISPATCH_CREATED",
        event_title="Unit Dispatched",
        event_description="Test event for clean reset",
    )
    db.add(ev)
    
    vitals = PatientVitals(
        dispatch_id=disp.id,
        incident_id=inc.id,
        heart_rate=80,
        blood_pressure_systolic=120,
        blood_pressure_diastolic=80,
        oxygen_saturation=98,
        respiratory_rate=16,
    )
    db.add(vitals)
    db.commit()
    
    # Verify records exist before reset
    assert db.query(Incident).count() > 0
    assert db.query(Dispatch).count() > 0
    assert db.query(HandoverPacket).count() > 0
    assert db.query(IncidentEvent).count() > 0
    assert db.query(PatientVitals).count() > 0
    
    # 2. Execute clean demo reset
    result = execute_clean_demo_reset(db, broadcast=False)
    assert result["status"] == "success"
    
    # 3. Assert ALL operational emergency records are 0
    assert db.query(Incident).count() == 0, "Incident count must be 0 after reset"
    assert db.query(Dispatch).count() == 0, "Dispatch count must be 0 after reset"
    assert db.query(HandoverPacket).count() == 0, "HandoverPacket count must be 0 after reset"
    assert db.query(IncidentEvent).count() == 0, "IncidentEvent count must be 0 after reset"
    assert db.query(CrashAlert).count() == 0, "CrashAlert count must be 0 after reset"
    assert db.query(PatientVitals).count() == 0, "PatientVitals count must be 0 after reset"
    
    # 4. Assert ALL master data is preserved
    hospitals = db.query(Hospital).all()
    assert len(hospitals) >= 30, f"Expected at least 30 hospitals preserved, found {len(hospitals)}"
    for h in hospitals:
        assert h.reserved_emergency_beds == 0, f"Hospital {h.name} reserved beds must be 0"
        assert h.readiness_status == "READY", f"Hospital {h.name} readiness must be READY"
        
    ambulances = db.query(Ambulance).all()
    assert len(ambulances) >= 5, f"Expected at least 5 ambulances preserved, found {len(ambulances)}"
    for a in ambulances:
        assert a.status == "AVAILABLE", f"Ambulance {a.call_sign} status must be AVAILABLE"
        assert a.reservation_dispatch_id is None, f"Ambulance {a.call_sign} reservation must be None"
        
    users = db.query(User).all()
    assert len(users) >= 36, f"Expected user accounts preserved, found {len(users)}"
    
    # 5. Idempotence: Running reset again must succeed cleanly with 0 errors
    result_repeat = execute_clean_demo_reset(db, broadcast=False)
    assert result_repeat["status"] == "success"
    assert db.query(Incident).count() == 0
    assert db.query(Dispatch).count() == 0
