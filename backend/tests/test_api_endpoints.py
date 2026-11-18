import pytest
from backend.app.main import app
from backend.app.api.incidents import create_incident, list_incidents, update_incident_status, preview_triage
from backend.app.api.ambulances import list_ambulances, get_ambulance
from backend.app.api.hospitals import list_hospitals
from backend.app.schemas.incident import IncidentCreate, TriagePreviewRequest
from backend.app.schemas.dispatch import IncidentStatusUpdate

def test_triage_preview_endpoint():
    req = TriagePreviewRequest(
        chief_complaint="Severe crushing chest pain",
        consciousness_level="Alert",
        breathing_status="Difficult",
        chest_pain=True,
        patient_age=60,
    )
    res = preview_triage(req)
    assert res["triage_color"] == "RED"
    assert "Priority 1" in res["triage_level"]
    assert res["required_ambulance_type"] == "ALS"
    assert len(res["justifications"]) >= 2

def test_create_and_list_incident_endpoints(db):
    new_inc = IncidentCreate(
        caller_name="Pooja Rao",
        caller_phone="+91 99001 55667",
        location_address="Bunder Port Area, Mangaluru",
        latitude=12.8590,
        longitude=74.8380,
        chief_complaint="Deep leg laceration with heavy bleeding following machinery slip",
        severe_bleeding=True,
        patient_age=34,
        patient_gender="Female",
    )
    created = create_incident(payload=new_inc, db=db)
    assert created.id is not None
    assert created.triage_color == "RED"
    assert "Trauma Level 1" in created.triage_justifications[0] or any("Hemorrhage" in j for j in created.triage_justifications)
    assert created.status == "TRIAGED"

    # List
    all_incidents = list_incidents(db=db)
    assert len(all_incidents) >= 2
    # Verify sorted by triage_score descending
    assert all_incidents[0].triage_score >= all_incidents[-1].triage_score

    # Status update
    updated = update_incident_status(
        incident_id=created.id,
        payload=IncidentStatusUpdate(status="ALLOCATED"),
        db=db
    )
    assert updated.status == "ALLOCATED"

def test_ambulances_endpoint(db):
    ambs = list_ambulances(db=db)
    assert len(ambs) >= 4
    available = list_ambulances(status="AVAILABLE", db=db)
    assert len(available) >= 3

def test_hospitals_endpoint(db):
    hosp = list_hospitals(db=db)
    assert len(hosp) == 5
    accepting = list_hospitals(accepting_only=True, db=db)
    assert len(accepting) == 5
