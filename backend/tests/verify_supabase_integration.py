import sys
import os
import uuid
from sqlalchemy import text, inspect

sys.path.insert(0, os.path.abspath("."))

from backend.app.core.config import settings
from backend.app.core.database import SessionLocal, Base, engine
from backend.app.models.entities import Incident, Ambulance, Hospital, Dispatch
from backend.app.services.seed_service import seed_database

def test_supabase_full_verification():
    print("=" * 60)
    print("RESQFLOW LIVE SUPABASE POSTGRESQL VERIFICATION")
    print("=" * 60)

    # 1. Connectivity & Dialect
    print("1. Checking Database Connectivity & Dialect...")
    with engine.connect() as conn:
        res = conn.execute(text("SELECT 1;"))
        assert res.scalar() == 1
        ver_res = conn.execute(text("SELECT version();"))
        ver = ver_res.fetchone()[0]

    dialect_name = engine.dialect.name
    driver_name = engine.dialect.driver

    print(f"✓ Connection Status: CONNECTED")
    print(f"✓ Detected Database Dialect: {dialect_name}")
    print(f"✓ PostgreSQL Driver: {driver_name}")
    print(f"✓ Server Version: {ver.split('on')[0].strip()}")
    assert dialect_name == "postgresql", f"Expected postgresql, got {dialect_name}"
    assert driver_name == "psycopg2", f"Expected psycopg2, got {driver_name}"

    # 2. Table Creation & Verification
    print("\n2. Verifying and Provisioning Four-Table Schema in Supabase...")
    Base.metadata.create_all(bind=engine)

    inspector = inspect(engine)
    existing_tables = inspector.get_table_names()
    print(f"Tables present in Supabase public schema: {existing_tables}")

    required_tables = ["incidents", "ambulances", "hospitals", "dispatches"]
    for t in required_tables:
        assert t in existing_tables, f"Missing table: {t}"
    print(f"✓ Four-Table Verification: All 4 tables verified in Supabase: {required_tables}")

    # 3. Seed Realistic Mangaluru Dataset if empty
    print("\n3. Seeding / Verifying Operational Fleet Data in Supabase...")
    session = SessionLocal()
    try:
        seed_res = seed_database(session, force=False)
        print(f"✓ Seed Status in Supabase: {seed_res}")

        h_count = session.query(Hospital).count()
        a_count = session.query(Ambulance).count()
        assert h_count >= 5, f"Expected at least 5 hospitals, got {h_count}"
        assert a_count >= 8, f"Expected at least 8 ambulances, got {a_count}"
        print(f"✓ Fleet counts in Supabase: {h_count} hospitals, {a_count} ambulances.")

        # 4. Create Uniquely Identifiable Test Incident
        test_uid = f"SUPABASE-TEST-{uuid.uuid4().hex[:8]}"
        print(f"\n4. Creating uniquely identifiable test incident: {test_uid}...")
        test_inc = Incident(
            caller_name=f"Verification Agent ({test_uid})",
            caller_phone="+91 98450 12345",
            location_address="KMC Hospital Ambedkar Circle, Mangaluru",
            latitude=12.8718,
            longitude=74.8458,
            chief_complaint="Chest pain test record for Supabase PostgreSQL live integration",
            triage_level="Priority 1 (Critical)",
            triage_color="RED",
            triage_score=95,
            required_ambulance_type="ALS",
            status="TRIAGED",
        )
        session.add(test_inc)
        session.commit()
        session.refresh(test_inc)
        test_inc_id = test_inc.id
        print(f"✓ Created test incident in Supabase: ID #{test_inc_id}")

        # 5. Read Test Incident Back from PostgreSQL
        print("\n5. Reading test incident back from Supabase...")
        fetched_inc = session.query(Incident).filter(Incident.id == test_inc_id).first()
        assert fetched_inc is not None
        assert test_uid in fetched_inc.caller_name
        assert fetched_inc.triage_color == "RED"
        assert fetched_inc.required_ambulance_type == "ALS"
        print(f"✓ Verified read-back from PostgreSQL: Incident #{fetched_inc.id} - {fetched_inc.caller_name}")

        # 6. Verify Dispatch Relationship & Foreign Keys in PostgreSQL
        print("\n6. Verifying dispatch foreign key relationships in Supabase...")
        amb = session.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
        hosp = session.query(Hospital).first()
        assert amb is not None and hosp is not None

        test_disp = Dispatch(
            incident_id=test_inc_id,
            ambulance_id=amb.id,
            destination_hospital_id=hosp.id,
            status="ASSIGNED",
            estimated_eta_seconds=240.0,
            route_distance_meters=1850.0,
            allocation_score=92.4,
        )
        session.add(test_disp)
        session.commit()
        session.refresh(test_disp)
        test_disp_id = test_disp.id

        # Verify relationship traversal
        retrieved_disp = session.query(Dispatch).filter(Dispatch.id == test_disp_id).first()
        assert retrieved_disp.incident.id == test_inc_id
        assert retrieved_disp.ambulance.id == amb.id
        assert retrieved_disp.destination_hospital.id == hosp.id
        print(f"✓ Verified dispatch #{test_disp_id} relations:")
        print(f"    - Incident: #{retrieved_disp.incident.id} ({retrieved_disp.incident.caller_name})")
        print(f"    - Ambulance: #{retrieved_disp.ambulance.id} ({retrieved_disp.ambulance.call_sign})")
        print(f"    - Hospital: #{retrieved_disp.destination_hospital.id} ({retrieved_disp.destination_hospital.name})")

        # 7. Safe Cleanup of Test Record
        print("\n7. Safely deleting test record...")
        session.delete(test_disp)
        session.delete(test_inc)
        session.commit()

        # Confirm deleted
        check_deleted = session.query(Incident).filter(Incident.id == test_inc_id).first()
        assert check_deleted is None
        print("✓ Verified test record cleaned up safely without affecting production data.")

    finally:
        session.close()

    # 8. Restart Simulation & Re-Verification
    print("\n8. Simulating Backend Engine Restart & Verifying Reconnection...")
    engine.dispose()
    session_post_restart = SessionLocal()
    try:
        with engine.connect() as post_conn:
            check_res = post_conn.execute(text("SELECT 1;")).scalar()
            assert check_res == 1
        h_post = session_post_restart.query(Hospital).count()
        a_post = session_post_restart.query(Ambulance).count()
        print(f"✓ Engine re-connected successfully after disposal/restart.")
        print(f"✓ Verified data persistence: {h_post} hospitals and {a_post} ambulances remain intact in Supabase.")
    finally:
        session_post_restart.close()

    print("\n" + "=" * 60)
    print("ALL LIVE SUPABASE POSTGRESQL VERIFICATION STEPS PASSED 100%")
    print("=" * 60)

if __name__ == "__main__":
    test_supabase_full_verification()
