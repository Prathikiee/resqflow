from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.core.config import settings
from backend.app.core.auth import get_current_user, ROLE_SUPER_ADMIN
from backend.app.models.entities import User
from backend.app.services.seed_service import seed_database

router = APIRouter(prefix="/api/seed", tags=["seed"])

@router.post("")
def trigger_seed(
    force: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Seeds or resets demonstration data (Mangaluru hospitals, ambulances, incidents, users).
    Protected:
      - Blocked unconditionally in production environments.
      - Strictly restricted to authenticated users with SUPER_ADMIN role.
      - Blocks unauthenticated users, dispatchers, citizens, paramedics, and hospital staff.
    """
    if settings.ENVIRONMENT.lower() == "production":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Database seeding and resets are strictly disabled in production environments.",
        )

    if current_user.role != ROLE_SUPER_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: Only Super Administrators are authorized to seed or reset operational data.",
        )

    result = seed_database(db, force=force)
    return {
        "status": "success",
        "message": "Seeded realistic Mangaluru operational dataset",
        "counts": result,
    }
