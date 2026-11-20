import logging
from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker, Session
from backend.app.core.config import settings

logger = logging.getLogger(__name__)

db_url = settings.effective_database_url

if settings.is_postgres_configured:
    # Attempt real PostgreSQL connection; do not silently swallow errors or fallback
    logger.info("Connecting to remote PostgreSQL database...")
    try:
        engine = create_engine(
            db_url,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=10,
        )
    except Exception as e:
        logger.error(f"PostgreSQL connection initialization failed: {type(e).__name__}: {e}")
        raise
else:
    # Local SQLite fallback only when no PostgreSQL URL is configured
    logger.info("No PostgreSQL URL configured. Utilizing local SQLite database.")
    engine = create_engine(
        db_url,
        connect_args={"check_same_thread": False, "timeout": 30.0},
        pool_pre_ping=True,
    )

    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def upgrade_schema(target_engine=None):
    """
    Safely adds new columns to existing tables if missing (SQLite & PostgreSQL compatible).
    """
    from sqlalchemy import inspect, text
    eng = target_engine or engine
    try:
        inspector = inspect(eng)
        table_names = inspector.get_table_names()
        with eng.connect() as conn:
            if "incidents" in table_names:
                inc_cols = [c["name"] for c in inspector.get_columns("incidents")]
                if "reporter_user_id" not in inc_cols:
                    conn.execute(text("ALTER TABLE incidents ADD COLUMN reporter_user_id INTEGER"))
                    conn.commit()

            if "ambulances" in table_names:
                amb_cols = [c["name"] for c in inspector.get_columns("ambulances")]
                if "reservation_dispatch_id" not in amb_cols:
                    conn.execute(text("ALTER TABLE ambulances ADD COLUMN reservation_dispatch_id INTEGER"))
                    conn.commit()

            if "hospitals" in table_names:
                hosp_cols = [c["name"] for c in inspector.get_columns("hospitals")]
                if "reserved_emergency_beds" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN reserved_emergency_beds INTEGER DEFAULT 0"))
                if "facility_code" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN facility_code VARCHAR(50)"))
                if "readiness_status" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN readiness_status VARCHAR(30) DEFAULT 'READY'"))
                if "total_ward_beds" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN total_ward_beds INTEGER DEFAULT 50"))
                if "available_ward_beds" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN available_ward_beds INTEGER DEFAULT 20"))
                if "doctors_availability_json" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN doctors_availability_json TEXT DEFAULT '[]'"))
                if "last_updated_by" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN last_updated_by VARCHAR(120) DEFAULT 'System Seed'"))
                if "emergency_contact_person" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN emergency_contact_person VARCHAR(120)"))
                if "oxygen_status" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN oxygen_status VARCHAR(50) DEFAULT 'NORMAL'"))
                if "ventilators_total" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN ventilators_total INTEGER DEFAULT 10"))
                if "ventilators_available" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN ventilators_available INTEGER DEFAULT 6"))
                if "pediatric_beds_total" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN pediatric_beds_total INTEGER DEFAULT 10"))
                if "pediatric_beds_available" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN pediatric_beds_available INTEGER DEFAULT 5"))
                if "equipment_readiness_json" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN equipment_readiness_json TEXT DEFAULT '{}'"))
                if "blood_bank_status_json" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN blood_bank_status_json TEXT DEFAULT '{}'"))
                if "departments_json" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN departments_json TEXT DEFAULT '[]'"))
                if "capabilities_json" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN capabilities_json TEXT DEFAULT '{}'"))
                if "bed_capacity_breakdown_json" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN bed_capacity_breakdown_json TEXT DEFAULT '{}'"))
                if "facility_type" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN facility_type VARCHAR(100) DEFAULT 'Tertiary Emergency & Trauma Centre'"))
                if "emergency_department_hours" not in hosp_cols:
                    conn.execute(text("ALTER TABLE hospitals ADD COLUMN emergency_department_hours VARCHAR(60) DEFAULT '24/7 Rapid Response'"))
                conn.commit()

            if "dispatches" in table_names:
                disp_cols = [c["name"] for c in inspector.get_columns("dispatches")]
                if "hospital_preparation_status" not in disp_cols:
                    conn.execute(text("ALTER TABLE dispatches ADD COLUMN hospital_preparation_status VARCHAR(40) DEFAULT 'NOT_STARTED'"))
                if "hospital_preparation_notes" not in disp_cols:
                    conn.execute(text("ALTER TABLE dispatches ADD COLUMN hospital_preparation_notes TEXT"))
                if "hospital_acknowledged_at" not in disp_cols:
                    conn.execute(text("ALTER TABLE dispatches ADD COLUMN hospital_acknowledged_at DATETIME"))
                if "patient_arrived_hospital_confirmed_at" not in disp_cols:
                    conn.execute(text("ALTER TABLE dispatches ADD COLUMN patient_arrived_hospital_confirmed_at DATETIME"))
                if "coordination_status" not in disp_cols:
                    conn.execute(text("ALTER TABLE dispatches ADD COLUMN coordination_status VARCHAR(40) DEFAULT 'PENDING_CONFIRMATIONS'"))
                if "ambulance_confirmation_status" not in disp_cols:
                    conn.execute(text("ALTER TABLE dispatches ADD COLUMN ambulance_confirmation_status VARCHAR(20) DEFAULT 'PENDING'"))
                if "hospital_confirmation_status" not in disp_cols:
                    conn.execute(text("ALTER TABLE dispatches ADD COLUMN hospital_confirmation_status VARCHAR(20) DEFAULT 'PENDING'"))
                if "reservation_expires_at" not in disp_cols:
                    conn.execute(text("ALTER TABLE dispatches ADD COLUMN reservation_expires_at DATETIME"))
                if "ambulance_confirmed_at" not in disp_cols:
                    conn.execute(text("ALTER TABLE dispatches ADD COLUMN ambulance_confirmed_at DATETIME"))
                if "hospital_confirmed_at" not in disp_cols:
                    conn.execute(text("ALTER TABLE dispatches ADD COLUMN hospital_confirmed_at DATETIME"))
                if "confirmed_at" not in disp_cols:
                    conn.execute(text("ALTER TABLE dispatches ADD COLUMN confirmed_at DATETIME"))
                if "rejection_source" not in disp_cols:
                    conn.execute(text("ALTER TABLE dispatches ADD COLUMN rejection_source VARCHAR(30)"))
                if "rejection_reason" not in disp_cols:
                    conn.execute(text("ALTER TABLE dispatches ADD COLUMN rejection_reason TEXT"))
                if "attempt_number" not in disp_cols:
                    conn.execute(text("ALTER TABLE dispatches ADD COLUMN attempt_number INTEGER DEFAULT 1"))
                if "escalation_history_json" not in disp_cols:
                    conn.execute(text("ALTER TABLE dispatches ADD COLUMN escalation_history_json TEXT DEFAULT '[]'"))
                conn.commit()

            if "handover_packets" not in table_names:
                from backend.app.models.entities import HandoverPacket
                HandoverPacket.__table__.create(bind=conn, checkfirst=True)
                conn.commit()
            else:
                hp_cols = [c["name"] for c in inspector.get_columns("handover_packets")]
                if "receiving_notes" not in hp_cols:
                    conn.execute(text("ALTER TABLE handover_packets ADD COLUMN receiving_notes TEXT"))
                if "receiving_clinician" not in hp_cols:
                    conn.execute(text("ALTER TABLE handover_packets ADD COLUMN receiving_clinician VARCHAR(120)"))
                if "reviewed_at" not in hp_cols:
                    conn.execute(text("ALTER TABLE handover_packets ADD COLUMN reviewed_at DATETIME"))
                if "completed_at" not in hp_cols:
                    conn.execute(text("ALTER TABLE handover_packets ADD COLUMN completed_at DATETIME"))
                conn.commit()

            if "witness_reports" not in table_names:
                from backend.app.models.entities import WitnessReport
                WitnessReport.__table__.create(bind=conn, checkfirst=True)
                conn.commit()

            if "incident_events" not in table_names:
                from backend.app.models.entities import IncidentEvent
                IncidentEvent.__table__.create(bind=conn, checkfirst=True)
                conn.commit()

            if "users" not in table_names:
                from backend.app.models.entities import User
                User.__table__.create(bind=conn, checkfirst=True)
                conn.commit()

            if "crash_alerts" not in table_names:
                from backend.app.models.entities import CrashAlert
                CrashAlert.__table__.create(bind=conn, checkfirst=True)
                conn.commit()
    except Exception as e:
        logger.warning(f"Schema upgrade check note: {e}")

def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
