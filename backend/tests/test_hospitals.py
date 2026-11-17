import pytest
from backend.app.core.database import SessionLocal, Base, engine
from backend.app.models.entities import Hospital, Incident
from backend.app.services.seed_service import seed_database
from backend.app.services.hospital_engine import rank_suitable_hospitals

@pytest.fixture(scope="module")
def db():
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    seed_database(session, force=True)
    yield session
    session.close()

def test_hospital_ranking_for_cardiac(db):
    incident = db.query(Incident).first()
    incident.chest_pain = True
    hospitals = db.query(Hospital).all()

    result = rank_suitable_hospitals(incident=incident, hospitals=hospitals)
    ranked = result["ranked_hospitals"]

    assert len(ranked) == 5
    top_hospital = ranked[0]
    assert top_hospital["rank"] == 1
    assert "Cardiology" in top_hospital["matched_specialties"]
    assert top_hospital["available_icu_beds"] > 0
    assert "specialty_score" in top_hospital["score_breakdown"]
    assert len(top_hospital["suitability_reasons"]) >= 2

def test_hospital_ranking_burn_care(db):
    burn_incident = Incident(
        caller_name="Test Caller",
        caller_phone="+91 99999 11111",
        location_address="Kuntikan Junction, Mangaluru",
        latitude=12.8990,
        longitude=74.8460,
        chief_complaint="Severe second degree chemical burn in laboratory accident",
        triage_level="Priority 2 (Urgent)",
    )
    hospitals = db.query(Hospital).all()
    result = rank_suitable_hospitals(incident=burn_incident, hospitals=hospitals)

    # AJ Hospital has Burn Care
    aj_rank = next(h for h in result["ranked_hospitals"] if "AJ" in h["name"])
    assert "Burn Care" in aj_rank["matched_specialties"]
    assert aj_rank["score_breakdown"]["specialty_score"] == 100.0
