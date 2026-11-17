from backend.app.main import root, health_check
from backend.app.core.database import SessionLocal

def test_root():
    data = root()
    assert data["service"] == "ResQFlow"
    assert data["status"] == "operational"
    assert "Mangaluru" in data["region"]

def test_health():
    db = SessionLocal()
    try:
        data = health_check(db=db)
        assert data["status"] == "healthy"
        assert data["database"]["status"] == "connected"
        assert data["region"]["city"] == "Mangaluru, Karnataka"
    finally:
        db.close()
