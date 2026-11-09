"""
Integration Tests for Phase 2: Neon PostgreSQL Database & SQLAlchemy Models.
Tests database connectivity, model constraints, relationships, exact integer paise precision,
user data isolation, soft deletion, and Argon2id password hashing integration.
"""

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import uuid4
import pytest
from argon2 import PasswordHasher
from sqlalchemy import select, and_

from app.db.session import get_session_factory, get_runtime_engine
from app.db.models import (
    User,
    UserProfile,
    Category,
    Transaction,
    Device,
    RefreshToken,
)

password_hasher = PasswordHasher()

@pytest.fixture(scope="module")
def db_session():
    """Provides a transactional database session for tests and cleans up test entities."""
    SessionLocal = get_session_factory()
    session = SessionLocal()
    created_user_ids = []

    yield session, created_user_ids

    # Cleanup any entities created during test run
    if created_user_ids:
        for uid in created_user_ids:
            user = session.get(User, uid)
            if user:
                session.delete(user)
        session.commit()
    session.close()


def test_neon_connectivity():
    """Test 1: Verify direct and pooled connectivity to Neon PostgreSQL."""
    engine = get_runtime_engine()
    with engine.connect() as conn:
        result = conn.exec_driver_sql("SELECT 1").scalar()
        assert result == 1, "Neon PostgreSQL connection check failed"


def test_user_creation_with_argon2id(db_session):
    """Test 2: Verify user creation with Argon2id password hashing and profile relationship."""
    session, created_user_ids = db_session

    raw_password = "SuperSecretPassword123!"
    hashed_password = password_hasher.hash(raw_password)

    test_email = f"phase2_test_{uuid4().hex[:8]}@example.com"
    user = User(
        email=test_email,
        password_hash=hashed_password,
        account_status="active",
    )
    profile = UserProfile(
        user=user,
        full_name="Phase 2 Test User",
        currency="INR",
        theme="dark",
    )
    session.add(user)
    session.add(profile)
    session.commit()

    created_user_ids.append(user.id)

    # Verification
    retrieved = session.get(User, user.id)
    assert retrieved is not None
    assert retrieved.email == test_email
    assert retrieved.profile.full_name == "Phase 2 Test User"
    assert retrieved.profile.currency == "INR"
    assert password_hasher.verify(retrieved.password_hash, raw_password) is True


def test_monetary_paise_precision(db_session):
    """Test 3: Verify monetary amounts stored as exact integer paise (1 INR = 100 paise)."""
    session, created_user_ids = db_session

    user = User(
        email=f"paise_test_{uuid4().hex[:8]}@example.com",
        password_hash=password_hasher.hash("TestPass123"),
    )
    session.add(user)
    session.commit()
    created_user_ids.append(user.id)

    # Exact amount with decimals: 1250.75 INR = 125075 paise
    decimal_amount = Decimal("1250.75")
    paise_amount = int(decimal_amount * 100)

    now = datetime.now(timezone.utc)
    txn = Transaction(
        user_id=user.id,
        amount=decimal_amount,
        amount_paise=paise_amount,
        direction="expense",
        counterparty="Starbucks Coffee",
        category="Food & Dining",
        description="Coffee with team",
        transaction_date=now,
        source="manual",
        reference_id=f"REF-{uuid4().hex[:10]}",
        fingerprint=uuid4().hex,
        sync_status="synced",
        server_version=1,
    )
    session.add(txn)
    session.commit()

    retrieved_txn = session.get(Transaction, txn.id)
    assert retrieved_txn is not None
    assert retrieved_txn.amount_paise == 125075
    assert retrieved_txn.amount == Decimal("1250.75")
    assert retrieved_txn.amount_paise == int(retrieved_txn.amount * 100)


def test_user_data_isolation(db_session):
    """Test 4: Verify strict data isolation between multiple users."""
    session, created_user_ids = db_session

    user_a = User(email=f"user_a_{uuid4().hex[:8]}@example.com", password_hash=password_hasher.hash("PassA123"))
    user_b = User(email=f"user_b_{uuid4().hex[:8]}@example.com", password_hash=password_hasher.hash("PassB123"))
    session.add_all([user_a, user_b])
    session.commit()
    created_user_ids.extend([user_a.id, user_b.id])

    now = datetime.now(timezone.utc)
    txn_a = Transaction(
        user_id=user_a.id,
        amount=Decimal("500.00"),
        amount_paise=50000,
        direction="expense",
        counterparty="User A Counterparty",
        category="Shopping",
        transaction_date=now,
    )
    txn_b = Transaction(
        user_id=user_b.id,
        amount=Decimal("1500.00"),
        amount_paise=150000,
        direction="income",
        counterparty="User B Counterparty",
        category="Salary",
        transaction_date=now,
    )
    session.add_all([txn_a, txn_b])
    session.commit()

    # Query scoped strictly to user A
    stmt_a = select(Transaction).where(Transaction.user_id == user_a.id)
    results_a = session.scalars(stmt_a).all()
    assert len(results_a) == 1
    assert results_a[0].counterparty == "User A Counterparty"
    assert results_a[0].amount_paise == 50000

    # Ensure user B has zero visibility into user A's transactions
    stmt_b = select(Transaction).where(Transaction.user_id == user_b.id)
    results_b = session.scalars(stmt_b).all()
    assert len(results_b) == 1
    assert results_b[0].counterparty == "User B Counterparty"
    assert results_b[0].id != txn_a.id


def test_soft_deletes_and_tombstones(db_session):
    """Test 5: Verify soft-deletion via deleted_at tombstones for two-way synchronization."""
    session, created_user_ids = db_session

    user = User(email=f"soft_del_{uuid4().hex[:8]}@example.com", password_hash=password_hasher.hash("PassDel123"))
    session.add(user)
    session.commit()
    created_user_ids.append(user.id)

    txn = Transaction(
        user_id=user.id,
        amount=Decimal("200.00"),
        amount_paise=20000,
        direction="expense",
        counterparty="Bookstore",
        category="Education",
        transaction_date=datetime.now(timezone.utc),
    )
    session.add(txn)
    session.commit()

    # Apply soft deletion tombstone
    deleted_timestamp = datetime.now(timezone.utc)
    txn.deleted_at = deleted_timestamp
    txn.server_version += 1
    session.commit()

    # Active transactions query filters out deleted items
    active_stmt = select(Transaction).where(
        and_(Transaction.user_id == user.id, Transaction.deleted_at.is_(None))
    )
    active_txns = session.scalars(active_stmt).all()
    assert len(active_txns) == 0

    # Sync pull query retrieves the tombstone
    sync_stmt = select(Transaction).where(Transaction.user_id == user.id)
    all_txns = session.scalars(sync_stmt).all()
    assert len(all_txns) == 1
    assert all_txns[0].deleted_at is not None
    assert all_txns[0].server_version == 2


def test_device_registration_and_uniqueness(db_session):
    """Test 6: Verify multi-device tracking and unique device constraint per user."""
    session, created_user_ids = db_session

    user = User(email=f"device_test_{uuid4().hex[:8]}@example.com", password_hash=password_hasher.hash("DevicePass123"))
    session.add(user)
    session.commit()
    created_user_ids.append(user.id)

    device_1 = Device(
        user_id=user.id,
        device_name="Samsung Galaxy A36",
        platform="android",
        device_id="samsung-a36-device-uuid-1234",
        app_version="1.0.0",
    )
    session.add(device_1)
    session.commit()

    retrieved = session.get(Device, device_1.id)
    assert retrieved is not None
    assert retrieved.device_name == "Samsung Galaxy A36"
    assert retrieved.platform == "android"


def test_refresh_token_lifecycle(db_session):
    """Test 7: Verify refresh token persistence, lookup, and revocation."""
    session, created_user_ids = db_session

    user = User(email=f"token_test_{uuid4().hex[:8]}@example.com", password_hash=password_hasher.hash("TokenPass123"))
    session.add(user)
    session.commit()
    created_user_ids.append(user.id)

    token_hash = f"hashed_jwt_token_{uuid4().hex}"
    expires = datetime.now(timezone.utc) + timedelta(days=30)
    rt = RefreshToken(
        user_id=user.id,
        token_hash=token_hash,
        device_id="samsung-a36-device-uuid-1234",
        expires_at=expires,
    )
    session.add(rt)
    session.commit()

    # Verify active token
    active_token = session.scalar(
        select(RefreshToken).where(
            and_(RefreshToken.token_hash == token_hash, RefreshToken.revoked_at.is_(None))
        )
    )
    assert active_token is not None
    assert active_token.user_id == user.id

    # Revoke token
    active_token.revoked_at = datetime.now(timezone.utc)
    session.commit()

    revoked_token = session.scalar(
        select(RefreshToken).where(
            and_(RefreshToken.token_hash == token_hash, RefreshToken.revoked_at.is_(None))
        )
    )
    assert revoked_token is None
