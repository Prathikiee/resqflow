import pytest
from backend.app.core.database import SessionLocal, Base, engine
from backend.app.models.entities import Ambulance, Incident
from backend.app.services.seed_service import seed_database
from backend.app.services.allocation_engine import score_and_rank_ambulances
from backend.app.services.triage_engine import assess_incident_severity

@pytest.fixture(scope="module")
def db():
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    seed_database(session, force=True)
    yield session
    session.close()

def test_allocation_excludes_busy_and_maintenance(db):
    incident = db.query(Incident).first()
    ambulances = db.query(Ambulance).all()

    result = score_and_rank_ambulances(incident=incident, ambulances=ambulances)

    excluded = result["excluded_ambulances"]
    excluded_callsigns = [e["call_sign"] for e in excluded]

    # KA-19-ALS-104 is DISPATCHED
    assert "KA-19-ALS-104" in excluded_callsigns
    # KA-19-BLS-204 is MAINTENANCE
    assert "KA-19-BLS-204" in excluded_callsigns

    # Excluded reasons check
    for item in excluded:
        assert len(item["reasons"]) > 0

def test_allocation_scoring_breakdown(db):
    incident = db.query(Incident).first()
    ambulances = db.query(Ambulance).all()

    result = score_and_rank_ambulances(incident=incident, ambulances=ambulances)
    ranked = result["ranked_ambulances"]

    assert len(ranked) > 0
    top_amb = ranked[0]
    assert top_amb["rank"] == 1
    assert "total_score" in top_amb
    assert 0 <= top_amb["total_score"] <= 100

    breakdown = top_amb["score_breakdown"]
    assert "proximity_eta_score" in breakdown
    assert "capability_match_score" in breakdown
    assert "equipment_score" in breakdown
    assert "readiness_score" in breakdown

    assert len(top_amb["match_reasons"]) >= 2
    assert "route_geometry" in top_amb
