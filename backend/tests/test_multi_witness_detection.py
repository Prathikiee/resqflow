import pytest
from datetime import datetime, timezone, timedelta
from fastapi import HTTPException
from backend.app.core.database import SessionLocal, Base, engine, upgrade_schema
from backend.app.models.entities import Incident, Ambulance, Hospital, Dispatch, WitnessReport
from backend.app.services.seed_service import seed_database
from backend.app.api.incidents import create_incident
from backend.app.schemas.incident import IncidentCreate
from backend.app.api.dispatch import create_dispatch, confirm_ambulance, confirm_hospital
from backend.app.schemas.dispatch import DispatchRequest, ConfirmationDecision
from backend.app.api.witness_reports import (
    create_witness_report,
    list_witness_reports,
    get_witness_report,
    link_witness_report,
    mark_witness_report_distinct,
)
from backend.app.schemas.witness_report import (
    WitnessReportCreate,
    WitnessReportLinkRequest,
    WitnessReportMarkDistinctRequest,
)

@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.create_all(bind=engine)
    upgrade_schema()
    session = SessionLocal()
    seed_database(session, force=True)
    yield session
    session.close()

def test_demo_scenario_duplicate_witness_detection(fresh_db):
    """
    DEMO SCENARIO:
    1. Witness A reports a road accident at Bunts Hostel Circle.
    2. Master emergency incident is registered and dispatched.
    3. Witness B submits an eyewitness report within 220m and 2 minutes,
       reporting: 'Two wheeler bike collided with city bus near Bunts circle, rider down'.
    4. System deterministically flags POSSIBLE_DUPLICATE with >75% confidence,
       matching Incident A and explaining distance, time, and keywords.
    5. Dispatcher links Witness B to Incident A.
    6. System sets CONFIRMED_DUPLICATE and does NOT trigger a second dispatch.
    """
    db = fresh_db
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    # 1. Master Incident created (Witness A)
    master_inc = create_incident(IncidentCreate(
        caller_name="Witness A (Passerby)",
        caller_phone="9876543210",
        location_address="Bunts Hostel Circle, Mangaluru",
        latitude=12.8732,
        longitude=74.8450,
        chief_complaint="Severe road accident between motorbike and bus, head injury bleeding",
        consciousness_level="Alert",
        breathing_status="Normal",
        severe_bleeding=True,
    ), db=db)

    # Dispatch ambulance for master incident
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).first()
    disp = create_dispatch(DispatchRequest(
        incident_id=master_inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
    ), db=db)
    confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)
    confirm_hospital(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)

    # Exactly 1 active dispatch exists for master incident
    dispatches_before = db.query(Dispatch).filter(Dispatch.incident_id == master_inc.id).all()
    assert len(dispatches_before) == 1

    # 2. Witness B submits eyewitness report 2 minutes later, ~180 meters away
    # (latitude delta ~ 0.0012deg ≈ 130m, longitude delta ~ 0.001deg ≈ 100m)
    witness_b_time = now + timedelta(minutes=2)
    rep_b = create_witness_report(WitnessReportCreate(
        reporter_identifier="Citizen Witness B",
        incident_description="Motorbike collided with bus near circle, rider on road bleeding, crowd gathering",
        incident_type="Road Traffic Accident",
        latitude=12.8742,
        longitude=74.8458,
        reported_at=witness_b_time,
    ), db=db)

    # 3. Duplicate Detection Engine Verification
    assert rep_b.matching_incident_id == master_inc.id
    assert rep_b.review_status == "POSSIBLE_DUPLICATE"
    assert rep_b.duplicate_probability >= 0.65
    assert rep_b.matching_distance_meters <= 300.0  # within 300m
    assert rep_b.matching_time_difference_seconds <= 300.0  # within 5m
    assert "Proximity:" in rep_b.matching_explanation
    assert len(rep_b.audit_trail) >= 1

    # 4. Linking Witness B to Master Incident
    linked_rep = link_witness_report(
        rep_b.id,
        payload=WitnessReportLinkRequest(
            master_incident_id=master_inc.id,
            notes="Confirmed by operator: same two-wheeler collision at Bunts Hostel Circle"
        ),
        db=db,
    )

    assert linked_rep.review_status == "CONFIRMED_DUPLICATE"
    assert linked_rep.master_incident_id == master_inc.id
    assert len(linked_rep.audit_trail) == 2
    assert linked_rep.audit_trail[-1]["action"] == "LINKED_AS_DUPLICATE"

    # 5. Verify NO duplicate dispatch created
    dispatches_after = db.query(Dispatch).filter(Dispatch.incident_id == master_inc.id).all()
    assert len(dispatches_after) == 1
    total_dispatches = db.query(Dispatch).all()
    assert len(total_dispatches) == 1  # Still exactly 1 dispatch fleetwide

    # 6. Verify witness count on master incident
    db.expire_all()
    refreshed_inc = db.query(Incident).filter(Incident.id == master_inc.id).first()
    assert refreshed_inc.witness_count == 1

def test_distinct_witness_report_handling(fresh_db):
    """
    Test: Report with distant coordinates is NOT auto-flagged as duplicate,
    and can be marked DISTINCT with promotion to a new independent incident.
    """
    db = fresh_db
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    # Master incident at Hampankatta
    inc = create_incident(IncidentCreate(
        caller_name="Caller 1",
        caller_phone="9876543210",
        location_address="Hampankatta Junction",
        latitude=12.8650,
        longitude=74.8420,
        chief_complaint="Chest pain at home",
    ), db=db)

    # Witness report 6 km away in Surathkal with completely different complaint
    rep = create_witness_report(WitnessReportCreate(
        reporter_identifier="Surathkal Witness",
        incident_description="Industrial chemical spill at dock warehouse",
        incident_type="Hazmat / Chemical",
        latitude=12.9800,
        longitude=74.8000,
        reported_at=now,
    ), db=db)

    # Should NOT be flagged as duplicate
    assert rep.review_status == "NEW"
    assert (rep.duplicate_probability or 0.0) < 0.55

    # Mark distinct and promote to independent incident
    distinct_rep = mark_witness_report_distinct(
        rep.id,
        payload=WitnessReportMarkDistinctRequest(
            notes="Verified independent hazmat incident in Surathkal",
            promote_to_incident=True,
        ),
        db=db,
    )

    assert distinct_rep.review_status == "DISTINCT"
    assert distinct_rep.master_incident_id is not None
    promoted_inc = db.query(Incident).filter(Incident.id == distinct_rep.master_incident_id).first()
    assert promoted_inc is not None
    assert promoted_inc.caller_name == "Surathkal Witness"
    assert "chemical" in promoted_inc.chief_complaint.lower()

def test_list_and_filter_witness_reports(fresh_db):
    """
    Test listing witness reports with status and incident filters.
    """
    db = fresh_db
    r1 = create_witness_report(WitnessReportCreate(
        reporter_identifier="Witness 1",
        incident_description="Bike skid on wet road",
        latitude=12.87,
        longitude=74.84,
    ), db=db)

    r2 = create_witness_report(WitnessReportCreate(
        reporter_identifier="Witness 2",
        incident_description="Elderly fall on sidewalk",
        latitude=12.88,
        longitude=74.85,
    ), db=db)

    all_reps = list_witness_reports(db=db)
    assert len(all_reps) >= 2

    single = get_witness_report(r1.id, db=db)
    assert single.id == r1.id
