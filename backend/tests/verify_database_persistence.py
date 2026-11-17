import sys
import os
sys.path.insert(0, os.path.abspath("."))
import uuid
from backend.app.core.database import SessionLocal, Base, engine
from backend.app.models.entities import Incident, Ambulance, Hospital, Dispatch
from backend.app.services.seed_service import seed_database

def verify_db_persistence():
    print("=== DATABASE PERSISTENCE & FOREIGN KEY VERIFICATION ===")

    # Setup tables & seed if empty
    Base.metadata.create_all(bind=engine)
    session1 = SessionLocal()
    seed_database(session1, force=False)

    amb = session1.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = session1.query(Hospital).first()
    assert amb is not None, "No available ambulance found"
    assert hosp is not None, "No hospital found"

    unique_marker = f"TestCaller-{uuid.uuid4().hex[:8]}"
    print(f"Creating emergency incident with caller: {unique_marker}")

    inc = Incident(
        caller_name=unique_marker,
        caller_phone="+91 99887 66554",
        location_address="Kadri Park, Mangaluru",
        latitude=12.8770,
        longitude=74.8580,
        chief_complaint="Severe breathing difficulty",
        triage_level="Priority 1 (Critical)",
        triage_color="RED",
        triage_score=95,
        required_ambulance_type="ALS",
        status="TRIAGED",
    )
    session1.add(inc)
    session1.commit()
    session1.refresh(inc)
    inc_id = inc.id
    amb_id = amb.id
    hosp_id = hosp.id

    # Create dispatch with foreign keys
    disp = Dispatch(
        incident_id=inc_id,
        ambulance_id=amb_id,
        destination_hospital_id=hosp_id,
        status="ASSIGNED",
        estimated_eta_seconds=360.0,
        route_distance_meters=2400.0,
        allocation_score=88.5,
    )
    session1.add(disp)
    session1.commit()
    disp_id = disp.id
    print(f"Created dispatch #{disp_id} linking Incident #{inc_id}, Ambulance #{amb_id}, Hospital #{hosp_id}")

    # SIMULATE COMPLETE PROCESS / BACKEND RESTART
    session1.close()
    engine.dispose()
    print("Disposed database connection and closed session. Simulating backend restart...")

    # RECONNECT IN NEW SESSION
    session2 = SessionLocal()
    try:
        retrieved_inc = session2.query(Incident).filter(Incident.id == inc_id).first()
        assert retrieved_inc is not None, f"Incident {inc_id} not found after restart!"
        assert retrieved_inc.caller_name == unique_marker
        print("✓ Incident persistence verified after simulated restart.")

        retrieved_disp = session2.query(Dispatch).filter(Dispatch.id == disp_id).first()
        assert retrieved_disp is not None, f"Dispatch {disp_id} not found after restart!"
        assert retrieved_disp.incident_id == inc_id
        assert retrieved_disp.ambulance_id == amb_id
        assert retrieved_disp.destination_hospital_id == hosp_id

        # Verify ORM relationships
        assert retrieved_disp.incident.caller_name == unique_marker
        assert retrieved_disp.ambulance.id == amb_id
        assert retrieved_disp.destination_hospital.id == hosp_id
        print("✓ Foreign key relationships and cascade navigation verified.")

        # Cleanup test record
        session2.delete(retrieved_disp)
        session2.delete(retrieved_inc)
        session2.commit()
        print("✓ Cleaned up test records.")
        print("DATABASE VERIFICATION SUCCESSFUL.")
    finally:
        session2.close()

if __name__ == "__main__":
    verify_db_persistence()
