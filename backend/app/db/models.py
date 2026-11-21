"""
SQLAlchemy ORM Models for Velnora PostgreSQL Cloud Database.
Represents users, profiles, categories, transactions, devices, and refresh tokens.
Implements exact integer monetary precision (amount_paise), multi-device tracking,
and soft-deletion tombstones for reliable two-way sync.
"""

from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

from sqlalchemy import (
    JSON,
    BigInteger,
    Float,
    LargeBinary,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Sequence,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from .session import Base


def utcnow() -> datetime:
    """Return timezone-aware current UTC datetime."""
    return datetime.now(timezone.utc)


class User(Base):
    """Core user account entity."""
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    account_status = Column(String(32), default="active", nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    # Relationships
    profile = relationship("UserProfile", back_populates="user", uselist=False, cascade="all, delete-orphan")
    transactions = relationship("Transaction", back_populates="user", cascade="all, delete-orphan")
    categories = relationship("Category", back_populates="user", cascade="all, delete-orphan")
    devices = relationship("Device", back_populates="user", cascade="all, delete-orphan")
    refresh_tokens = relationship("RefreshToken", back_populates="user", cascade="all, delete-orphan")

    @property
    def full_name(self) -> str:
        return self.profile.full_name if self.profile else ""

    def __repr__(self) -> str:
        return f"<User id={self.id} email={self.email}>"


class UserProfile(Base):
    """User profile and financial preferences."""
    __tablename__ = "user_profiles"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False, index=True)
    full_name = Column(String(120), nullable=False)
    currency = Column(String(10), default="INR", nullable=False)
    theme = Column(String(20), default="system", nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    user = relationship("User", back_populates="profile")

    def __repr__(self) -> str:
        return f"<UserProfile user_id={self.user_id} name={self.full_name}>"


class Category(Base):
    """Transaction categories (both system defaults and custom user categories)."""
    __tablename__ = "categories"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    name = Column(String(80), nullable=False)
    icon = Column(String(50), default="tag", nullable=False)
    color = Column(String(20), default="#6366f1", nullable=False)
    direction = Column(String(20), nullable=False)  # income or expense
    is_system = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    # Relationships
    user = relationship("User", back_populates="categories")
    transactions = relationship("Transaction", back_populates="category_rel")

    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_categories_user_name"),
    )

    def __repr__(self) -> str:
        return f"<Category id={self.id} name={self.name} system={self.is_system}>"


class Transaction(Base):
    """
    Financial transactions with integer paise precision and sync metadata.
    amount_paise stores exact monetary value (1 INR = 100 paise) avoiding float errors.
    """
    __tablename__ = "transactions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id", ondelete="SET NULL"), nullable=True, index=True)
    
    # Monetary amounts: amount_paise is authoritative; amount is for decimal reporting
    amount = Column(Numeric(12, 2), nullable=False)
    amount_paise = Column(BigInteger, nullable=False)
    
    direction = Column(String(20), nullable=False)  # income or expense
    counterparty = Column(String(160), nullable=False)
    category = Column(String(80), nullable=False)
    description = Column(Text, default="", nullable=False)
    transaction_date = Column(DateTime(timezone=True), nullable=False, index=True)
    source = Column(String(32), default="manual", nullable=False)  # manual, sms, sync
    reference_id = Column(String(160), nullable=True, index=True)
    fingerprint = Column(String(64), nullable=True, index=True)
    sync_status = Column(String(32), default="synced", nullable=False)
    server_version = Column(Integer, default=1, nullable=False)
    sync_revision = Column(
        BigInteger,
        Sequence("sync_revision_seq"),
        nullable=False,
        server_default=text("nextval('sync_revision_seq')"),
        index=True,
    )
    deleted_at = Column(DateTime(timezone=True), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False, index=True)

    # Optional user-entered details (E.164 merchant phone, receipt reference, user-confirmed location)
    merchant_phone = Column(String(20), nullable=True)
    payment_method = Column(String(40), nullable=True)
    receipt_remote_id = Column(String(64), nullable=True)
    location_lat = Column(Float, nullable=True)
    location_lng = Column(Float, nullable=True)
    location_name = Column(String(200), nullable=True)
    location_address = Column(Text, nullable=True)
    location_confirmed = Column(Boolean, nullable=False, default=False, server_default=text("false"))

    # Unified ledger metadata. Only an account suffix is ever stored, never a full account number.
    txn_kind = Column(String(20), nullable=False, default="payment", server_default="payment")
    verification_status = Column(String(20), nullable=False, default="verified", server_default="verified")
    capture_source = Column(String(20), nullable=True)
    account_last4 = Column(String(4), nullable=True)
    bank_name = Column(String(60), nullable=True)
    payment_app = Column(String(40), nullable=True)
    possible_duplicate_of = Column(UUID(as_uuid=True), nullable=True)
    confidence = Column(Float, nullable=True)

    # Relationships
    user = relationship("User", back_populates="transactions")
    category_rel = relationship("Category", back_populates="transactions")

    __table_args__ = (
        Index("ix_transactions_user_date", "user_id", "transaction_date"),
        Index("ix_transactions_user_ref", "user_id", "reference_id"),
        Index("ix_transactions_user_fingerprint", "user_id", "fingerprint"),
        Index("ix_transactions_user_updated", "user_id", "updated_at"),
        Index("ix_transactions_user_revision", "user_id", "sync_revision"),
    )

    def __repr__(self) -> str:
        return f"<Transaction id={self.id} amount_paise={self.amount_paise} counterparty={self.counterparty}>"


class Device(Base):
    """User devices registered for multi-device sync and auditing."""
    __tablename__ = "devices"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    device_name = Column(String(120), nullable=False)
    platform = Column(String(32), default="android", nullable=False)
    device_id = Column(String(120), nullable=False)
    app_version = Column(String(32), nullable=False)
    last_active_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    user = relationship("User", back_populates="devices")

    __table_args__ = (
        UniqueConstraint("user_id", "device_id", name="uq_devices_user_device"),
    )

    def __repr__(self) -> str:
        return f"<Device id={self.id} device_id={self.device_id} user_id={self.user_id}>"


class RefreshToken(Base):
    """Hashed refresh tokens for JWT session rotation and revocation."""
    __tablename__ = "refresh_tokens"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash = Column(String(255), unique=True, nullable=False, index=True)
    device_id = Column(String(120), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=False, index=True)
    # Set ONLY by refresh rotation (see /api/v1/auth/refresh). Sign-out and account deletion delete the row instead, so a
    # row with revoked_at set always means "rotated", which is what the 60-second reuse grace relies on.
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)

    user = relationship("User", back_populates="refresh_tokens")

    def __repr__(self) -> str:
        return f"<RefreshToken id={self.id} user_id={self.user_id} revoked={bool(self.revoked_at)}>"


class MerchantAlias(Base):
    """User-specific merchant correction. Matching is by exact normalized key only."""
    __tablename__ = "merchant_aliases"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    match_key = Column(String(200), nullable=False)
    original_text = Column(String(200), nullable=False)
    display_name = Column(String(160), nullable=False)
    category = Column(String(80), nullable=True)
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)


class Budget(Base):
    """Monthly budget in integer paise. category NULL = overall monthly budget."""
    __tablename__ = "budgets"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    category = Column(String(80), nullable=True)
    amount_paise = Column(BigInteger, nullable=False)
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)


class Receipt(Base):
    """Receipt/food photo stored in the app's own database (no external storage service)."""
    __tablename__ = "receipts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    transaction_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    content_type = Column(String(40), nullable=False)
    size_bytes = Column(Integer, nullable=False)
    data = Column(LargeBinary, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)


class Attachment(Base):
    """
    Transaction attachment (photo or scanned document page). Many per transaction.
    The id is assigned by the client so a retried upload is idempotent (same id -> same row, never a duplicate).
    Bytes live in the app's own database (private; only served to the owner through authenticated requests).
    Deleting soft-deletes the row (tombstone) and clears the bytes.
    """
    __tablename__ = "transaction_attachments"

    id = Column(UUID(as_uuid=True), primary_key=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    # No FK to transactions, like receipts: ownership is checked on upload and rows stay owner-scoped.
    transaction_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    attachment_type = Column(String(20), nullable=False, default="photo")
    page_index = Column(Integer, nullable=False, default=0)
    content_type = Column(String(40), nullable=False)
    size_bytes = Column(Integer, nullable=False)
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    data = Column(LargeBinary, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_transaction_attachments_tx_user", "transaction_id", "user_id"),
    )

    def __repr__(self) -> str:
        return f"<Attachment id={self.id} transaction_id={self.transaction_id} type={self.attachment_type}>"


class ExpectedPayment(Base):
    """Money someone is expected to pay the user ('receive') or the user is expected to pay ('pay'), with partial payments."""
    __tablename__ = "expected_payments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    person = Column(String(80), nullable=False)
    direction = Column(String(8), nullable=False, default="receive")
    amount_paise = Column(BigInteger, nullable=False)
    paid_paise = Column(BigInteger, nullable=False, default=0)
    note = Column(String(200), nullable=True)
    due_date = Column(String(10), nullable=True)
    status = Column(String(12), nullable=False, default="pending")
    settled_at = Column(DateTime(timezone=True), nullable=True)
    payments = Column(JSON, nullable=False, default=list)
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
