import pytest
from sqlalchemy.orm import Session
from backend.app.models.entities import User, Incident, Dispatch
from backend.app.schemas.incident import IncidentCreate
from backend.app.api.incidents import create_incident, list_incidents, get_incident, cancel_incident, get_my_active_incident
from backend.app.schemas.dispatch import IncidentCancelRequest
from backend.app.services.seed_service import seed_demo_users
from fastapi import HTTPException

def test_citizen_incident_creation_all_categories(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    citizen = db.query(User).filter(User.email == "citizen@lifelink.demo").first()
    assert citizen is not None

    categories = [
        ("Road Accident", "Road collision between car and motorcycle near Hampankatta", False, True, "ALS"),
        ("Cardiac", "Severe substernal chest pain radiating to left arm", True, False, "ALS"),
        ("Medical", "High fever, dizziness and dehydration", False, False, "BLS"),
        ("Fire", "Fire in 2nd floor apartment, smoke inhalation", False, False, "BLS"),
        ("Injury / Fall", "Fall from height with suspected limb fracture", False, True, "ALS"),
        ("Other", "General distress, needs medical evaluation", False, False, "BLS"),
    ]

    for cat_name, desc, chest_pain, trauma, expected_ambulance in categories:
        payload = IncidentCreate(
            caller_name=citizen.full_name,
            caller_phone=citizen.phone_number or "+91 98450 11200",
            location_address="Hampankatta, Central Mangaluru",
            latitude=12.8700,
            longitude=74.8420,
            chief_complaint=f"{cat_name} - {desc}",
            chest_pain=chest_pain,
            severe_trauma=trauma,
            breathing_status="Normal",
        )
        inc = create_incident(payload, db=db, current_user=citizen)
        assert inc.id is not None
        assert inc.status == "TRIAGED"
        assert inc.required_ambulance_type == expected_ambulance
        assert inc.location_address == "Hampankatta, Central Mangaluru"
        assert inc.latitude == 12.8700
        assert inc.longitude == 74.8420

def test_citizen_incident_creation_with_other_custom_type(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    citizen = db.query(User).filter(User.email == "citizen@lifelink.demo").first()
    assert citizen is not None

    custom_type = "Chemical Vapor Exposure"
    custom_description = "Worker inhaled unknown pungent chemical vapor in workshop."

    payload = IncidentCreate(
        caller_name=citizen.full_name,
        caller_phone=citizen.phone_number or "+91 98450 11200",
        location_address="Baikampady Industrial Area, Mangaluru",
        latitude=12.9460,
        longitude=74.8150,
        chief_complaint=f"Other ({custom_type}) - {custom_description}",
        chest_pain=False,
        severe_trauma=False,
        breathing_status="Difficult",
    )
    inc = create_incident(payload, db=db, current_user=citizen)
    assert inc.id is not None
    assert inc.status == "TRIAGED"
    assert "Other (Chemical Vapor Exposure)" in inc.chief_complaint
    assert inc.location_address == "Baikampady Industrial Area, Mangaluru"

def test_citizen_incident_cancellation(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    citizen = db.query(User).filter(User.email == "citizen@lifelink.demo").first()
    payload = IncidentCreate(
        caller_name=citizen.full_name,
        caller_phone=citizen.phone_number or "+91 98450 11200",
        location_address="Kadri Park Road, Mangaluru",
        latitude=12.8760,
        longitude=74.8560,
        chief_complaint="Medical Emergency - Mild breathlessness",
    )
    inc = create_incident(payload, db=db, current_user=citizen)
    assert inc.id is not None

    # Cancel incident
    cancel_req = IncidentCancelRequest(reason="Situation resolved on site")
    cancelled_inc = cancel_incident(inc.id, cancel_req, db=db, current_user=citizen)
    assert cancelled_inc.status == "CANCELLED"

def test_get_my_active_incident_scoping(fresh_db: Session):
    db = fresh_db
    seed_demo_users(db)

    citizen = db.query(User).filter(User.email == "citizen@lifelink.demo").first()
    assert citizen is not None

    # Initially, no active incident
    active = get_my_active_incident(db=db, current_user=citizen)
    assert active is None

    # Create active incident for citizen
    payload = IncidentCreate(
        caller_name=citizen.full_name,
        caller_phone=citizen.phone_number or "+91 98450 11200",
        location_address="Kankanady, Mangaluru",
        latitude=12.8640,
        longitude=74.8570,
        chief_complaint="Road Accident - Minor collision",
    )
    inc = create_incident(payload, db=db, current_user=citizen)
    assert inc.id is not None

    # Now get_my_active_incident should return this incident
    active = get_my_active_incident(db=db, current_user=citizen)
    assert active is not None
    assert active.id == inc.id
    assert active.status == "TRIAGED"

    # Another citizen should NOT see this incident
    other_user = db.query(User).filter(User.email == "other_citizen@lifelink.demo").first()
    if not other_user:
        other_user = User(
            email="other_citizen@lifelink.demo",
            password_hash="test_hash",
            full_name="Second Citizen",
            role="CITIZEN",
            is_active=True,
        )
        db.add(other_user)
        db.commit()
        db.refresh(other_user)

    active_other = get_my_active_incident(db=db, current_user=other_user)
    assert active_other is None

    # If incident is resolved, get_my_active_incident returns None
    inc.status = "RESOLVED"
    db.commit()

    active_after_resolve = get_my_active_incident(db=db, current_user=citizen)
    assert active_after_resolve is None

    # Unauthenticated raises 401
    with pytest.raises(HTTPException) as excinfo:
        get_my_active_incident(db=db, current_user=None)
    assert excinfo.value.status_code == 401

