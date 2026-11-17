import pytest
from backend.app.core.database import SessionLocal, Base, engine
from backend.app.models.entities import Ambulance, Hospital, Incident, Dispatch
from backend.app.services.seed_service import seed_database

@pytest.fixture(scope="module")
def db():
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()

def test_seed_database(db):
    results = seed_database(db, force=True)
    assert results["hospitals"] == 5
    assert results["ambulances"] == 8
    assert results["incidents"] == 1

    # Check hospital coordinates & specialties
    hospitals = db.query(Hospital).all()
    assert len(hospitals) == 5
    for h in hospitals:
        assert 12.80 <= h.latitude <= 13.00
        assert 74.70 <= h.longitude <= 74.90
        assert len(h.specialties) > 0
        assert h.available_emergency_beds > 0

    # Verify KMC hospital exists
    kmc = db.query(Hospital).filter(Hospital.name.like("%KMC%")).first()
    assert kmc is not None
    assert "Trauma Level 1" in kmc.specialties

    # Check ambulances
    ambulances = db.query(Ambulance).all()
    assert len(ambulances) == 8
    available_als = [a for a in ambulances if a.vehicle_type == "ALS" and a.status == "AVAILABLE"]
    assert len(available_als) >= 3

    # Check that busy and maintenance ambulances exist for filter demonstration
    busy_amb = db.query(Ambulance).filter(Ambulance.status == "DISPATCHED").first()
    assert busy_amb is not None
    maint_amb = db.query(Ambulance).filter(Ambulance.status == "MAINTENANCE").first()
    assert maint_amb is not None

    # Check demonstration incident
    incident = db.query(Incident).first()
    assert incident is not None
    assert incident.caller_name == "Ramesh Bhat"
    assert incident.triage_color in ["RED", "YELLOW"]
    assert len(incident.triage_justifications) > 0
