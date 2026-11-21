"""
Persistent Authentication Module for Velnora Backend.
PostgreSQL-backed user authentication, Argon2id password hashing,
JWT token issuance, and refresh token rotation/revocation.
"""

from datetime import datetime, timedelta, timezone
import hashlib
from secrets import token_urlsafe
from typing import Optional
from uuid import UUID, uuid4

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select, and_
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.session import get_db, get_session_factory
from app.db.models import User, UserProfile, RefreshToken

password_hasher = PasswordHasher()
bearer_scheme = HTTPBearer(auto_error=False)

JWT_ALGORITHM = "HS256"
# Secret and lifetimes come from the environment via config.py (JWT_SECRET_KEY, legacy alias VELNORA_JWT_SECRET,
# JWT_ACCESS_TOKEN_EXPIRE_MINUTES, JWT_REFRESH_TOKEN_EXPIRE_DAYS). In production a missing/weak secret raises a
# ConfigError at start-up. Token format and the 15-minute / 30-day defaults are unchanged.
_settings = get_settings()
JWT_SECRET = _settings.jwt_secret_key
ACCESS_TOKEN_MINUTES = _settings.jwt_access_token_expire_minutes
REFRESH_TOKEN_DAYS = _settings.jwt_refresh_token_expire_days


def hash_token(token: str) -> str:
    """Compute SHA-256 hash of raw token for safe database persistence."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# Backward-compatibility alias so existing type hints pointing to UserRecord resolve to User ORM model
UserRecord = User


class RegisterRequest(BaseModel):
    full_name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    terms_accepted: bool


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=20)


class LogoutRequest(BaseModel):
    refresh_token: Optional[str] = None


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class UserResponse(BaseModel):
    id: UUID
    full_name: str
    email: EmailStr


class AuthResponse(BaseModel):
    user: UserResponse
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


def user_response(user: User) -> UserResponse:
    """Map User model to UserResponse schema."""
    full_name = user.profile.full_name if (hasattr(user, "profile") and user.profile) else getattr(user, "full_name", "")
    return UserResponse(id=user.id, full_name=full_name, email=user.email)


def create_token(user_id: UUID, token_type: str, lifetime: timedelta) -> str:
    """Generate signed JWT token."""
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": str(user_id),
            "type": token_type,
            "iat": now,
            "exp": now + lifetime,
            "jti": token_urlsafe(16),
        },
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


def issue_tokens(user: User, db: Optional[Session] = None, commit: bool = True) -> tuple[str, str]:
    """
    Issue a new access token and refresh token pair.
    Persists the hashed refresh token into PostgreSQL refresh_tokens table.

    ``commit=False`` (only with a caller-supplied ``db``) leaves the new row uncommitted so the caller can make it part of a
    larger transaction, e.g. refresh rotation, where revoking the old token and issuing the new one must succeed or fail together.
    """
    access_token = create_token(user.id, "access", timedelta(minutes=ACCESS_TOKEN_MINUTES))
    refresh_token = create_token(user.id, "refresh", timedelta(days=REFRESH_TOKEN_DAYS))
    token_h = hash_token(refresh_token)
    expires_at = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_DAYS)

    record = RefreshToken(
        user_id=user.id,
        token_hash=token_h,
        expires_at=expires_at,
    )

    if db is not None:
        db.add(record)
        if commit:
            db.commit()
    else:
        SessionLocal = get_session_factory()
        with SessionLocal() as session:
            session.add(record)
            session.commit()

    return access_token, refresh_token


def decode_token(token: str, expected_type: str, db: Optional[Session] = None) -> User:
    """
    Decode and validate JWT token against PostgreSQL users table.
    Raises 401 if invalid, expired, or user not found.
    """
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("type") != expected_type:
            raise ValueError("Token type mismatch")
        user_id = UUID(payload["sub"])
    except (jwt.InvalidTokenError, KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session") from None

    if db is not None:
        user = db.get(User, user_id)
    else:
        SessionLocal = get_session_factory()
        with SessionLocal() as session:
            user = session.get(User, user_id)

    if not user or user.account_status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session")

    return user


def current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    """FastAPI dependency: Authenticates user via Bearer JWT access token."""
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return decode_token(credentials.credentials, "access", db)


class PostgresAuthStore:
    """
    PostgreSQL-backed AuthStore implementation providing seamless compatibility
    with legacy store method signatures.
    """

    def register(self, full_name: str, email: str, password: str, db: Optional[Session] = None) -> User:
        normalized_email = email.strip().lower()

        def _do_register(session: Session) -> User:
            existing = session.scalar(select(User).where(User.email == normalized_email))
            if existing:
                raise ValueError("duplicate_email")

            hashed_pw = password_hasher.hash(password)
            user = User(
                email=normalized_email,
                password_hash=hashed_pw,
                account_status="active",
            )
            profile = UserProfile(
                user=user,
                full_name=full_name.strip(),
                currency="INR",
                theme="system",
            )
            session.add(user)
            session.add(profile)
            session.commit()
            session.refresh(user)
            return user

        if db is not None:
            return _do_register(db)
        SessionLocal = get_session_factory()
        with SessionLocal() as session:
            return _do_register(session)

    def authenticate(self, email: str, password: str, db: Optional[Session] = None) -> Optional[User]:
        normalized_email = email.strip().lower()

        def _do_auth(session: Session) -> Optional[User]:
            user = session.scalar(select(User).where(User.email == normalized_email))
            if not user or user.account_status != "active":
                return None
            try:
                if password_hasher.verify(user.password_hash, password):
                    return user
            except (VerifyMismatchError, InvalidHashError):
                return None
            return None

        if db is not None:
            return _do_auth(db)
        SessionLocal = get_session_factory()
        with SessionLocal() as session:
            return _do_auth(session)

    def get_user(self, user_id: UUID, db: Optional[Session] = None) -> Optional[User]:
        if db is not None:
            return db.get(User, user_id)
        SessionLocal = get_session_factory()
        with SessionLocal() as session:
            return session.get(User, user_id)


# Global persistent auth store
store = PostgresAuthStore()
