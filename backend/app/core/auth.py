import logging
from typing import Optional, List, Callable
from fastapi import Request, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.core.security import decode_access_token
from backend.app.models.entities import User
from backend.app.schemas.auth import UserOut

logger = logging.getLogger(__name__)

# Standard role constants
ROLE_CITIZEN = "CITIZEN"
ROLE_AMBULANCE_CREW = "AMBULANCE_CREW"
ROLE_HOSPITAL_STAFF = "HOSPITAL_STAFF"
ROLE_DISPATCHER = "DISPATCHER"
ROLE_SUPER_ADMIN = "SUPER_ADMIN"

ALL_ROLES = {
    ROLE_CITIZEN,
    ROLE_AMBULANCE_CREW,
    ROLE_HOSPITAL_STAFF,
    ROLE_DISPATCHER,
    ROLE_SUPER_ADMIN,
}

optional_bearer = HTTPBearer(auto_error=False)

def extract_token_from_request(request: Request) -> Optional[str]:
    """
    Extracts JWT from:
    1. Authorization: Bearer <token>
    2. Cookie: lifelink_token=<token>
    3. Query parameter: ?token=<token>
    """
    # 1. Bearer header
    auth_header = request.headers.get("authorization") or request.headers.get("Authorization")
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header.split(" ", 1)[1].strip()

    # 2. Cookie
    cookie_token = request.cookies.get("lifelink_token")
    if cookie_token:
        return cookie_token.strip()

    # 3. Query param
    query_token = request.query_params.get("token")
    if query_token:
        return query_token.strip()

    return None

def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
) -> User:
    """
    Strict dependency enforcing authenticated active user.
    """
    token = extract_token_from_request(request)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication credentials not provided",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired access token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Malformed token claims",
        )

    try:
        user = db.query(User).filter(User.id == int(user_id)).first()
    except Exception as e:
        logger.error(f"Error fetching user {user_id}: {e}")
        user = None

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account not found or has been removed",
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is deactivated. Contact regional administrator.",
        )

    return user

def get_optional_current_user(
    request: Request,
    db: Session = Depends(get_db),
) -> Optional[User]:
    """
    Permissive dependency returning User if valid token is supplied, or None.
    """
    token = extract_token_from_request(request)
    if not token:
        return None

    payload = decode_access_token(token)
    if not payload:
        return None

    user_id = payload.get("sub")
    if not user_id:
        return None

    try:
        user = db.query(User).filter(User.id == int(user_id)).first()
        if user and user.is_active:
            return user
    except Exception:
        pass

    return None

def require_role(*allowed_roles: str) -> Callable:
    """
    Role-based access control factory.
    SUPER_ADMIN always satisfies all requirements.
    """
    def role_checker(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role == ROLE_SUPER_ADMIN:
            return current_user
        if current_user.role in allowed_roles:
            return current_user
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access denied: role '{current_user.role}' cannot perform this action",
        )
    return role_checker

def build_user_out(user: User) -> UserOut:
    """
    Serializes a User ORM instance into safe UserOut schema.
    """
    h_name = user.hospital.name if user.hospital else None
    h_code = user.hospital.facility_code if user.hospital else None
    a_call = user.ambulance.call_sign if user.ambulance else None

    return UserOut(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        hospital_id=user.hospital_id,
        hospital_name=h_name,
        hospital_facility_code=h_code,
        ambulance_id=user.ambulance_id,
        ambulance_call_sign=a_call,
        phone_number=user.phone_number,
        is_active=user.is_active,
        created_at=user.created_at,
    )
