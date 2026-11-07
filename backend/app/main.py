"""
Velnora Backend API Main Application.
FastAPI endpoints for authentication, transactions, categories, and profiles.
Backed by PostgreSQL (Neon) with connection pooling, Argon2id, and JWT.
"""

from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from enum import Enum
import hashlib
import logging
from typing import Optional
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, and_, or_, text
from sqlalchemy.orm import Session

from backend.app.config import configure_logging, get_settings
from backend.app.db.session import get_db
from backend.app.db.models import (
    User as UserModel,
    UserProfile as UserProfileModel,
    Transaction as TransactionModel,
    Category as CategoryModel,
    RefreshToken as RefreshTokenModel,
)
from .auth import (
    AuthResponse,
    ForgotPasswordRequest,
    LoginRequest,
    LogoutRequest,
    RefreshRequest,
    RegisterRequest,
    UserRecord,
    UserResponse,
    current_user,
    decode_token,
    hash_token,
    issue_tokens,
    store,
    user_response,
)

PAISE_FACTOR = Decimal("100")
PAISE_UNIT = Decimal("1")


def to_paise(amount: Decimal) -> int:
    """Convert Decimal rupee amount to exact integer paise without floating-point arithmetic."""
    return int((amount * PAISE_FACTOR).quantize(PAISE_UNIT, rounding=ROUND_HALF_UP))


from backend.app.sync import router as sync_router
from backend.app.receipts import router as receipts_router

settings = get_settings()
configure_logging(settings)
logger = logging.getLogger("velnora")

app = FastAPI(title="Velnora API", version="0.2.0", docs_url="/api/docs")
app.include_router(sync_router)
app.include_router(receipts_router)
# CORS: explicit origins from VELNORA_CORS_ORIGINS. Credentials are never combined with the "*" wildcard (and "*" is
# rejected outright in production by config.py). Native mobile requests are not subject to CORS; this protects web clients.
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=settings.cors_allows_credentials,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


class Direction(str, Enum):
    income = "income"
    expense = "expense"


class TransactionCreate(BaseModel):
    amount: Decimal = Field(gt=0, decimal_places=2)
    direction: Direction
    counterparty: str = Field(min_length=1, max_length=160)
    category: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    transaction_date: Optional[datetime] = None
    reference_id: Optional[str] = Field(default=None, max_length=160)
    fingerprint: Optional[str] = Field(default=None, max_length=64)


class TransactionUpdate(BaseModel):
    amount: Optional[Decimal] = Field(default=None, gt=0, decimal_places=2)
    direction: Optional[Direction] = None
    counterparty: Optional[str] = Field(default=None, min_length=1, max_length=160)
    category: Optional[str] = Field(default=None, min_length=1, max_length=80)
    description: Optional[str] = Field(default=None, max_length=500)
    transaction_date: Optional[datetime] = None


class Transaction(TransactionCreate):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    user_id: UUID
    amount_paise: Optional[int] = None
    source: str = "manual"
    sync_status: str = "synced"
    server_version: int = 1
    deleted_at: Optional[datetime] = None
    created_at: datetime
    updated_at: Optional[datetime] = None


class ProfileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    user_id: UUID
    full_name: str
    email: str
    currency: str
    theme: str
    created_at: datetime


class ProfileUpdate(BaseModel):
    full_name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    currency: Optional[str] = Field(default=None, min_length=2, max_length=10)
    theme: Optional[str] = Field(default=None, max_length=20)


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    direction: Direction
    icon: str = Field(default="tag", max_length=50)
    color: str = Field(default="#6366f1", max_length=20)


class CategoryUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    direction: Optional[Direction] = None
    icon: Optional[str] = Field(default=None, max_length=50)
    color: Optional[str] = Field(default=None, max_length=20)


class CategoryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    user_id: Optional[UUID] = None
    name: str
    direction: str
    icon: str
    color: str
    is_system: bool
    created_at: datetime


# Default system categories seeded for application users
DEFAULT_SYSTEM_CATEGORIES = [
    {"name": "Food & Dining", "direction": "expense", "icon": "utensils", "color": "#f97316"},
    {"name": "Shopping", "direction": "expense", "icon": "shopping-bag", "color": "#ec4899"},
    {"name": "Transportation", "direction": "expense", "icon": "car", "color": "#3b82f6"},
    {"name": "Utilities", "direction": "expense", "icon": "zap", "color": "#eab308"},
    {"name": "Entertainment", "direction": "expense", "icon": "film", "color": "#8b5cf6"},
    {"name": "Salary", "direction": "income", "icon": "briefcase", "color": "#10b981"},
    {"name": "Investments", "direction": "income", "icon": "trending-up", "color": "#06b6d4"},
    {"name": "Other Income", "direction": "income", "icon": "plus-circle", "color": "#14b8a6"},
    {"name": "Other Expenses", "direction": "expense", "icon": "minus-circle", "color": "#64748b"},
]


# ==============================================================================
# Health Check Endpoint
# ==============================================================================
@app.get("/api/v1/health")
def health() -> dict[str, str]:
    """Liveness only (use this as the Render health-check path): the process is up. Touches no database or secrets."""
    return {"status": "ok", "service": "velnora-api"}


@app.get("/api/v1/health/ready")
def health_ready(db: Session = Depends(get_db)):
    """Readiness: can the API reach PostgreSQL? Reports only ok/unavailable — never connection details or errors."""
    try:
        db.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001 - deliberately generic; the cause is logged without the connection string
        logger.warning("Database readiness check failed")
        return JSONResponse(status_code=503, content={"status": "unavailable", "database": "unavailable"})
    return {"status": "ok", "database": "ok"}


# ==============================================================================
# Authentication Endpoints
# ==============================================================================
@app.post("/api/v1/auth/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, db: Session = Depends(get_db)) -> AuthResponse:
    if not payload.terms_accepted:
        raise HTTPException(status_code=400, detail="Terms acceptance is required")
    if not any(character.isupper() for character in payload.password) or not any(character.isdigit() for character in payload.password):
        raise HTTPException(status_code=400, detail="Password must contain an uppercase letter and a number")

    try:
        user = store.register(payload.full_name, str(payload.email), payload.password, db=db)
    except ValueError:
        raise HTTPException(status_code=409, detail="An account with that email already exists") from None

    access_token, refresh_token = issue_tokens(user, db=db)
    return AuthResponse(user=user_response(user), access_token=access_token, refresh_token=refresh_token)


@app.post("/api/v1/auth/login", response_model=AuthResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> AuthResponse:
    user = store.authenticate(str(payload.email), payload.password, db=db)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    access_token, refresh_token = issue_tokens(user, db=db)
    return AuthResponse(user=user_response(user), access_token=access_token, refresh_token=refresh_token)


@app.post("/api/v1/auth/refresh", response_model=AuthResponse)
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)) -> AuthResponse:
    user = decode_token(payload.refresh_token, "refresh", db=db)
    token_h = hash_token(payload.refresh_token)

    stmt = select(RefreshTokenModel).where(
        RefreshTokenModel.token_hash == token_h,
        RefreshTokenModel.user_id == user.id,
    )
    token_row = db.scalar(stmt)
    now = datetime.now(timezone.utc)

    if not token_row or token_row.revoked_at is not None or token_row.expires_at < now:
        raise HTTPException(status_code=401, detail="Invalid or revoked session")

    # Rotate refresh token: revoke previous token
    token_row.revoked_at = now
    db.commit()

    # Issue new pair
    access_token, refresh_token = issue_tokens(user, db=db)
    return AuthResponse(user=user_response(user), access_token=access_token, refresh_token=refresh_token)


@app.post("/api/v1/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(payload: LogoutRequest, user: UserModel = Depends(current_user), db: Session = Depends(get_db)) -> None:
    now = datetime.now(timezone.utc)
    if payload.refresh_token:
        token_h = hash_token(payload.refresh_token)
        stmt = select(RefreshTokenModel).where(
            RefreshTokenModel.token_hash == token_h,
            RefreshTokenModel.user_id == user.id,
        )
        token_row = db.scalar(stmt)
        if token_row and token_row.revoked_at is None:
            token_row.revoked_at = now
            db.commit()
    else:
        # Revoke all active refresh tokens for the user
        stmt = select(RefreshTokenModel).where(
            RefreshTokenModel.user_id == user.id,
            RefreshTokenModel.revoked_at.is_(None),
        )
        for row in db.scalars(stmt).all():
            row.revoked_at = now
        db.commit()


@app.post("/api/v1/auth/forgot-password")
def forgot_password(_: ForgotPasswordRequest) -> dict[str, str]:
    raise HTTPException(status_code=503, detail="Password reset delivery is not configured in this environment")


@app.get("/api/v1/me", response_model=UserResponse)
def me(user: UserModel = Depends(current_user)) -> UserResponse:
    return user_response(user)


# ==============================================================================
# Transaction Endpoints
# ==============================================================================
@app.get("/api/v1/transactions", response_model=list[Transaction])
def list_transactions(
    user: UserModel = Depends(current_user),
    direction: Optional[Direction] = None,
    category: Optional[str] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    limit: int = Query(default=50, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
) -> list[Transaction]:
    stmt = select(TransactionModel).where(
        TransactionModel.user_id == user.id,
        TransactionModel.deleted_at.is_(None),
    )
    if direction:
        stmt = stmt.where(TransactionModel.direction == direction.value)
    if category:
        stmt = stmt.where(TransactionModel.category == category)
    if start_date:
        stmt = stmt.where(TransactionModel.transaction_date >= start_date)
    if end_date:
        stmt = stmt.where(TransactionModel.transaction_date <= end_date)

    stmt = stmt.order_by(TransactionModel.transaction_date.desc()).offset(offset).limit(limit)
    return db.scalars(stmt).all()


@app.post("/api/v1/transactions", response_model=Transaction, status_code=status.HTTP_201_CREATED)
def create_transaction(
    payload: TransactionCreate,
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> Transaction:
    # Acquire user-level row lock before allocating sequence or creating transaction
    db.execute(select(UserModel.id).where(UserModel.id == user.id).with_for_update())

    # Deduplication check by reference_id
    if payload.reference_id:
        existing = db.scalar(
            select(TransactionModel).where(
                TransactionModel.user_id == user.id,
                TransactionModel.reference_id == payload.reference_id.strip(),
                TransactionModel.deleted_at.is_(None),
            )
        )
        if existing:
            return existing

    # Deduplication check by fingerprint if supplied
    if payload.fingerprint:
        existing = db.scalar(
            select(TransactionModel).where(
                TransactionModel.user_id == user.id,
                TransactionModel.fingerprint == payload.fingerprint.strip(),
                TransactionModel.deleted_at.is_(None),
            )
        )
        if existing:
            return existing

    amount_paise = to_paise(payload.amount)
    tx_date = payload.transaction_date or datetime.now(timezone.utc)

    record = TransactionModel(
        user_id=user.id,
        amount=payload.amount,
        amount_paise=amount_paise,
        direction=payload.direction.value,
        counterparty=payload.counterparty.strip(),
        category=payload.category.strip(),
        description=payload.description.strip() if payload.description else "",
        transaction_date=tx_date,
        reference_id=payload.reference_id.strip() if payload.reference_id else None,
        fingerprint=payload.fingerprint.strip() if payload.fingerprint else None,
        source="manual",
        sync_status="synced",
        server_version=1,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


@app.get("/api/v1/transactions/{transaction_id}", response_model=Transaction)
def get_transaction(
    transaction_id: UUID,
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> Transaction:
    record = db.scalar(
        select(TransactionModel).where(
            TransactionModel.id == transaction_id,
            TransactionModel.user_id == user.id,
            TransactionModel.deleted_at.is_(None),
        )
    )
    if not record:
        raise HTTPException(status_code=404, detail="Transaction not found")
    return record


@app.patch("/api/v1/transactions/{transaction_id}", response_model=Transaction)
def update_transaction(
    transaction_id: UUID,
    payload: TransactionUpdate,
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> Transaction:
    # Acquire user-level row lock before updating sequence or modifying transaction
    db.execute(select(UserModel.id).where(UserModel.id == user.id).with_for_update())

    record = db.scalar(
        select(TransactionModel).where(
            TransactionModel.id == transaction_id,
            TransactionModel.user_id == user.id,
            TransactionModel.deleted_at.is_(None),
        ).with_for_update()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Transaction not found")

    if payload.amount is not None:
        record.amount = payload.amount
        record.amount_paise = to_paise(payload.amount)
    if payload.direction is not None:
        record.direction = payload.direction.value
    if payload.counterparty is not None:
        record.counterparty = payload.counterparty.strip()
    if payload.category is not None:
        record.category = payload.category.strip()
    if payload.description is not None:
        record.description = payload.description.strip()
    if payload.transaction_date is not None:
        record.transaction_date = payload.transaction_date

    record.server_version += 1
    record.updated_at = datetime.now(timezone.utc)
    record.sync_revision = db.scalar(text("SELECT nextval('sync_revision_seq')"))
    db.commit()
    db.refresh(record)
    return record


@app.delete("/api/v1/transactions/{transaction_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_transaction(
    transaction_id: UUID,
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> None:
    # Acquire user-level row lock before updating sequence or soft-deleting transaction
    db.execute(select(UserModel.id).where(UserModel.id == user.id).with_for_update())

    record = db.scalar(
        select(TransactionModel).where(
            TransactionModel.id == transaction_id,
            TransactionModel.user_id == user.id,
            TransactionModel.deleted_at.is_(None),
        ).with_for_update()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Transaction not found")

    # Soft delete tombstone
    record.deleted_at = datetime.now(timezone.utc)
    record.server_version += 1
    record.updated_at = datetime.now(timezone.utc)
    record.sync_revision = db.scalar(text("SELECT nextval('sync_revision_seq')"))
    db.commit()


# ==============================================================================
# User Profile Endpoints
# ==============================================================================
@app.get("/api/v1/profile", response_model=ProfileResponse)
def get_profile(user: UserModel = Depends(current_user), db: Session = Depends(get_db)) -> ProfileResponse:
    profile = db.scalar(select(UserProfileModel).where(UserProfileModel.user_id == user.id))
    if not profile:
        profile = UserProfileModel(user_id=user.id, full_name="", currency="INR", theme="system")
        db.add(profile)
        db.commit()
        db.refresh(profile)

    return ProfileResponse(
        id=profile.id,
        user_id=profile.user_id,
        full_name=profile.full_name,
        email=user.email,
        currency=profile.currency,
        theme=profile.theme,
        created_at=profile.created_at,
    )


@app.patch("/api/v1/profile", response_model=ProfileResponse)
def update_profile(
    payload: ProfileUpdate,
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> ProfileResponse:
    profile = db.scalar(select(UserProfileModel).where(UserProfileModel.user_id == user.id))
    if not profile:
        profile = UserProfileModel(user_id=user.id, full_name="", currency="INR", theme="system")
        db.add(profile)

    if payload.full_name is not None:
        profile.full_name = payload.full_name.strip()
    if payload.currency is not None:
        profile.currency = payload.currency.strip().upper()
    if payload.theme is not None:
        profile.theme = payload.theme.strip()

    profile.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(profile)

    return ProfileResponse(
        id=profile.id,
        user_id=profile.user_id,
        full_name=profile.full_name,
        email=user.email,
        currency=profile.currency,
        theme=profile.theme,
        created_at=profile.created_at,
    )


# ==============================================================================
# Category Endpoints
# ==============================================================================
@app.get("/api/v1/categories", response_model=list[CategoryResponse])
def list_categories(user: UserModel = Depends(current_user), db: Session = Depends(get_db)) -> list[CategoryResponse]:
    # Ensure default system categories are seeded in the database
    system_count = db.scalar(select(CategoryModel).where(CategoryModel.is_system == True).limit(1))
    if not system_count:
        for cat_data in DEFAULT_SYSTEM_CATEGORIES:
            cat = CategoryModel(
                user_id=None,
                name=cat_data["name"],
                direction=cat_data["direction"],
                icon=cat_data["icon"],
                color=cat_data["color"],
                is_system=True,
            )
            db.add(cat)
        db.commit()

    # Query system categories + categories created by this user
    stmt = select(CategoryModel).where(
        or_(
            CategoryModel.is_system == True,
            CategoryModel.user_id == user.id,
            CategoryModel.user_id.is_(None),
        )
    ).order_by(CategoryModel.name.asc())

    return db.scalars(stmt).all()


@app.post("/api/v1/categories", response_model=CategoryResponse, status_code=status.HTTP_201_CREATED)
def create_category(
    payload: CategoryCreate,
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> CategoryResponse:
    name_clean = payload.name.strip()
    existing = db.scalar(
        select(CategoryModel).where(
            CategoryModel.user_id == user.id,
            CategoryModel.name == name_clean,
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="A category with that name already exists")

    cat = CategoryModel(
        user_id=user.id,
        name=name_clean,
        direction=payload.direction.value,
        icon=payload.icon.strip(),
        color=payload.color.strip(),
        is_system=False,
    )
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return cat


@app.patch("/api/v1/categories/{category_id}", response_model=CategoryResponse)
def update_category(
    category_id: UUID,
    payload: CategoryUpdate,
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> CategoryResponse:
    cat = db.scalar(select(CategoryModel).where(CategoryModel.id == category_id))
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    if cat.is_system or cat.user_id != user.id:
        raise HTTPException(status_code=403, detail="System or other users' categories cannot be modified")

    if payload.name is not None:
        cat.name = payload.name.strip()
    if payload.direction is not None:
        cat.direction = payload.direction.value
    if payload.icon is not None:
        cat.icon = payload.icon.strip()
    if payload.color is not None:
        cat.color = payload.color.strip()

    cat.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(cat)
    return cat


@app.delete("/api/v1/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(
    category_id: UUID,
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> None:
    cat = db.scalar(select(CategoryModel).where(CategoryModel.id == category_id))
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    if cat.is_system or cat.user_id != user.id:
        raise HTTPException(status_code=403, detail="System or other users' categories cannot be deleted")

    db.delete(cat)
    db.commit()
