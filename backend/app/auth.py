from datetime import datetime, timedelta, timezone
from os import getenv
from secrets import token_urlsafe
from uuid import UUID, uuid4

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field

password_hasher = PasswordHasher()
bearer_scheme = HTTPBearer(auto_error=False)
JWT_ALGORITHM = "HS256"
JWT_SECRET = getenv("VELNORA_JWT_SECRET", "development-only-change-me")
if getenv("VELNORA_ENV", "development") == "production" and JWT_SECRET == "development-only-change-me":
    raise RuntimeError("VELNORA_JWT_SECRET must be configured in production")
ACCESS_TOKEN_MINUTES = 15
REFRESH_TOKEN_DAYS = 30


class UserRecord:
    def __init__(self, full_name: str, email: str, password_hash: str) -> None:
        self.id = uuid4()
        self.full_name = full_name
        self.email = email
        self.password_hash = password_hash
        self.refresh_tokens: set[str] = set()


class AuthStore:
    def __init__(self) -> None:
        self.users_by_email: dict[str, UserRecord] = {}
        self.users_by_id: dict[UUID, UserRecord] = {}

    def register(self, full_name: str, email: str, password: str) -> UserRecord:
        normalized_email = email.strip().lower()
        if normalized_email in self.users_by_email:
            raise ValueError("duplicate_email")
        user = UserRecord(full_name.strip(), normalized_email, password_hasher.hash(password))
        self.users_by_email[normalized_email] = user
        self.users_by_id[user.id] = user
        return user

    def authenticate(self, email: str, password: str) -> UserRecord | None:
        user = self.users_by_email.get(email.strip().lower())
        if not user:
            return None
        try:
            if password_hasher.verify(user.password_hash, password):
                return user
        except (VerifyMismatchError, InvalidHashError):
            return None
        return None

    def get_user(self, user_id: UUID) -> UserRecord | None:
        return self.users_by_id.get(user_id)


store = AuthStore()


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
    refresh_token: str | None = None


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


def user_response(user: UserRecord) -> UserResponse:
    return UserResponse(id=user.id, full_name=user.full_name, email=user.email)


def create_token(user: UserRecord, token_type: str, lifetime: timedelta) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {"sub": str(user.id), "type": token_type, "iat": now, "exp": now + lifetime, "jti": token_urlsafe(16)},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


def issue_tokens(user: UserRecord) -> tuple[str, str]:
    access_token = create_token(user, "access", timedelta(minutes=ACCESS_TOKEN_MINUTES))
    refresh_token = create_token(user, "refresh", timedelta(days=REFRESH_TOKEN_DAYS))
    user.refresh_tokens.add(refresh_token)
    return access_token, refresh_token


def decode_token(token: str, expected_type: str) -> UserRecord:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("type") != expected_type:
            raise ValueError
        user_id = UUID(payload["sub"])
    except (jwt.InvalidTokenError, KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session") from None
    user = store.get_user(user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session")
    return user


def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)) -> UserRecord:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return decode_token(credentials.credentials, "access")
