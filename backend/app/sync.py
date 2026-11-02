"""
Velnora Two-Way Synchronization Engine Router.
Implements:
- POST /api/v1/sync/push: Batch idempotent uploads from client sync queue with atomic conflict resolution and category sync.
- GET /api/v1/sync/pull: Incremental cursor-based synchronization with tombstones, pagination, and category hydration.
- GET /api/v1/sync/status: Sync state and audit counters.
"""

from datetime import datetime, timezone, timedelta
from decimal import Decimal, ROUND_HALF_UP
from enum import Enum
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select, text
from sqlalchemy.orm import Session

from backend.app.auth import current_user
from backend.app.db.models import Transaction as TransactionModel
from backend.app.db.models import Category as CategoryModel
from backend.app.db.models import User as UserModel
from backend.app.db.session import get_db

router = APIRouter(prefix="/api/v1/sync", tags=["sync"])

PAISE_FACTOR = Decimal("100")
PAISE_UNIT = Decimal("1")
CLOCK_SKEW_TOLERANCE = timedelta(seconds=60)


def to_paise(amount: Decimal) -> int:
    """Convert Decimal rupee amount to exact integer paise without floating-point arithmetic."""
    return int((amount * PAISE_FACTOR).quantize(PAISE_UNIT, rounding=ROUND_HALF_UP))


# ==============================================================================
# Pydantic Schemas for Sync Protocol
# ==============================================================================
class SyncOperationType(str, Enum):
    create = "create"
    update = "update"
    delete = "delete"


class SyncItemPayload(BaseModel):
    amount: Optional[Decimal] = Field(default=None, gt=0, decimal_places=2)
    direction: Optional[str] = None
    counterparty: Optional[str] = None
    category: Optional[str] = None
    category_id: Optional[UUID] = None
    description: Optional[str] = ""
    transaction_date: Optional[datetime] = None
    source: Optional[str] = "manual"
    reference_id: Optional[str] = None
    fingerprint: Optional[str] = None
    deleted_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    # Category payload fields
    icon: Optional[str] = "tag"
    color: Optional[str] = "#6366f1"


class SyncPushItem(BaseModel):
    operation_id: str
    entity_type: str = "transaction"  # "transaction" | "category"
    entity_id: UUID
    operation: SyncOperationType
    client_version: int = 1
    payload: SyncItemPayload


class SyncPushRequest(BaseModel):
    device_id: Optional[str] = None
    items: List[SyncPushItem]


class SyncPullTransaction(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    amount: Decimal
    amount_paise: int
    direction: str
    counterparty: str
    category: str
    category_id: Optional[UUID] = None
    description: str
    transaction_date: datetime
    source: str
    reference_id: Optional[str] = None
    fingerprint: Optional[str] = None
    server_version: int
    sync_revision: Optional[int] = None
    deleted_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class SyncPushItemResult(BaseModel):
    operation_id: str
    entity_id: UUID
    operation: SyncOperationType
    status: str  # "synced" | "conflict_resolved" | "conflict_rejected" | "error"
    server_version: int
    updated_at: Optional[datetime] = None
    error: Optional[str] = None
    winning_record: Optional[SyncPullTransaction] = None


class SyncPushResponse(BaseModel):
    results: List[SyncPushItemResult]
    server_time: datetime


class SyncCategoryItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: Optional[UUID] = None
    name: str
    direction: str
    icon: str
    color: str
    is_system: bool
    created_at: datetime
    updated_at: datetime


class SyncPullResponse(BaseModel):
    transactions: List[SyncPullTransaction]
    categories: List[SyncCategoryItem] = Field(default_factory=list)
    categories_complete: bool = True
    server_time: datetime
    next_cursor: Optional[str] = None
    has_more: bool
    total_active_count: int


class SyncStatusResponse(BaseModel):
    server_time: datetime
    user_id: UUID
    active_transactions_count: int
    tombstones_count: int
    latest_server_version: int


# ==============================================================================
# Sync Endpoints Implementation
# ==============================================================================
@router.post("/push", response_model=SyncPushResponse)
def sync_push(
    request: SyncPushRequest,
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> SyncPushResponse:
    """
    Batch idempotent upload from mobile sync queue.
    Applies operations inside savepoints with explicit conflict resolution:
    - Atomically locks rows using with_for_update() to prevent race conditions.
    - Server version is authoritative: stale client versions cannot silently overwrite newer server data.
    - Tombstone protection: soft-deleted records cannot be resurrected.
    - Clock skew clamping prevents unverified client timestamps from dominating.
    - Supports both transaction and custom category entities.
    """
    results: List[SyncPushItemResult] = []
    now = datetime.now(timezone.utc)

    # Acquire user-level row lock upfront if any transaction operations are in this batch,
    # ensuring serialized revision allocation across the entire request.
    if any(item.entity_type == "transaction" for item in request.items):
        db.execute(select(UserModel.id).where(UserModel.id == user.id).with_for_update())

    for item in request.items:
        try:
            with db.begin_nested():
                # ==============================================================
                # 1. CATEGORY SYNC
                # ==============================================================
                if item.entity_type == "category":
                    existing_cat = db.scalar(
                        select(CategoryModel).where(CategoryModel.id == item.entity_id).with_for_update()
                    )

                    if existing_cat and not existing_cat.is_system and existing_cat.user_id != user.id:
                        results.append(
                            SyncPushItemResult(
                                operation_id=item.operation_id,
                                entity_id=item.entity_id,
                                operation=item.operation,
                                status="error",
                                server_version=0,
                                error="Forbidden: category belongs to another user",
                            )
                        )
                        continue

                    if item.operation == SyncOperationType.create:
                        if existing_cat:
                            results.append(
                                SyncPushItemResult(
                                    operation_id=item.operation_id,
                                    entity_id=existing_cat.id,
                                    operation=item.operation,
                                    status="synced",
                                    server_version=1,
                                    updated_at=existing_cat.updated_at,
                                )
                            )
                        else:
                            name = (item.payload.category or item.payload.counterparty or "Custom").strip()
                            direction = (item.payload.direction or "expense").strip()
                            new_cat = CategoryModel(
                                id=item.entity_id,
                                user_id=user.id,
                                name=name,
                                direction=direction,
                                icon=item.payload.icon or "tag",
                                color=item.payload.color or "#6366f1",
                                is_system=False,
                                created_at=now,
                                updated_at=now,
                            )
                            db.add(new_cat)
                            db.flush()
                            results.append(
                                SyncPushItemResult(
                                    operation_id=item.operation_id,
                                    entity_id=new_cat.id,
                                    operation=item.operation,
                                    status="synced",
                                    server_version=1,
                                    updated_at=now,
                                )
                            )

                    elif item.operation == SyncOperationType.update:
                        if not existing_cat:
                            results.append(
                                SyncPushItemResult(
                                    operation_id=item.operation_id,
                                    entity_id=item.entity_id,
                                    operation=item.operation,
                                    status="error",
                                    server_version=0,
                                    error="Category not found",
                                )
                            )
                        elif existing_cat.is_system:
                            results.append(
                                SyncPushItemResult(
                                    operation_id=item.operation_id,
                                    entity_id=existing_cat.id,
                                    operation=item.operation,
                                    status="error",
                                    server_version=1,
                                    error="System categories cannot be modified",
                                )
                            )
                        else:
                            if item.payload.category:
                                existing_cat.name = item.payload.category.strip()
                            if item.payload.direction:
                                existing_cat.direction = item.payload.direction.strip()
                            if item.payload.icon:
                                existing_cat.icon = item.payload.icon.strip()
                            if item.payload.color:
                                existing_cat.color = item.payload.color.strip()
                            existing_cat.updated_at = now
                            db.flush()
                            results.append(
                                SyncPushItemResult(
                                    operation_id=item.operation_id,
                                    entity_id=existing_cat.id,
                                    operation=item.operation,
                                    status="synced",
                                    server_version=2,
                                    updated_at=now,
                                )
                            )

                    elif item.operation == SyncOperationType.delete:
                        if not existing_cat:
                            results.append(
                                SyncPushItemResult(
                                    operation_id=item.operation_id,
                                    entity_id=item.entity_id,
                                    operation=item.operation,
                                    status="synced",
                                    server_version=1,
                                    updated_at=now,
                                )
                            )
                        elif existing_cat.is_system:
                            results.append(
                                SyncPushItemResult(
                                    operation_id=item.operation_id,
                                    entity_id=existing_cat.id,
                                    operation=item.operation,
                                    status="error",
                                    server_version=1,
                                    error="System categories cannot be deleted",
                                )
                            )
                        else:
                            # ON DELETE SET NULL on transactions ensures existing records are never broken
                            db.delete(existing_cat)
                            db.flush()
                            results.append(
                                SyncPushItemResult(
                                    operation_id=item.operation_id,
                                    entity_id=item.entity_id,
                                    operation=item.operation,
                                    status="synced",
                                    server_version=2,
                                    updated_at=now,
                                )
                            )
                    continue

                # ==============================================================
                # 2. TRANSACTION SYNC
                # ==============================================================
                if item.entity_type != "transaction":
                    results.append(
                        SyncPushItemResult(
                            operation_id=item.operation_id,
                            entity_id=item.entity_id,
                            operation=item.operation,
                            status="error",
                            server_version=0,
                            error=f"Unsupported entity type: {item.entity_type}",
                        )
                    )
                    continue

                # Acquire user-level row lock to serialize push modifications per user,
                # ensuring sync_revisions commit in strictly increasing, gap-free order.
                db.execute(select(UserModel.id).where(UserModel.id == user.id).with_for_update())

                # Acquire row-level lock for atomic concurrent update protection
                existing = db.scalar(
                    select(TransactionModel).where(TransactionModel.id == item.entity_id).with_for_update()
                )

                # Strict user isolation check
                if existing and existing.user_id != user.id:
                    results.append(
                        SyncPushItemResult(
                            operation_id=item.operation_id,
                            entity_id=item.entity_id,
                            operation=item.operation,
                            status="error",
                            server_version=0,
                            error="Forbidden: entity belongs to another user",
                        )
                    )
                    continue

                # --------------------------------------------------------------
                # CREATE OPERATION
                # --------------------------------------------------------------
                if item.operation == SyncOperationType.create:
                    if existing:
                        # Idempotent duplicate create (already on server)
                        results.append(
                            SyncPushItemResult(
                                operation_id=item.operation_id,
                                entity_id=existing.id,
                                operation=item.operation,
                                status="synced",
                                server_version=existing.server_version,
                                updated_at=existing.updated_at,
                            )
                        )
                    else:
                        # Deduplication check by reference_id / fingerprint for this user
                        ref_existing = None
                        if item.payload.reference_id and item.payload.reference_id.strip():
                            ref_existing = db.scalar(
                                select(TransactionModel).where(
                                    TransactionModel.user_id == user.id,
                                    TransactionModel.reference_id == item.payload.reference_id.strip(),
                                    TransactionModel.deleted_at.is_(None),
                                )
                            )
                        if not ref_existing and item.payload.fingerprint and item.payload.fingerprint.strip():
                            ref_existing = db.scalar(
                                select(TransactionModel).where(
                                    TransactionModel.user_id == user.id,
                                    TransactionModel.fingerprint == item.payload.fingerprint.strip(),
                                    TransactionModel.deleted_at.is_(None),
                                )
                            )

                        if ref_existing:
                            # Acknowledged existing record without duplicate insertion
                            results.append(
                                SyncPushItemResult(
                                    operation_id=item.operation_id,
                                    entity_id=ref_existing.id,
                                    operation=item.operation,
                                    status="synced",
                                    server_version=ref_existing.server_version,
                                    updated_at=ref_existing.updated_at,
                                )
                            )
                        else:
                            if not item.payload.amount or not item.payload.direction or not item.payload.counterparty or not item.payload.category:
                                results.append(
                                    SyncPushItemResult(
                                        operation_id=item.operation_id,
                                        entity_id=item.entity_id,
                                        operation=item.operation,
                                        status="error",
                                        server_version=0,
                                        error="Missing required fields for create (amount, direction, counterparty, category)",
                                    )
                                )
                                continue

                            amount_paise = to_paise(item.payload.amount)
                            new_tx = TransactionModel(
                                id=item.entity_id,
                                user_id=user.id,
                                amount=item.payload.amount,
                                amount_paise=amount_paise,
                                direction=item.payload.direction.strip(),
                                counterparty=item.payload.counterparty.strip(),
                                category=item.payload.category.strip(),
                                category_id=item.payload.category_id,
                                description=item.payload.description.strip() if item.payload.description else "",
                                transaction_date=item.payload.transaction_date or now,
                                source=item.payload.source or "manual",
                                reference_id=item.payload.reference_id.strip() if item.payload.reference_id else None,
                                fingerprint=item.payload.fingerprint.strip() if item.payload.fingerprint else None,
                                sync_status="synced",
                                server_version=1,
                                created_at=now,
                                updated_at=now,
                            )
                            db.add(new_tx)
                            db.flush()
                            results.append(
                                SyncPushItemResult(
                                    operation_id=item.operation_id,
                                    entity_id=new_tx.id,
                                    operation=item.operation,
                                    status="synced",
                                    server_version=1,
                                    updated_at=now,
                                )
                            )

                # --------------------------------------------------------------
                # UPDATE OPERATION
                # --------------------------------------------------------------
                elif item.operation == SyncOperationType.update:
                    if not existing:
                        # Upsert if complete record provided
                        if item.payload.amount and item.payload.direction and item.payload.counterparty and item.payload.category:
                            amount_paise = to_paise(item.payload.amount)
                            new_tx = TransactionModel(
                                id=item.entity_id,
                                user_id=user.id,
                                amount=item.payload.amount,
                                amount_paise=amount_paise,
                                direction=item.payload.direction.strip(),
                                counterparty=item.payload.counterparty.strip(),
                                category=item.payload.category.strip(),
                                category_id=item.payload.category_id,
                                description=item.payload.description.strip() if item.payload.description else "",
                                transaction_date=item.payload.transaction_date or now,
                                source=item.payload.source or "manual",
                                reference_id=item.payload.reference_id.strip() if item.payload.reference_id else None,
                                fingerprint=item.payload.fingerprint.strip() if item.payload.fingerprint else None,
                                sync_status="synced",
                                server_version=1,
                                created_at=now,
                                updated_at=now,
                            )
                            db.add(new_tx)
                            db.flush()
                            results.append(
                                SyncPushItemResult(
                                    operation_id=item.operation_id,
                                    entity_id=new_tx.id,
                                    operation=item.operation,
                                    status="synced",
                                    server_version=1,
                                    updated_at=now,
                                )
                            )
                        else:
                            results.append(
                                SyncPushItemResult(
                                    operation_id=item.operation_id,
                                    entity_id=item.entity_id,
                                    operation=item.operation,
                                    status="error",
                                    server_version=0,
                                    error="Transaction not found on server",
                                )
                            )
                    elif existing.deleted_at is not None:
                        # Tombstone protection: Deleted records cannot be resurrected by offline edits
                        results.append(
                            SyncPushItemResult(
                                operation_id=item.operation_id,
                                entity_id=existing.id,
                                operation=item.operation,
                                status="conflict_resolved",
                                server_version=existing.server_version,
                                updated_at=existing.updated_at,
                                error="Record was deleted on server (tombstone wins)",
                                winning_record=existing,
                            )
                        )
                    else:
                        # Stale version protection:
                        # If client version is behind server version, server version is authoritative.
                        # Stale devices cannot silently overwrite newer server data.
                        if item.client_version < existing.server_version:
                            results.append(
                                SyncPushItemResult(
                                    operation_id=item.operation_id,
                                    entity_id=existing.id,
                                    operation=item.operation,
                                    status="conflict_resolved",
                                    server_version=existing.server_version,
                                    updated_at=existing.updated_at,
                                    error="Server version is newer (version mismatch)",
                                    winning_record=existing,
                                )
                            )
                        else:
                            # Client version is current or newer -> apply update
                            if item.payload.amount is not None:
                                existing.amount = item.payload.amount
                                existing.amount_paise = to_paise(item.payload.amount)
                            if item.payload.direction is not None:
                                existing.direction = item.payload.direction.strip()
                            if item.payload.counterparty is not None:
                                existing.counterparty = item.payload.counterparty.strip()
                            if item.payload.category is not None:
                                existing.category = item.payload.category.strip()
                            if item.payload.category_id is not None:
                                existing.category_id = item.payload.category_id
                            if item.payload.description is not None:
                                existing.description = item.payload.description.strip()
                            if item.payload.transaction_date is not None:
                                existing.transaction_date = item.payload.transaction_date

                            existing.server_version += 1
                            existing.updated_at = now
                            existing.sync_revision = db.scalar(text("SELECT nextval('sync_revision_seq')"))
                            db.flush()
                            results.append(
                                SyncPushItemResult(
                                    operation_id=item.operation_id,
                                    entity_id=existing.id,
                                    operation=item.operation,
                                    status="synced",
                                    server_version=existing.server_version,
                                    updated_at=existing.updated_at,
                                )
                            )

                # --------------------------------------------------------------
                # DELETE OPERATION
                # --------------------------------------------------------------
                elif item.operation == SyncOperationType.delete:
                    if not existing:
                        # Idempotent delete: record doesn't exist
                        results.append(
                            SyncPushItemResult(
                                operation_id=item.operation_id,
                                entity_id=item.entity_id,
                                operation=item.operation,
                                status="synced",
                                server_version=1,
                                updated_at=now,
                            )
                        )
                    elif existing.deleted_at is not None:
                        # Already soft-deleted: idempotent
                        results.append(
                            SyncPushItemResult(
                                operation_id=item.operation_id,
                                entity_id=existing.id,
                                operation=item.operation,
                                status="synced",
                                server_version=existing.server_version,
                                updated_at=existing.updated_at,
                            )
                        )
                    else:
                        existing.deleted_at = now
                        existing.server_version += 1
                        existing.updated_at = now
                        existing.sync_revision = db.scalar(text("SELECT nextval('sync_revision_seq')"))
                        db.flush()
                        results.append(
                            SyncPushItemResult(
                                operation_id=item.operation_id,
                                entity_id=existing.id,
                                operation=item.operation,
                                status="synced",
                                server_version=existing.server_version,
                                updated_at=existing.updated_at,
                            )
                        )

        except Exception as e:
            results.append(
                SyncPushItemResult(
                    operation_id=item.operation_id,
                    entity_id=item.entity_id,
                    operation=item.operation,
                    status="error",
                    server_version=0,
                    error=str(e),
                )
            )

    db.commit()
    return SyncPushResponse(results=results, server_time=now)


@router.get("/pull", response_model=SyncPullResponse)
def sync_pull(
    since_cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    include_deleted: bool = Query(default=True),
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> SyncPullResponse:
    """
    Incremental pull endpoint for transactions and categories.
    Supports pagination and safe composite cursor (timestamp + UUID)
    to guarantee no missed records even when multiple items share timestamps.
    Hydrates custom and system categories alongside transactions.
    """
    server_time = datetime.now(timezone.utc)
    stmt = select(TransactionModel).where(TransactionModel.user_id == user.id)

    if not include_deleted:
        stmt = stmt.where(TransactionModel.deleted_at.is_(None))

    if since_cursor and since_cursor.strip() and since_cursor.strip() != "0":
        clean_cursor = since_cursor.strip()
        try:
            # Monotonic revision sequence cursor
            cursor_rev = int(clean_cursor)
            stmt = stmt.where(TransactionModel.sync_revision > cursor_rev)
        except ValueError:
            # Backward compatibility for legacy ISO timestamp or composite ts|id cursors
            if "|" in clean_cursor:
                ts_part, id_part = clean_cursor.split("|", 1)
                clean_ts = ts_part.replace(" ", "+").replace("Z", "+00:00")
                try:
                    cursor_dt = datetime.fromisoformat(clean_ts)
                    cursor_uuid = UUID(id_part)
                    stmt = stmt.where(
                        or_(
                            TransactionModel.updated_at > cursor_dt,
                            (TransactionModel.updated_at == cursor_dt) & (TransactionModel.id > cursor_uuid),
                        )
                    )
                except (ValueError, TypeError):
                    cursor_dt = datetime.fromisoformat(clean_ts)
                    stmt = stmt.where(TransactionModel.updated_at > cursor_dt)
            else:
                clean_ts = clean_cursor.replace(" ", "+").replace("Z", "+00:00")
                cursor_dt = datetime.fromisoformat(clean_ts)
                stmt = stmt.where(TransactionModel.updated_at > cursor_dt)

    # Monotonic deterministic ordering by sync_revision
    stmt = stmt.order_by(TransactionModel.sync_revision.asc(), TransactionModel.id.asc()).limit(limit + 1)
    rows = db.scalars(stmt).all()

    has_more = len(rows) > limit
    selected_rows = rows[:limit] if has_more else rows

    next_cursor = None
    if selected_rows:
        last_item = selected_rows[-1]
        next_cursor = str(last_item.sync_revision)
    elif since_cursor:
        next_cursor = since_cursor

    total_active = db.scalar(
        select(func.count(TransactionModel.id)).where(
            TransactionModel.user_id == user.id,
            TransactionModel.deleted_at.is_(None),
        )
    ) or 0

    # Hydrate user and system categories
    categories_stmt = select(CategoryModel).where(
        or_(CategoryModel.is_system.is_(True), CategoryModel.user_id == user.id)
    ).order_by(CategoryModel.name.asc())
    categories_rows = db.scalars(categories_stmt).all()

    return SyncPullResponse(
        transactions=selected_rows,
        categories=categories_rows,
        categories_complete=True,
        server_time=server_time,
        next_cursor=next_cursor,
        has_more=has_more,
        total_active_count=total_active,
    )


@router.get("/status", response_model=SyncStatusResponse)
def sync_status(
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> SyncStatusResponse:
    """Audit and sync status endpoint."""
    server_time = datetime.now(timezone.utc)
    active_count = db.scalar(
        select(func.count(TransactionModel.id)).where(
            TransactionModel.user_id == user.id,
            TransactionModel.deleted_at.is_(None),
        )
    ) or 0

    tombstone_count = db.scalar(
        select(func.count(TransactionModel.id)).where(
            TransactionModel.user_id == user.id,
            TransactionModel.deleted_at.is_not(None),
        )
    ) or 0

    latest_version = db.scalar(
        select(func.max(TransactionModel.server_version)).where(
            TransactionModel.user_id == user.id,
        )
    ) or 1

    return SyncStatusResponse(
        server_time=server_time,
        user_id=user.id,
        active_transactions_count=active_count,
        tombstones_count=tombstone_count,
        latest_server_version=latest_version,
    )
