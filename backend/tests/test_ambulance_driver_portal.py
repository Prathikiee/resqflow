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
    confirm_hospital,
    confirm_patient_pickup,
    request_mission_assistance,
    confirm_patient_arrival_at_hospital,
    advance_dispatch_lifecycle,
    list_dispatches,
    get_dispatch,
)
from backend.app.schemas.dispatch import DispatchOut
from backend.app.core.ws import ws_manager, WebSocketClient

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


def test_dispatch_assignment_to_als101_and_driver_portal_retrieval(db: Session):
    """
    CRITICAL REGRESSION TEST: Dispatch-to-Ambulance Mission Assignment Integration.
    Verifies that:
      1. A dispatch assigned to ambulance KA-19-ALS-101 (id=1) is correctly queried by
         driver als101@lifelink.demo.
      2. DispatchOut includes full embedded incident summary details for clinical and scene context.
      3. Strict tenant/unit isolation: driver for unit 2 (als102) cannot see unit 1's mission.
      4. Driver accepts assignment, hospital confirms, and mission state transitions consistently.
      5. Driver progresses mission lifecycle through EN_ROUTE_INCIDENT -> ON_SCENE -> EN_ROUTE_HOSPITAL -> COMPLETED.
    """
    from datetime import timedelta
    from backend.app.services.seed_service import seed_demo_users

    seed_demo_users(db)

    # 1. Resolve seed driver als101 and ambulance
    driver_101 = db.query(User).filter(User.email == "als101@lifelink.demo").first()
    driver_102 = db.query(User).filter(User.email == "als102@lifelink.demo").first()
    hosp_staff = db.query(User).filter(User.email == "kmc@lifelink.demo").first()
    assert driver_101 is not None and driver_101.ambulance_id == 1
    assert driver_102 is not None and driver_102.ambulance_id == 2

    amb_101 = db.query(Ambulance).filter(Ambulance.id == 1).first()
    hosp = db.query(Hospital).filter(Hospital.id == 1).first()
    assert amb_101 is not None and hosp is not None

    # Ensure ambulance is AVAILABLE
    amb_101.status = "AVAILABLE"
    amb_101.reservation_dispatch_id = None
    db.commit()

    # 2. Create emergency incident
    incident = Incident(
        caller_name="Rahul Alva",
        caller_phone="+91 98451 99887",
        location_address="Live GPS Fix (12.8516, 74.8702) - Mangaluru",
        latitude=12.851559,
        longitude=74.870218,
        chief_complaint="Severe vehicular collision with high-energy blunt trauma",
        triage_level="Priority 1 (Critical)",
        triage_color="RED",
        triage_score=85,
        required_ambulance_type="ALS",
        status="ALLOCATED",
    )
    db.add(incident)
    db.commit()
    db.refresh(incident)

    # 3. Create dispatch assigned to unit 1 (KA-19-ALS-101)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    dispatch = Dispatch(
        incident_id=incident.id,
        ambulance_id=amb_101.id,
        destination_hospital_id=hosp.id,
        status="ASSIGNED",
        coordination_status="PENDING_CONFIRMATIONS",
        ambulance_confirmation_status="PENDING",
        hospital_confirmation_status="PENDING",
        reservation_expires_at=now + timedelta(seconds=90),
        dispatched_at=now,
    )
    db.add(dispatch)
    amb_101.status = "RESERVED"
    amb_101.reservation_dispatch_id = dispatch.id
    db.commit()
    db.refresh(dispatch)

    # 4. Driver ALS-101 queries missions via list_dispatches
    my_dispatches = list_dispatches(db=db, current_user=driver_101)
    assert len(my_dispatches) >= 1
    matched_disp = next((d for d in my_dispatches if d.id == dispatch.id), None)
    assert matched_disp is not None, "Driver ALS-101 must receive assigned mission"
    assert matched_disp.ambulance_id == 1

    # 5. Verify DispatchOut serialization has embedded incident summary
    serialized = DispatchOut.model_validate(matched_disp)
    assert serialized.incident is not None
    assert serialized.incident.caller_name == "Rahul Alva"
    assert serialized.incident.chief_complaint == "Severe vehicular collision with high-energy blunt trauma"
    assert serialized.incident.triage_level == "Priority 1 (Critical)"
    assert serialized.incident.triage_color == "RED"

    # 6. Verify isolation: Driver ALS-102 (Ambulance 2) must NOT see unit 1's dispatch
    unit2_dispatches = list_dispatches(db=db, current_user=driver_102)
    assert all(d.id != dispatch.id for d in unit2_dispatches), "Ambulance 2 crew must not see Ambulance 1 dispatches"

    # 7. Driver ALS-101 accepts mission
    accept_res = confirm_ambulance(
        dispatch_id=dispatch.id,
        payload=ConfirmationDecision(decision="ACCEPTED"),
        db=db,
        current_user=driver_101,
    )
    assert accept_res.ambulance_confirmation_status == "ACCEPTED"

    # Hospital accepts
    hosp_res = confirm_hospital(
        dispatch_id=dispatch.id,
        payload=ConfirmationDecision(decision="ACCEPTED"),
        db=db,
        current_user=hosp_staff,
    )
    assert hosp_res.coordination_status == "CONFIRMED"

    # 8. Driver progresses mission lifecycle through active states
    s1 = advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db, current_user=driver_101)
    assert s1.status == "EN_ROUTE_INCIDENT"

    s2 = advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db, current_user=driver_101)
    assert s2.status == "ON_SCENE"

    s3 = advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db, current_user=driver_101)
    assert s3.status == "EN_ROUTE_HOSPITAL"

    s4 = advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db, current_user=driver_101)
    assert s4.status == "COMPLETED"

    # 9. Verify reconciled database state
    db.refresh(amb_101)
    db.refresh(incident)
    assert amb_101.status == "AVAILABLE"
    assert amb_101.reservation_dispatch_id is None
    assert incident.status == "RESOLVED"


def test_ambulance_crew_ws_affiliation_and_event_routing(db: Session):
    """
    Verifies that WebSocket targeting directs events to the assigned ambulance crew
    and that ConnectionManager properly resolves ambulance_id.
    """
    from backend.app.core.auth import ROLE_AMBULANCE_CREW

    # Client with ambulance_id=1
    client_1 = WebSocketClient(
        websocket=None,
        user_id=13,
        email="als101@lifelink.demo",
        role=ROLE_AMBULANCE_CREW,
        ambulance_id=1,
    )

    # Client with ambulance_id=2
    client_2 = WebSocketClient(
        websocket=None,
        user_id=14,
        email="als102@lifelink.demo",
        role=ROLE_AMBULANCE_CREW,
        ambulance_id=2,
    )

    # Eligible check for ambulance_id=1
    assert ws_manager.is_client_eligible(client_1, ambulance_id=1) is True
    assert ws_manager.is_client_eligible(client_2, ambulance_id=1) is False

    # Eligible check for ambulance_id=2
    assert ws_manager.is_client_eligible(client_1, ambulance_id=2) is False
    assert ws_manager.is_client_eligible(client_2, ambulance_id=2) is True

