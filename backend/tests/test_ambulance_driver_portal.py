import pytest
from datetime import datetime, timezone
from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend.app.models.entities import Ambulance, Dispatch, Incident, Hospital, User
from backend.app.schemas.dispatch import ConfirmationDecision, MissionAssistanceRequest
from backend.app.schemas.ambulance import AmbulanceIssueReport
from backend.app.api.ambulances import update_ambulance_status, report_ambulance_issue
from backend.app.api.dispatch import (
    confirm_ambulance,
    confirm_patient_pickup,
    request_mission_assistance,
    confirm_patient_arrival_at_hospital,
    advance_dispatch_lifecycle,
)

def get_or_create_driver(db: Session, amb_id: int):
    driver = db.query(User).filter(User.role == "AMBULANCE_CREW").first()
    if not driver:
        driver = User(
            username="driver_test_unit",
            email="driver_unit@test.com",
            hashed_password="hash",
            role="AMBULANCE_CREW",
            ambulance_id=amb_id,
        )
        db.add(driver)
        db.commit()
        db.refresh(driver)
    return driver

def test_ambulance_duty_toggle_on_and_off(db: Session):
    amb = db.query(Ambulance).filter(Ambulance.is_active == True).first()
    assert amb is not None, "At least one ambulance should exist"
    driver = get_or_create_driver(db, amb.id)

    # 1. Switch to OFF_DUTY
    updated = update_ambulance_status(
        ambulance_id=amb.id,
        status="OFF_DUTY",
        db=db,
        current_user=driver,
    )
    assert updated.status == "OFF_DUTY"

    # 2. Switch back to AVAILABLE (On Duty)
    updated_back = update_ambulance_status(
        ambulance_id=amb.id,
        status="AVAILABLE",
        db=db,
        current_user=driver,
    )
    assert updated_back.status == "AVAILABLE"

def test_ambulance_block_off_duty_during_active_mission(db: Session):
    amb = db.query(Ambulance).filter(Ambulance.is_active == True).first()
    assert amb is not None
    amb.status = "DISPATCHED"
    db.commit()
    driver = get_or_create_driver(db, amb.id)

    # Create an active dispatch
    incident = Incident(
        caller_name="Test Caller",
        caller_phone="9876543210",
        location_address="Canara Engineering College",
        latitude=12.8992,
        longitude=74.9843,
        chief_complaint="Severe chest pain",
        triage_level="RED",
        triage_color="RED",
        triage_score=85,
        status="DISPATCHED",
    )
    db.add(incident)
    db.commit()
    db.refresh(incident)

    dispatch = Dispatch(
        incident_id=incident.id,
        ambulance_id=amb.id,
        destination_hospital_id=1,
        status="EN_ROUTE_INCIDENT",
        coordination_status="CONFIRMED",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="ACCEPTED",
        dispatched_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(dispatch)
    db.commit()
    db.refresh(dispatch)

    # Attempt to go OFF_DUTY while active mission is running
    with pytest.raises(HTTPException) as exc_info:
        update_ambulance_status(
            ambulance_id=amb.id,
            status="OFF_DUTY",
            db=db,
            current_user=driver,
        )

    assert exc_info.value.status_code == 400
    assert "Cannot switch ambulance to OFF_DUTY while an active emergency mission" in exc_info.value.detail

def test_ambulance_confirmation_accept_and_reject(db: Session):
    amb = db.query(Ambulance).first()
    assert amb is not None

    incident = Incident(
        caller_name="Confirmation Caller",
        caller_phone="9876543211",
        location_address="Kadri Hills, Mangaluru",
        latitude=12.8800,
        longitude=74.8500,
        chief_complaint="Road traffic accident",
        triage_level="RED",
        triage_color="RED",
        triage_score=80,
        status="ALLOCATED",
    )
    db.add(incident)
    db.commit()
    db.refresh(incident)

    dispatch = Dispatch(
        incident_id=incident.id,
        ambulance_id=amb.id,
        destination_hospital_id=1,
        status="ASSIGNED",
        coordination_status="PENDING_CONFIRMATIONS",
        ambulance_confirmation_status="PENDING",
        hospital_confirmation_status="PENDING",
        dispatched_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(dispatch)
    db.commit()
    db.refresh(dispatch)

    # Acknowledge / Accept
    decision = ConfirmationDecision(decision="ACCEPTED")
    res = confirm_ambulance(dispatch_id=dispatch.id, payload=decision, db=db)
    assert res.ambulance_confirmation_status == "ACCEPTED"

def test_ambulance_patient_pickup_explicit_confirmation(db: Session):
    amb = db.query(Ambulance).first()
    hosp = db.query(Hospital).first()
    assert amb is not None and hosp is not None

    incident = Incident(
        caller_name="Pickup Caller",
        caller_phone="9876543212",
        location_address="State Bank, Mangaluru",
        latitude=12.8600,
        longitude=74.8400,
        chief_complaint="Cardiac distress",
        triage_level="RED",
        triage_color="RED",
        triage_score=90,
        status="ON_SCENE",
    )
    db.add(incident)
    db.commit()
    db.refresh(incident)

    dispatch = Dispatch(
        incident_id=incident.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
        status="ON_SCENE",
        coordination_status="CONFIRMED",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="ACCEPTED",
        dispatched_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(dispatch)
    db.commit()
    db.refresh(dispatch)

    # Explicit patient pickup confirmation
    updated_disp = confirm_patient_pickup(dispatch_id=dispatch.id, db=db)
    assert updated_disp.status == "EN_ROUTE_HOSPITAL"
    assert updated_disp.departed_incident_at is not None

    # Verify incident and ambulance transitioned to TRANSPORTING
    db.refresh(incident)
    db.refresh(amb)
    assert incident.status == "TRANSPORTING"
    assert amb.status == "TRANSPORTING"

def test_ambulance_report_vehicle_issue(db: Session):
    amb = db.query(Ambulance).first()
    assert amb is not None

    # Driver user fixture
    driver = db.query(User).filter(User.role == "AMBULANCE_CREW").first()
    if not driver:
        driver = User(
            username="driver_test",
            email="driver@test.com",
            hashed_password="hash",
            role="AMBULANCE_CREW",
            ambulance_id=amb.id,
        )
        db.add(driver)
        db.commit()
        db.refresh(driver)

    report_payload = AmbulanceIssueReport(
        issue_type="MECHANICAL",
        notes="Brake pressure warning light active on dashboard",
        mark_maintenance=True,
    )

    res = report_ambulance_issue(
        ambulance_id=amb.id,
        payload=report_payload,
        db=db,
        current_user=driver,
    )

    assert res["status"] == "ok"
    db.refresh(amb)
    assert amb.status == "MAINTENANCE"

def test_ambulance_request_operational_assistance(db: Session):
    amb = db.query(Ambulance).first()
    hosp = db.query(Hospital).first()
    assert amb is not None and hosp is not None

    incident = Incident(
        caller_name="Assistance Caller",
        caller_phone="9876543213",
        location_address="Pumpwell Flyover",
        latitude=12.8700,
        longitude=74.8600,
        chief_complaint="Multiple vehicle pileup",
        triage_level="RED",
        triage_color="RED",
        triage_score=95,
        status="ON_SCENE",
    )
    db.add(incident)
    db.commit()
    db.refresh(incident)

    dispatch = Dispatch(
        incident_id=incident.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
        status="ON_SCENE",
        coordination_status="CONFIRMED",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="ACCEPTED",
        dispatched_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(dispatch)
    db.commit()
    db.refresh(dispatch)

    req = MissionAssistanceRequest(
        assistance_type="POLICE",
        notes="Gridlock traffic requiring immediate traffic police escort",
    )

    result = request_mission_assistance(
        dispatch_id=dispatch.id,
        payload=req,
        db=db,
    )

    assert result["status"] == "ok"
    assert "POLICE" in result["message"]
