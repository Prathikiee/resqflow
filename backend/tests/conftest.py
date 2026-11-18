import os
import sys
from pathlib import Path

# Set test database URL before database.py is imported
TEST_DB_PATH = Path("test_resqflow.db").resolve()
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH}"

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, Session
from backend.app.core.database import Base, upgrade_schema, get_db, set_sqlite_pragma
import backend.app.core.database as db_module
from backend.app.services.seed_service import seed_database
from backend.app.main import app

# Ensure engine points to isolated test database
test_engine = create_engine(
    f"sqlite:///{TEST_DB_PATH}",
    connect_args={"check_same_thread": False, "timeout": 30.0},
    pool_pre_ping=True,
)

event.listen(test_engine, "connect", set_sqlite_pragma)

TestSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

# Patch the core database module so background threads and imports use the test database
db_module.engine = test_engine
db_module.SessionLocal = TestSessionLocal

@pytest.fixture(scope="session", autouse=True)
def setup_test_database():
    """Initializes tables on the isolated test database."""
    Base.metadata.create_all(bind=test_engine)
    upgrade_schema(target_engine=test_engine)
    yield
    # Cleanup after session
    try:
        test_engine.dispose()
        for f in [TEST_DB_PATH, Path(f"{TEST_DB_PATH}-shm"), Path(f"{TEST_DB_PATH}-wal")]:
            if f.exists():
                f.unlink(missing_ok=True)
    except Exception:
        pass

@pytest.fixture
def db():
    """Provides a fresh database session seeded with Mangaluru operational dataset."""
    session = TestSessionLocal()
    seed_database(session, force=True)
    
    def override_get_db():
        try:
            yield session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    yield session
    session.close()
    app.dependency_overrides.pop(get_db, None)

@pytest.fixture
def fresh_db(db):
    """Alias for db fixture for backward compatibility."""
    return db
