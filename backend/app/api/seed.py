from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.core.config import settings
from backend.app.core.auth import get_optional_current_user, ROLE_SUPER_ADMIN, ROLE_DISPATCHER
from backend.app.models.entities import User
from backend.app.services.seed_service import seed_database

router = APIRouter(prefix="/api/seed", tags=["seed"])

@router.post("")
def trigger_seed(
    force: bool = False,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Seeds or resets demonstration data (Mangaluru hospitals, ambulances, incidents, users).
    Protected:
      - Blocked unconditionally in production environments.
      - In authenticated contexts, restricted to SUPER_ADMIN or DISPATCHER.
    """
    if settings.ENVIRONMENT.lower() == "production":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Database seeding is strictly disabled in production environments.",
        )

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user and auth_user.role not in (ROLE_SUPER_ADMIN, ROLE_DISPATCHER):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: Only Super Administrators and Dispatchers can trigger database reset or seeding.",
        )

    result = seed_database(db, force=force)
    return {
        "status": "success",
        "message": "Seeded realistic Mangaluru operational dataset",
        "counts": result,
    }
