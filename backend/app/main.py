from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from os import getenv
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

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
    issue_tokens,
    store,
    user_response,
)

app = FastAPI(title="Velnora API", version="0.1.0", docs_url="/api/docs")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in getenv("VELNORA_CORS_ORIGINS", "http://localhost:8081").split(",") if origin.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)


class Direction(str, Enum):
    income = "income"
    expense = "expense"


class TransactionCreate(BaseModel):
    amount: Decimal = Field(gt=0)
    direction: Direction
    counterparty: str = Field(min_length=1, max_length=160)
    category: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    transaction_date: datetime | None = None
    reference_id: str | None = Field(default=None, max_length=160)


class Transaction(TransactionCreate):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    user_id: UUID
    created_at: datetime


class InMemoryLedger:
    def __init__(self) -> None:
        self.transactions: dict[UUID, Transaction] = {}

    def add(self, user_id: UUID, payload: TransactionCreate) -> Transaction:
        if payload.reference_id:
            existing = next(
                (item for item in self.transactions.values()
                 if item.user_id == user_id and item.reference_id == payload.reference_id),
                None,
            )
            if existing:
                return existing
        record = Transaction(
            **payload.model_dump(exclude={"transaction_date"}),
            id=uuid4(),
            user_id=user_id,
            transaction_date=payload.transaction_date or datetime.now(timezone.utc),
            created_at=datetime.now(timezone.utc),
        )
        self.transactions[record.id] = record
        return record


ledger = InMemoryLedger()


@app.get("/api/v1/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "velnora-api"}


@app.get("/api/v1/transactions", response_model=list[Transaction])
def list_transactions(user: UserRecord = Depends(current_user), direction: Direction | None = None, limit: int = Query(default=50, le=100)) -> list[Transaction]:
    records = [item for item in ledger.transactions.values() if item.user_id == user.id]
    if direction:
        records = [item for item in records if item.direction == direction]
    return records[:limit]


@app.post("/api/v1/transactions", response_model=Transaction, status_code=201)
def create_transaction(payload: TransactionCreate, user: UserRecord = Depends(current_user)) -> Transaction:
    return ledger.add(user.id, payload)


@app.get("/api/v1/transactions/{transaction_id}", response_model=Transaction)
def get_transaction(transaction_id: UUID, user: UserRecord = Depends(current_user)) -> Transaction:
    record = ledger.transactions.get(transaction_id)
    if not record or record.user_id != user.id:
        raise HTTPException(status_code=404, detail="Transaction not found")
    return record


@app.post("/api/v1/auth/register", response_model=AuthResponse, status_code=201)
def register(payload: RegisterRequest) -> AuthResponse:
    if not payload.terms_accepted:
        raise HTTPException(status_code=400, detail="Terms acceptance is required")
    if not any(character.isupper() for character in payload.password) or not any(character.isdigit() for character in payload.password):
        raise HTTPException(status_code=400, detail="Password must contain an uppercase letter and a number")
    try:
        user = store.register(payload.full_name, str(payload.email), payload.password)
    except ValueError:
        raise HTTPException(status_code=409, detail="An account with that email already exists") from None
    access_token, refresh_token = issue_tokens(user)
    return AuthResponse(user=user_response(user), access_token=access_token, refresh_token=refresh_token)


@app.post("/api/v1/auth/login", response_model=AuthResponse)
def login(payload: LoginRequest) -> AuthResponse:
    user = store.authenticate(str(payload.email), payload.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    access_token, refresh_token = issue_tokens(user)
    return AuthResponse(user=user_response(user), access_token=access_token, refresh_token=refresh_token)


@app.post("/api/v1/auth/refresh", response_model=AuthResponse)
def refresh(payload: RefreshRequest) -> AuthResponse:
    user = decode_token(payload.refresh_token, "refresh")
    if payload.refresh_token not in user.refresh_tokens:
        raise HTTPException(status_code=401, detail="Invalid or revoked session")
    user.refresh_tokens.remove(payload.refresh_token)
    access_token, refresh_token = issue_tokens(user)
    return AuthResponse(user=user_response(user), access_token=access_token, refresh_token=refresh_token)


@app.post("/api/v1/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(payload: LogoutRequest, user: UserRecord = Depends(current_user)) -> None:
    if payload.refresh_token:
        user.refresh_tokens.discard(payload.refresh_token)


@app.post("/api/v1/auth/forgot-password")
def forgot_password(_: ForgotPasswordRequest) -> dict[str, str]:
    raise HTTPException(status_code=503, detail="Password reset delivery is not configured in this environment")


@app.get("/api/v1/me", response_model=UserResponse)
def me(user: UserRecord = Depends(current_user)) -> UserResponse:
    return user_response(user)
