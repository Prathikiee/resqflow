import logging
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Response, Request
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.core.config import settings
from backend.app.core.security import hash_password, verify_password, create_access_token
from backend.app.models.entities import User, Hospital, Ambulance
from backend.app.schemas.auth import LoginRequest, TokenResponse, UserOut, UserCreateRequest
from backend.app.core.auth import (
    get_current_user,
    require_role,
    build_user_out,
    ROLE_SUPER_ADMIN,
    ROLE_DISPATCHER,
    ROLE_HOSPITAL_STAFF,
    ROLE_AMBULANCE_CREW,
    ROLE_CITIZEN,
    ALL_ROLES,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["Authentication & Access Control"])

@router.post("/login", response_model=TokenResponse)
def login(
    payload: LoginRequest,
    response: Response,
    db: Session = Depends(get_db),
):
    """
    Authenticates user credentials and issues a signed JWT token.
    Also attaches an HTTP-only session cookie for seamless web portal navigation.
    """
    email_clean = payload.email.strip().lower()
    user = db.query(User).filter(User.email == email_clean).first()

    if not user:
        # Prevent timing enumeration attacks with a dummy verify
        verify_password("dummy-timing-password", "$2b$12$e80MvIkn8jA4w3rFj9f8IupkX1b544h3K0W36J7P4r7/g1h82G1xK")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is deactivated. Contact regional administrator.",
        )

    # Build token claims
    token_data = {
        "sub": str(user.id),
        "email": user.email,
        "role": user.role,
        "name": user.full_name,
        "hospital_id": user.hospital_id,
        "ambulance_id": user.ambulance_id,
    }
    access_token = create_access_token(token_data)

    # Set HTTP-only cookie for browser portal transitions
    # In development, secure=False allows localhost HTTP testing
    response.set_cookie(
        key="lifelink_token",
        value=access_token,
        httponly=True,
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        samesite="lax",
        secure=False,
    )

    logger.info(f"User {user.email} (Role: {user.role}) authenticated successfully.")
    return TokenResponse(
        access_token=access_token,
        token_type="bearer",
        user=build_user_out(user),
    )

@router.post("/logout")
def logout(response: Response):
    """
    Terminates session by expiring the HTTP-only auth cookie.
    """
    response.delete_cookie(key="lifelink_token")
    return {
        "status": "logged_out",
        "message": "Session terminated successfully",
    }

@router.get("/me", response_model=UserOut)
def get_authenticated_profile(current_user: User = Depends(get_current_user)):
    """
    Returns the authenticated user's profile and affiliated resource identifiers.
    """
    return build_user_out(current_user)

@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(ROLE_SUPER_ADMIN, ROLE_DISPATCHER)),
):
    """
    Provision a new authorized user. Only SUPER_ADMIN and DISPATCHER can provision users.
    Only SUPER_ADMIN can provision other SUPER_ADMIN users.
    """
    if payload.role == ROLE_SUPER_ADMIN and current_user.role != ROLE_SUPER_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Super Administrators can create other Super Administrators",
        )

    if payload.role not in ALL_ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid role '{payload.role}'. Must be one of: {', '.join(ALL_ROLES)}",
        )

    email_clean = payload.email.strip().lower()
    existing = db.query(User).filter(User.email == email_clean).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"User with email '{email_clean}' already exists",
        )

    # Validate hospital/ambulance affiliations if provided
    if payload.hospital_id:
        h = db.query(Hospital).filter(Hospital.id == payload.hospital_id).first()
        if not h:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Hospital ID {payload.hospital_id} not found")

    if payload.ambulance_id:
        a = db.query(Ambulance).filter(Ambulance.id == payload.ambulance_id).first()
        if not a:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Ambulance ID {payload.ambulance_id} not found")

    new_user = User(
        email=email_clean,
        password_hash=hash_password(payload.password),
        full_name=payload.full_name.strip(),
        role=payload.role,
        hospital_id=payload.hospital_id,
        ambulance_id=payload.ambulance_id,
        phone_number=payload.phone_number,
        is_active=True,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    logger.info(f"User {new_user.email} provisioned by {current_user.email} (Role: {new_user.role})")
    return build_user_out(new_user)

@router.get("/users", response_model=List[UserOut])
def list_users(
    role: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role(ROLE_SUPER_ADMIN, ROLE_DISPATCHER)),
):
    """
    Lists users. Restricted to DISPATCHER and SUPER_ADMIN.
    """
    query = db.query(User)
    if role:
        query = query.filter(User.role == role)
    users = query.order_by(User.created_at.desc()).all()
    return [build_user_out(u) for u in users]
