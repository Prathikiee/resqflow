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
                conn.commit()

            if "dispatches" in table_names:
                disp_cols = [c["name"] for c in inspector.get_columns("dispatches")]
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
    except Exception as e:
        logger.warning(f"Schema upgrade check note: {e}")

def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
