from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.services.seed_service import seed_database

router = APIRouter(prefix="/api/seed", tags=["seed"])

@router.post("")
def trigger_seed(force: bool = False, db: Session = Depends(get_db)):
    """
    Seeds or resets demonstration data (Mangaluru hospitals, ambulances, incident).
    """
    result = seed_database(db, force=force)
    return {
        "status": "success",
        "message": "Seeded realistic Mangaluru operational dataset",
        "counts": result,
    }
