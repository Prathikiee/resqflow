import pytest
from backend.app.core.database import SessionLocal, Base, engine
from backend.app.models.entities import Incident, Ambulance, Hospital, Dispatch
from backend.app.services.seed_service import seed_database
from backend.app.api.incidents import create_incident
from backend.app.schemas.incident import IncidentCreate
from backend.app.api.dispatch import (
    get_dispatch_recommendation,
    create_dispatch,
    advance_dispatch_lifecycle,
    list_dispatches,
    confirm_ambulance,
    confirm_hospital,
)
from backend.app.schemas.dispatch import DispatchRequest, ConfirmationDecision

@pytest.fixture(scope="module")
def db():
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    seed_database(session, force=True)
    yield session
    session.close()

def test_full_emergency_response_lifecycle(db):
    # 1. Emergency Registration & Transparent Triage
    new_inc = IncidentCreate(
        caller_name="Anand Shetty",
        caller_phone="+91 98440 12345",
        location_address="Kadri Temple Road, Mangaluru",
        latitude=12.8790,
        longitude=74.8620,
        chief_complaint="Severe chest pain and shortness of breath while ascending steps",
        chest_pain=True,
        breathing_status="Difficult",
        consciousness_level="Alert",
        patient_age=62,
        patient_gender="Male",
    )
    incident = create_incident(payload=new_inc, db=db)
    assert incident.id is not None
    assert incident.triage_color == "RED"
    assert incident.required_ambulance_type == "ALS"
    assert incident.status == "TRIAGED"

    # 2. Multi-factor Ambulance Allocation & Hospital Suitability Recommendation
    recs = get_dispatch_recommendation(incident_id=incident.id, db=db)
    assert recs["incident_id"] == incident.id
    assert len(recs["ambulance_allocation"]["ranked_ambulances"]) > 0
    assert len(recs["hospital_ranking"]["ranked_hospitals"]) > 0

    top_ambulance = recs["ambulance_allocation"]["recommended_ambulance"]
    top_hospital = recs["hospital_ranking"]["recommended_hospital"]

    assert top_ambulance is not None
    assert top_hospital is not None

    # 3. Create Dispatch
    dispatch_req = DispatchRequest(
        incident_id=incident.id,
        ambulance_id=top_ambulance["ambulance_id"],
        destination_hospital_id=top_hospital["hospital_id"],
    )
    dispatch = create_dispatch(payload=dispatch_req, db=db)
    assert dispatch.id is not None
    assert dispatch.status == "ASSIGNED"
    assert dispatch.estimated_eta_seconds is not None
    assert len(dispatch.route_geometry) > 0

    # Verify provisional reservation state (Feature 1: Dual Confirmation & Smart Reservation)
    db.refresh(incident)
    assigned_amb = db.query(Ambulance).filter(Ambulance.id == top_ambulance["ambulance_id"]).first()
    assert dispatch.coordination_status == "PENDING_CONFIRMATIONS"
    assert incident.status == "ALLOCATED"
    assert assigned_amb.status == "RESERVED"

    # Verify lifecycle cannot advance before dual confirmation
    with pytest.raises(Exception):
        advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db)

    # Perform dual confirmations
    confirm_ambulance(dispatch_id=dispatch.id, payload=ConfirmationDecision(decision="ACCEPTED"), db=db)
    confirm_hospital(dispatch_id=dispatch.id, payload=ConfirmationDecision(decision="ACCEPTED"), db=db)

    # Verify confirmed state
    db.refresh(dispatch)
    db.refresh(incident)
    db.refresh(assigned_amb)
    assert dispatch.coordination_status == "CONFIRMED"
    assert incident.status == "DISPATCHED"
    assert assigned_amb.status == "DISPATCHED"

    # 4. Step Lifecycle: ASSIGNED -> EN_ROUTE_INCIDENT
    step1 = advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db)
    assert step1.status == "EN_ROUTE_INCIDENT"
    db.refresh(incident)
    db.refresh(assigned_amb)
    assert incident.status == "EN_ROUTE"
    assert assigned_amb.status == "EN_ROUTE"

    # 5. Step Lifecycle: EN_ROUTE_INCIDENT -> ON_SCENE
    step2 = advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db)
    assert step2.status == "ON_SCENE"
    assert step2.arrived_incident_at is not None
    assert step2.actual_response_seconds is not None
    db.refresh(incident)
    db.refresh(assigned_amb)
    assert incident.status == "ON_SCENE"
    assert assigned_amb.status == "ON_SCENE"
    # Ambulance location should match incident
    assert assigned_amb.current_latitude == incident.latitude
    assert assigned_amb.current_longitude == incident.longitude

    # 6. Step Lifecycle: ON_SCENE -> EN_ROUTE_HOSPITAL
    step3 = advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db)
    assert step3.status == "EN_ROUTE_HOSPITAL"
    assert step3.departed_incident_at is not None
    db.refresh(incident)
    db.refresh(assigned_amb)
    assert incident.status == "TRANSPORTING"
    assert assigned_amb.status == "TRANSPORTING"

    # 7. Step Lifecycle: EN_ROUTE_HOSPITAL -> COMPLETED
    step4 = advance_dispatch_lifecycle(dispatch_id=dispatch.id, db=db)
    assert step4.status == "COMPLETED"
    assert step4.completed_at is not None
    db.refresh(incident)
    db.refresh(assigned_amb)
    assert incident.status == "RESOLVED"
    assert assigned_amb.status == "AVAILABLE"
    # Ambulance position is now at the hospital
    hospital_rec = db.query(Hospital).filter(Hospital.id == top_hospital["hospital_id"]).first()
    assert assigned_amb.current_latitude == hospital_rec.latitude
    assert assigned_amb.current_longitude == hospital_rec.longitude
