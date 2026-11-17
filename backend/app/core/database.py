import logging
from sqlalchemy import create_engine
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
        connect_args={"check_same_thread": False},
        pool_pre_ping=True,
    )

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
