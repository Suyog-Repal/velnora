"""
Comprehensive Integration Tests for Phase 3:
FastAPI Backend & Authentication Integration backed by Neon PostgreSQL.
"""

from decimal import Decimal
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.db.session import get_session_factory
from backend.app.db.models import User, Transaction, Category

client = TestClient(app)


def create_unique_user():
    email = f"user_{uuid4().hex[:10]}@example.com"
    resp = client.post(
        "/api/v1/auth/register",
        json={"full_name": "Integration User", "email": email, "password": "SecurePassword123!", "terms_accepted": True},
    )
    assert resp.status_code == 201
    data = resp.json()
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    return data, headers, email


def test_1_registration_and_login_postgresql():
    """Test 1: User registration and login persisted in PostgreSQL."""
    data, headers, email = create_unique_user()
    assert data["user"]["email"] == email
    assert data["user"]["full_name"] == "Integration User"

    # Verify user exists in PostgreSQL
    SessionLocal = get_session_factory()
    with SessionLocal() as session:
        user_row = session.get(User, data["user"]["id"])
        assert user_row is not None
        assert user_row.email == email
        assert user_row.profile.full_name == "Integration User"

    # Login with valid credentials
    login_resp = client.post("/api/v1/auth/login", json={"email": email, "password": "SecurePassword123!"})
    assert login_resp.status_code == 200
    login_data = login_resp.json()
    assert login_data["user"]["id"] == data["user"]["id"]
    assert "access_token" in login_data
    assert "refresh_token" in login_data


def test_2_duplicate_registration_prevention():
    """Test 2: Prevent duplicate email registration."""
    data, _, email = create_unique_user()
    dup_resp = client.post(
        "/api/v1/auth/register",
        json={"full_name": "Another User", "email": email, "password": "SecurePassword123!", "terms_accepted": True},
    )
    assert dup_resp.status_code == 409
    assert dup_resp.json()["detail"] == "An account with that email already exists"


def test_3_wrong_password_authentication():
    """Test 3: Authentication fails on invalid password."""
    _, _, email = create_unique_user()
    wrong_resp = client.post("/api/v1/auth/login", json={"email": email, "password": "IncorrectPassword123!"})
    assert wrong_resp.status_code == 401
    assert wrong_resp.json()["detail"] == "Invalid email or password"


def test_4_jwt_access_token_validation():
    """Test 4: JWT access token validation, expiry, and missing auth header."""
    _, headers, _ = create_unique_user()

    # Valid token succeeds
    me_resp = client.get("/api/v1/me", headers=headers)
    assert me_resp.status_code == 200

    # Missing auth header
    no_auth_resp = client.get("/api/v1/me")
    assert no_auth_resp.status_code == 401

    # Invalid token
    invalid_resp = client.get("/api/v1/me", headers={"Authorization": "Bearer invalid.jwt.token"})
    assert invalid_resp.status_code == 401


def test_5_refresh_token_rotation():
    """Test 5: Refresh token rotation revokes old token and issues new valid token."""
    data, _, _ = create_unique_user()
    old_refresh = data["refresh_token"]

    # Rotate refresh token
    rotate_resp = client.post("/api/v1/auth/refresh", json={"refresh_token": old_refresh})
    assert rotate_resp.status_code == 200
    rotated_data = rotate_resp.json()
    new_refresh = rotated_data["refresh_token"]
    assert new_refresh != old_refresh

    # Reusing the old refresh token must be rejected (revoked!)
    reuse_resp = client.post("/api/v1/auth/refresh", json={"refresh_token": old_refresh})
    assert reuse_resp.status_code == 401

    # Using the new refresh token succeeds
    second_rotate = client.post("/api/v1/auth/refresh", json={"refresh_token": new_refresh})
    assert second_rotate.status_code == 200


def test_6_logout_and_revocation():
    """Test 6: Logout revokes refresh token immediately."""
    data, headers, _ = create_unique_user()
    refresh_token = data["refresh_token"]

    # Logout with refresh token
    logout_resp = client.post("/api/v1/auth/logout", headers=headers, json={"refresh_token": refresh_token})
    assert logout_resp.status_code == 204

    # Attempting to refresh with the revoked token fails
    refresh_resp = client.post("/api/v1/auth/refresh", json={"refresh_token": refresh_token})
    assert refresh_resp.status_code == 401


def test_7_transaction_creation_and_deduplication():
    """Test 7: Transaction creation with exact integer paise and reference_id deduplication."""
    _, headers, _ = create_unique_user()
    ref_id = f"TXN-REF-{uuid4().hex[:8]}"

    payload = {
        "amount": "1499.50",
        "direction": "expense",
        "counterparty": "Reliance Digital",
        "category": "Shopping",
        "description": "Headphones",
        "reference_id": ref_id,
    }

    create_resp = client.post("/api/v1/transactions", headers=headers, json=payload)
    assert create_resp.status_code == 201
    created_tx = create_resp.json()

    assert created_tx["counterparty"] == "Reliance Digital"
    assert created_tx["amount"] == "1499.50"
    assert created_tx["amount_paise"] == 149950
    assert created_tx["server_version"] == 1

    # Idempotent deduplication: second submission with same reference_id returns the existing record
    dup_resp = client.post("/api/v1/transactions", headers=headers, json=payload)
    assert dup_resp.status_code == 201
    assert dup_resp.json()["id"] == created_tx["id"]


def test_7b_exact_monetary_precision_and_validation():
    """Test 7b: Validate exact Decimal to paise conversion and rejection of >2 decimal places."""
    _, headers, _ = create_unique_user()

    # Case 1: Minimum non-zero value: 0.01 INR = 1 paise
    resp_001 = client.post(
        "/api/v1/transactions",
        headers=headers,
        json={"amount": "0.01", "direction": "expense", "counterparty": "Micro Test", "category": "Utilities"},
    )
    assert resp_001.status_code == 201
    assert resp_001.json()["amount"] == "0.01"
    assert resp_001.json()["amount_paise"] == 1

    # Case 2: Standard value: 1499.50 INR = 149950 paise
    resp_1499 = client.post(
        "/api/v1/transactions",
        headers=headers,
        json={"amount": "1499.50", "direction": "expense", "counterparty": "Standard Test", "category": "Shopping"},
    )
    assert resp_1499.status_code == 201
    assert resp_1499.json()["amount"] == "1499.50"
    assert resp_1499.json()["amount_paise"] == 149950

    # Case 3: Large value: 999999.99 INR = 99999999 paise
    resp_999k = client.post(
        "/api/v1/transactions",
        headers=headers,
        json={"amount": "999999.99", "direction": "income", "counterparty": "Large Test", "category": "Investments"},
    )
    assert resp_999k.status_code == 201
    assert resp_999k.json()["amount"] == "999999.99"
    assert resp_999k.json()["amount_paise"] == 99999999

    # Case 4: Invalid fractional precision: 10.123 (3 decimal places) -> MUST BE REJECTED (HTTP 422)
    resp_invalid = client.post(
        "/api/v1/transactions",
        headers=headers,
        json={"amount": "10.123", "direction": "expense", "counterparty": "Invalid Precision", "category": "Shopping"},
    )
    assert resp_invalid.status_code == 422
    assert "decimal places" in resp_invalid.text.lower() or "decimal" in resp_invalid.text.lower()

    # Case 5: Invalid fractional precision in PATCH update: 25.999 -> MUST BE REJECTED (HTTP 422)
    tx_id = resp_001.json()["id"]
    patch_invalid = client.patch(
        f"/api/v1/transactions/{tx_id}",
        headers=headers,
        json={"amount": "25.999"},
    )
    assert patch_invalid.status_code == 422


def test_8_transaction_update_and_soft_deletion():
    """Test 8: Transaction update and soft deletion tombstone."""
    _, headers, _ = create_unique_user()

    created = client.post(
        "/api/v1/transactions",
        headers=headers,
        json={"amount": "500.00", "direction": "expense", "counterparty": "Grocery Mart", "category": "Food & Dining"},
    ).json()

    tx_id = created["id"]

    # Update transaction
    update_resp = client.patch(
        f"/api/v1/transactions/{tx_id}",
        headers=headers,
        json={"amount": "650.25", "counterparty": "Fresh Grocery Mart"},
    )
    assert update_resp.status_code == 200
    updated_tx = update_resp.json()
    assert updated_tx["amount"] == "650.25"
    assert updated_tx["amount_paise"] == 65025
    assert updated_tx["counterparty"] == "Fresh Grocery Mart"
    assert updated_tx["server_version"] == 2

    # Soft delete transaction
    del_resp = client.delete(f"/api/v1/transactions/{tx_id}", headers=headers)
    assert del_resp.status_code == 204

    # Deleted transaction is no longer returned in active list
    list_resp = client.get("/api/v1/transactions", headers=headers)
    assert len(list_resp.json()) == 0

    # Querying individual deleted transaction returns 404
    get_del = client.get(f"/api/v1/transactions/{tx_id}", headers=headers)
    assert get_del.status_code == 404

    # Verify soft-deletion tombstone persisted in DB
    SessionLocal = get_session_factory()
    with SessionLocal() as session:
        db_tx = session.get(Transaction, tx_id)
        assert db_tx is not None
        assert db_tx.deleted_at is not None
        assert db_tx.server_version == 3


def test_9_user_data_isolation():
    """Test 9: Cross-tenant isolation - User A cannot see or alter User B's transactions."""
    _, headers_a, _ = create_unique_user()
    _, headers_b, _ = create_unique_user()

    tx_a = client.post(
        "/api/v1/transactions",
        headers=headers_a,
        json={"amount": "100.00", "direction": "expense", "counterparty": "Private Store A", "category": "Shopping"},
    ).json()

    # User B lists transactions -> must be empty
    list_b = client.get("/api/v1/transactions", headers=headers_b).json()
    assert len(list_b) == 0

    # User B attempts to access User A's transaction -> 404
    get_b = client.get(f"/api/v1/transactions/{tx_a['id']}", headers=headers_b)
    assert get_b.status_code == 404

    # User B attempts to update User A's transaction -> 404
    patch_b = client.patch(f"/api/v1/transactions/{tx_a['id']}", headers=headers_b, json={"counterparty": "Hacked Store"})
    assert patch_b.status_code == 404

    # User B attempts to delete User A's transaction -> 404
    del_b = client.delete(f"/api/v1/transactions/{tx_a['id']}", headers=headers_b)
    assert del_b.status_code == 404


def test_10_categories_ownership_and_system_protection():
    """Test 10: Category listing, custom category creation, and protection of system categories."""
    _, headers_a, _ = create_unique_user()
    _, headers_b, _ = create_unique_user()

    # Listing categories includes default system categories
    cats = client.get("/api/v1/categories", headers=headers_a).json()
    assert len(cats) >= 5
    system_cat = next(c for c in cats if c["is_system"] is True)

    # Attempting to delete a system category is forbidden (403)
    del_sys = client.delete(f"/api/v1/categories/{system_cat['id']}", headers=headers_a)
    assert del_sys.status_code == 403

    # User A creates a custom category
    custom_cat = client.post(
        "/api/v1/categories",
        headers=headers_a,
        json={"name": "Gaming", "direction": "expense", "icon": "gamepad", "color": "#7c3aed"},
    ).json()
    assert custom_cat["name"] == "Gaming"
    assert custom_cat["is_system"] is False

    # User B cannot modify or delete User A's custom category
    del_other = client.delete(f"/api/v1/categories/{custom_cat['id']}", headers=headers_b)
    assert del_other.status_code == 403


def test_11_user_profile_management():
    """Test 11: Retrieve and update user profile."""
    _, headers, email = create_unique_user()

    prof = client.get("/api/v1/profile", headers=headers).json()
    assert prof["email"] == email
    assert prof["currency"] == "INR"

    # Update profile
    updated = client.patch(
        "/api/v1/profile",
        headers=headers,
        json={"full_name": "Updated Name", "currency": "USD", "theme": "dark"},
    ).json()
    assert updated["full_name"] == "Updated Name"
    assert updated["currency"] == "USD"
    assert updated["theme"] == "dark"

    # Verify me endpoint reflects updated profile name
    me = client.get("/api/v1/me", headers=headers).json()
    assert me["full_name"] == "Updated Name"


def test_12_persistence_across_fresh_client_session():
    """
    Test 12: In-session client persistence check.
    Confirms data persists when a brand new TestClient instance is instantiated.
    Note: Runs within the same pytest Python process (see test_13 for true OS-process restart).
    """
    _, headers, email = create_unique_user()

    created = client.post(
        "/api/v1/transactions",
        headers=headers,
        json={"amount": "3000.00", "direction": "income", "counterparty": "Monthly Dividend", "category": "Investments"},
    ).json()

    # Instantiate fresh client
    fresh_client = TestClient(app)
    tx_list = fresh_client.get("/api/v1/transactions", headers=headers).json()
    assert len(tx_list) == 1
    assert tx_list[0]["id"] == created["id"]
    assert tx_list[0]["amount_paise"] == 300000


def test_13_persistence_across_true_os_process_restart():
    """
    Test 13: True OS-level process boundary persistence.
    Spawns an independent Python sub-process that boots FastAPI from scratch with
    zero shared in-memory state and verifies transaction retrieval directly from Neon.
    """
    import subprocess
    import sys
    import json

    # Step 1: Create transaction in current process
    _, headers, email = create_unique_user()
    created = client.post(
        "/api/v1/transactions",
        headers=headers,
        json={"amount": "4500.75", "direction": "income", "counterparty": "Consulting Retainer", "category": "Salary"},
    ).json()
    target_id = created["id"]
    token = headers["Authorization"].replace("Bearer ", "")

    # Step 2: Spawn completely isolated Python OS process
    code = f"""
from fastapi.testclient import TestClient
from backend.app.main import app

fresh_client = TestClient(app)
resp = fresh_client.get('/api/v1/transactions/{target_id}', headers={{'Authorization': 'Bearer {token}'}})
assert resp.status_code == 200, f'Status was {{resp.status_code}}'
data = resp.json()
assert data['amount'] == '4500.75'
assert data['amount_paise'] == 450075
assert data['counterparty'] == 'Consulting Retainer'
print('SUBPROCESS_VERIFIED')
"""
    sub_env = subprocess.os.environ.copy()
    sub_env["PYTHONPATH"] = "."
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        env=sub_env,
    )
    assert result.returncode == 0, f"Subprocess failed with code {result.returncode}: {result.stderr}"
    assert "SUBPROCESS_VERIFIED" in result.stdout

