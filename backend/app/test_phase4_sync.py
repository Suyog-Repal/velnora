"""
Phase 4 Backend Synchronization Integration Tests.
Verifies:
- POST /api/v1/sync/push
- GET /api/v1/sync/pull
- GET /api/v1/sync/status
Covers required scenarios:
A. Create transaction offline, reconnect, and upload.
B. Update a transaction offline, reconnect, and synchronize.
C. Delete a transaction offline and propagate its tombstone.
D. Submit the same operation multiple times without duplicates.
E. Interrupt synchronization and retry (partial batch failure handling).
F. Restart the app with pending operations.
G. Update the same transaction from two devices (conflict resolution).
H. Restore transactions on a second device.
I. User isolation: user cannot push or pull another user's transactions.
J. Preserve exact integer paise values in both directions.
"""

from datetime import datetime, timezone, timedelta
from decimal import Decimal
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from backend.app.main import app
from backend.app.db.session import get_session_factory
from backend.app.db.models import User, Transaction

client = TestClient(app)

created_test_users = []


@pytest.fixture(autouse=True)
def cleanup_phase4_test_users():
    """Tear down all created test users after tests to keep database clean."""
    yield
    SessionLocal = get_session_factory()
    try:
        with SessionLocal() as session:
            if created_test_users:
                users = session.scalars(select(User).where(User.id.in_(created_test_users))).all()
                for user in users:
                    session.delete(user)
                session.commit()
    except Exception:
        pass


def create_sync_user():
    email = f"sync_user_{uuid4().hex[:10]}@example.com"
    resp = client.post(
        "/api/v1/auth/register",
        json={"full_name": "Sync Test User", "email": email, "password": "SecurePassword123!", "terms_accepted": True},
    )
    assert resp.status_code == 201
    data = resp.json()
    created_test_users.append(data["user"]["id"])
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    return data, headers, email


def test_scenario_a_create_transaction_offline_and_push():
    """Scenario A: Create transaction offline, reconnect, and upload via push."""
    data, headers, _ = create_sync_user()
    tx_id = str(uuid4())
    op_id = str(uuid4())

    push_payload = {
        "device_id": "test-device-1",
        "items": [
            {
                "operation_id": op_id,
                "entity_type": "transaction",
                "entity_id": tx_id,
                "operation": "create",
                "client_version": 1,
                "payload": {
                    "amount": "1499.50",
                    "direction": "expense",
                    "counterparty": "Amazon India",
                    "category": "Shopping",
                    "description": "Noise-cancelling headphones",
                    "transaction_date": datetime.now(timezone.utc).isoformat(),
                    "reference_id": f"REF-{uuid4().hex[:8]}",
                    "source": "manual",
                },
            }
        ],
    }

    push_resp = client.post("/api/v1/sync/push", headers=headers, json=push_payload)
    assert push_resp.status_code == 200
    res_data = push_resp.json()
    assert len(res_data["results"]) == 1
    ack = res_data["results"][0]
    assert ack["operation_id"] == op_id
    assert ack["entity_id"] == tx_id
    assert ack["status"] == "synced"
    assert ack["server_version"] == 1

    # Verify transaction in database
    SessionLocal = get_session_factory()
    with SessionLocal() as session:
        db_tx = session.get(Transaction, tx_id)
        assert db_tx is not None
        assert db_tx.counterparty == "Amazon India"
        assert db_tx.amount == Decimal("1499.50")
        assert db_tx.amount_paise == 149950
        assert db_tx.server_version == 1
        assert db_tx.deleted_at is None


def test_scenario_b_update_transaction_offline_and_synchronize():
    """Scenario B: Update a transaction offline, reconnect, and synchronize."""
    data, headers, _ = create_sync_user()
    tx_id = str(uuid4())

    # Step 1: Initial upload
    client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx_id,
                    "operation": "create",
                    "client_version": 1,
                    "payload": {
                        "amount": "500.00",
                        "direction": "expense",
                        "counterparty": "Local Cafe",
                        "category": "Food & Dining",
                    },
                }
            ]
        },
    )

    # Step 2: Offline update
    op_id = str(uuid4())
    update_push = client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": op_id,
                    "entity_type": "transaction",
                    "entity_id": tx_id,
                    "operation": "update",
                    "client_version": 1,
                    "payload": {
                        "amount": "550.00",
                        "counterparty": "Local Cafe & Roastery",
                        "category": "Food & Dining",
                    },
                }
            ]
        },
    )
    assert update_push.status_code == 200
    ack = update_push.json()["results"][0]
    assert ack["status"] == "synced"
    assert ack["server_version"] == 2

    # Verify server database has updated values
    SessionLocal = get_session_factory()
    with SessionLocal() as session:
        db_tx = session.get(Transaction, tx_id)
        assert db_tx.amount == Decimal("550.00")
        assert db_tx.amount_paise == 55000
        assert db_tx.counterparty == "Local Cafe & Roastery"
        assert db_tx.server_version == 2


def test_scenario_c_delete_transaction_offline_propagate_tombstone():
    """Scenario C: Delete a transaction offline and propagate its tombstone."""
    data, headers, _ = create_sync_user()
    tx_id = str(uuid4())

    # Create
    client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx_id,
                    "operation": "create",
                    "client_version": 1,
                    "payload": {
                        "amount": "200.00",
                        "direction": "expense",
                        "counterparty": "Movie Ticket",
                        "category": "Entertainment",
                    },
                }
            ]
        },
    )

    # Offline delete
    del_push = client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx_id,
                    "operation": "delete",
                    "client_version": 1,
                    "payload": {"deleted_at": datetime.now(timezone.utc).isoformat()},
                }
            ]
        },
    )
    assert del_push.status_code == 200
    ack = del_push.json()["results"][0]
    assert ack["status"] == "synced"
    assert ack["server_version"] == 2

    # Verify tombstone in pull
    pull_resp = client.get("/api/v1/sync/pull?include_deleted=true", headers=headers)
    assert pull_resp.status_code == 200
    pulled = pull_resp.json()["transactions"]
    tombstone = next(t for t in pulled if t["id"] == tx_id)
    assert tombstone["deleted_at"] is not None
    assert tombstone["server_version"] == 2


def test_scenario_d_submit_same_operation_multiple_times_idempotency():
    """Scenario D: Submit the same operation multiple times without duplicates."""
    data, headers, _ = create_sync_user()
    tx_id = str(uuid4())
    ref_id = f"REF-{uuid4().hex[:8]}"

    payload = {
        "items": [
            {
                "operation_id": str(uuid4()),
                "entity_type": "transaction",
                "entity_id": tx_id,
                "operation": "create",
                "client_version": 1,
                "payload": {
                    "amount": "750.00",
                    "direction": "expense",
                    "counterparty": "Supermarket",
                    "category": "Groceries",
                    "reference_id": ref_id,
                },
            }
        ]
    }

    # Attempt 1
    resp1 = client.post("/api/v1/sync/push", headers=headers, json=payload)
    assert resp1.status_code == 200
    assert resp1.json()["results"][0]["status"] == "synced"

    # Attempt 2: identical submission
    resp2 = client.post("/api/v1/sync/push", headers=headers, json=payload)
    assert resp2.status_code == 200
    assert resp2.json()["results"][0]["status"] == "synced"

    # Attempt 3: new operation ID but same entity_id and reference_id
    payload["items"][0]["operation_id"] = str(uuid4())
    resp3 = client.post("/api/v1/sync/push", headers=headers, json=payload)
    assert resp3.status_code == 200
    assert resp3.json()["results"][0]["status"] == "synced"

    # Verify only ONE record exists on server
    SessionLocal = get_session_factory()
    with SessionLocal() as session:
        matching = session.scalars(select(Transaction).where(Transaction.reference_id == ref_id)).all()
        assert len(matching) == 1


def test_scenario_e_partial_batch_failures_and_retry():
    """Scenario E: Interrupt synchronization and retry with partial batch handling."""
    data, headers, _ = create_sync_user()
    valid_tx_id = str(uuid4())
    invalid_tx_id = str(uuid4())

    # Submit batch with 1 valid item and 1 invalid item (missing required amount)
    push_payload = {
        "items": [
            {
                "operation_id": "op-valid",
                "entity_type": "transaction",
                "entity_id": valid_tx_id,
                "operation": "create",
                "client_version": 1,
                "payload": {
                    "amount": "120.00",
                    "direction": "expense",
                    "counterparty": "Metro Pass",
                    "category": "Transportation",
                },
            },
            {
                "operation_id": "op-invalid",
                "entity_type": "transaction",
                "entity_id": invalid_tx_id,
                "operation": "create",
                "client_version": 1,
                "payload": {
                    # Missing amount!
                    "direction": "expense",
                    "counterparty": "Broken Item",
                    "category": "Shopping",
                },
            },
        ]
    }

    resp = client.post("/api/v1/sync/push", headers=headers, json=push_payload)
    assert resp.status_code == 200
    results = {r["operation_id"]: r for r in resp.json()["results"]}

    # Valid item succeeded atomically
    assert results["op-valid"]["status"] == "synced"
    assert results["op-valid"]["server_version"] == 1

    # Invalid item failed cleanly without crashing the batch
    assert results["op-invalid"]["status"] == "error"
    assert "Missing required fields" in results["op-invalid"]["error"]

    # Retry with corrected item
    retry_payload = {
        "items": [
            {
                "operation_id": "op-invalid-retry",
                "entity_type": "transaction",
                "entity_id": invalid_tx_id,
                "operation": "create",
                "client_version": 1,
                "payload": {
                    "amount": "350.00",
                    "direction": "expense",
                    "counterparty": "Corrected Item",
                    "category": "Shopping",
                },
            }
        ]
    }
    retry_resp = client.post("/api/v1/sync/push", headers=headers, json=retry_payload)
    assert retry_resp.status_code == 200
    assert retry_resp.json()["results"][0]["status"] == "synced"


def test_scenario_g_update_same_transaction_from_two_devices_conflict_resolution():
    """Scenario G: Update the same transaction from two devices (conflict resolution)."""
    data, headers, _ = create_sync_user()
    tx_id = str(uuid4())

    # Step 1: Device 1 creates transaction
    client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx_id,
                    "operation": "create",
                    "client_version": 1,
                    "payload": {
                        "amount": "1000.00",
                        "direction": "expense",
                        "counterparty": "Office Chair",
                        "category": "Equipment",
                    },
                }
            ]
        },
    )

    # Step 2: Device 2 updates transaction (advances server_version to 2)
    dev2_resp = client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx_id,
                    "operation": "update",
                    "client_version": 1,
                    "payload": {
                        "amount": "1200.00",
                        "counterparty": "Office Chair Premium",
                        "updated_at": "2026-11-02T10:00:00Z",
                    },
                }
            ]
        },
    )
    assert dev2_resp.json()["results"][0]["server_version"] == 2

    # Step 3: Device 1 tries to push update with client_version=1 (stale version)
    # Stale version MUST NOT overwrite server, even if client claims an inflated future timestamp (clock skew)
    inflated_future_time = (datetime.now(timezone.utc) + timedelta(days=365)).isoformat()
    dev1_stale_resp = client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx_id,
                    "operation": "update",
                    "client_version": 1,
                    "payload": {
                        "amount": "1100.00",
                        "counterparty": "Stale Attempt with Clock Skew",
                        "updated_at": inflated_future_time,
                    },
                }
            ]
        },
    )
    assert dev1_stale_resp.status_code == 200
    stale_ack = dev1_stale_resp.json()["results"][0]
    # Server recognizes conflict: stale client version cannot overwrite server data
    assert stale_ack["status"] == "conflict_resolved"
    assert stale_ack["server_version"] == 2
    assert "Server version is newer" in stale_ack["error"]

    # Verify server data was NOT overwritten
    SessionLocal = get_session_factory()
    with SessionLocal() as session:
        db_tx = session.get(Transaction, tx_id)
        assert db_tx.amount == Decimal("1200.00")
        assert db_tx.counterparty == "Office Chair Premium"

    # Step 4: Device 1 pulls or advances to client_version=2, then update succeeds
    dev1_valid_resp = client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx_id,
                    "operation": "update",
                    "client_version": 2,
                    "payload": {
                        "amount": "1250.00",
                        "counterparty": "Winning Edit with Current Version",
                    },
                }
            ]
        },
    )
    assert dev1_valid_resp.status_code == 200
    valid_ack = dev1_valid_resp.json()["results"][0]
    assert valid_ack["status"] == "synced"
    assert valid_ack["server_version"] == 3


def test_scenario_h_restore_transactions_on_second_device():
    """Scenario H: Restore transactions on a second device via initial pull."""
    data, headers, _ = create_sync_user()

    # Create 3 transactions on Device 1
    tx_ids = [str(uuid4()) for _ in range(3)]
    for i, tid in enumerate(tx_ids):
        client.post(
            "/api/v1/sync/push",
            headers=headers,
            json={
                "items": [
                    {
                        "operation_id": str(uuid4()),
                        "entity_type": "transaction",
                        "entity_id": tid,
                        "operation": "create",
                        "client_version": 1,
                        "payload": {
                            "amount": f"{(i+1)*100}.00",
                            "direction": "expense",
                            "counterparty": f"Store {i+1}",
                            "category": "Shopping",
                        },
                    }
                ]
            },
        )

    # Device 2 logs in and pulls all records (since_cursor=None or "0")
    pull_resp = client.get("/api/v1/sync/pull?since_cursor=0", headers=headers)
    assert pull_resp.status_code == 200
    pulled_data = pull_resp.json()
    assert len(pulled_data["transactions"]) == 3
    pulled_ids = {t["id"] for t in pulled_data["transactions"]}
    assert set(tx_ids).issubset(pulled_ids)
    assert pulled_data["total_active_count"] == 3


def test_scenario_i_user_isolation_cannot_sync_other_user_transactions():
    """Scenario I: Ensure User B cannot synchronize or access User A's transactions."""
    user_a, headers_a, _ = create_sync_user()
    user_b, headers_b, _ = create_sync_user()

    tx_a_id = str(uuid4())

    # User A creates transaction
    resp_a = client.post(
        "/api/v1/sync/push",
        headers=headers_a,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx_a_id,
                    "operation": "create",
                    "client_version": 1,
                    "payload": {
                        "amount": "999.00",
                        "direction": "expense",
                        "counterparty": "User A Private Store",
                        "category": "Personal",
                    },
                }
            ]
        },
    )
    assert resp_a.status_code == 200
    assert resp_a.json()["results"][0]["status"] == "synced"

    # User B attempts to push update to User A's transaction
    resp_b_push = client.post(
        "/api/v1/sync/push",
        headers=headers_b,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx_a_id,
                    "operation": "update",
                    "client_version": 1,
                    "payload": {"amount": "1.00"},
                }
            ]
        },
    )
    assert resp_b_push.status_code == 200
    b_result = resp_b_push.json()["results"][0]
    assert b_result["status"] == "error"
    assert "Forbidden" in b_result["error"]

    # User B pulls records: User A's transaction MUST NOT appear
    resp_b_pull = client.get("/api/v1/sync/pull", headers=headers_b)
    assert resp_b_pull.status_code == 200
    b_txs = resp_b_pull.json()["transactions"]
    assert all(t["id"] != tx_a_id for t in b_txs)


def test_scenario_j_preserve_exact_integer_paise_in_both_directions():
    """Scenario J: Preserve exact paise values through both push and pull directions."""
    data, headers, _ = create_sync_user()

    test_cases = [
        {"amount": "0.01", "expected_paise": 1},
        {"amount": "1499.50", "expected_paise": 149950},
        {"amount": "999999.99", "expected_paise": 99999999},
    ]

    for tc in test_cases:
        tx_id = str(uuid4())
        push_resp = client.post(
            "/api/v1/sync/push",
            headers=headers,
            json={
                "items": [
                    {
                        "operation_id": str(uuid4()),
                        "entity_type": "transaction",
                        "entity_id": tx_id,
                        "operation": "create",
                        "client_version": 1,
                        "payload": {
                            "amount": tc["amount"],
                            "direction": "expense",
                            "counterparty": "Precision Test",
                            "category": "Testing",
                        },
                    }
                ]
            },
        )
        assert push_resp.status_code == 200
        assert push_resp.json()["results"][0]["status"] == "synced"

        # Pull and verify exact precision
        pull_resp = client.get("/api/v1/sync/pull", headers=headers)
        assert pull_resp.status_code == 200
        matched = next(t for t in pull_resp.json()["transactions"] if t["id"] == tx_id)
        assert matched["amount"] == tc["amount"]
        assert matched["amount_paise"] == tc["expected_paise"]


def test_sync_status_endpoint_and_cursor_pagination():
    """Verify GET /api/v1/sync/status audit counters and incremental pagination cursor."""
    data, headers, _ = create_sync_user()

    # Create 5 transactions
    for i in range(5):
        client.post(
            "/api/v1/sync/push",
            headers=headers,
            json={
                "items": [
                    {
                        "operation_id": str(uuid4()),
                        "entity_type": "transaction",
                        "entity_id": str(uuid4()),
                        "operation": "create",
                        "client_version": 1,
                        "payload": {
                            "amount": f"{10 * (i + 1)}.00",
                            "direction": "expense",
                            "counterparty": f"Batch Item {i}",
                            "category": "General",
                        },
                    }
                ]
            },
        )

    # Status check
    status_resp = client.get("/api/v1/sync/status", headers=headers)
    assert status_resp.status_code == 200
    st = status_resp.json()
    assert st["active_transactions_count"] == 5
    assert st["tombstones_count"] == 0

    # Paginated pull: limit=2
    page1 = client.get("/api/v1/sync/pull?limit=2", headers=headers).json()
    assert len(page1["transactions"]) == 2
    assert page1["has_more"] is True
    assert page1["next_cursor"] is not None

    page2 = client.get("/api/v1/sync/pull", params={"limit": 2, "since_cursor": page1["next_cursor"]}, headers=headers).json()
    assert len(page2["transactions"]) == 2
    assert page2["has_more"] is True

    page3 = client.get("/api/v1/sync/pull", params={"limit": 2, "since_cursor": page2["next_cursor"]}, headers=headers).json()
    assert len(page3["transactions"]) == 1
    assert page3["has_more"] is False


def test_category_synchronization_and_referential_integrity():
    """Verify custom category sync, second-device category hydration, and ON DELETE SET NULL preservation."""
    data, headers, _ = create_sync_user()
    cat_id = str(uuid4())
    tx_id = str(uuid4())

    # Step 1: Push custom category
    cat_push = client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "category",
                    "entity_id": cat_id,
                    "operation": "create",
                    "client_version": 1,
                    "payload": {
                        "category": "Gym & Fitness",
                        "direction": "expense",
                        "icon": "Dumbbell",
                        "color": "#10b981",
                    },
                }
            ]
        },
    )
    assert cat_push.status_code == 200
    assert cat_push.json()["results"][0]["status"] == "synced"

    # Step 2: Push transaction referencing category_id
    tx_push = client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx_id,
                    "operation": "create",
                    "client_version": 1,
                    "payload": {
                        "amount": "2500.00",
                        "direction": "expense",
                        "counterparty": "Gold's Gym",
                        "category": "Gym & Fitness",
                        "category_id": cat_id,
                    },
                }
            ]
        },
    )
    assert tx_push.status_code == 200
    assert tx_push.json()["results"][0]["status"] == "synced"

    # Step 3: Pull on second device: verify custom category is hydrated and matches category_id
    pull_resp = client.get("/api/v1/sync/pull?since_cursor=0", headers=headers)
    assert pull_resp.status_code == 200
    pull_data = pull_resp.json()
    assert "categories" in pull_data
    pulled_cats = {c["id"]: c for c in pull_data["categories"]}
    assert cat_id in pulled_cats
    assert pulled_cats[cat_id]["name"] == "Gym & Fitness"

    pulled_tx = next(t for t in pull_data["transactions"] if t["id"] == tx_id)
    assert pulled_tx["category_id"] == cat_id
    assert pulled_tx["category"] == "Gym & Fitness"

    # Step 4: Delete category via sync push
    del_cat_push = client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "category",
                    "entity_id": cat_id,
                    "operation": "delete",
                    "client_version": 1,
                    "payload": {},
                }
            ]
        },
    )
    assert del_cat_push.status_code == 200
    assert del_cat_push.json()["results"][0]["status"] == "synced"

    # Step 5: Verify transaction was NOT deleted and retained category name (ON DELETE SET NULL)
    SessionLocal = get_session_factory()
    with SessionLocal() as session:
        db_tx = session.get(Transaction, tx_id)
        assert db_tx is not None
        assert db_tx.category_id is None
        assert db_tx.category == "Gym & Fitness"


def test_sync_error_handling_401_and_422():
    """Verify HTTP 401 unauthorized rejection and HTTP 422 decimal precision rejection."""
    # 401 Unauthorized with invalid token
    bad_headers = {"Authorization": "Bearer invalid.expired.token"}
    resp_401 = client.post("/api/v1/sync/push", headers=bad_headers, json={"items": []})
    assert resp_401.status_code == 401

    # 422 Unprocessable Entity with invalid decimal precision (e.g. 10.1234)
    data, headers, _ = create_sync_user()
    resp_422 = client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": str(uuid4()),
                    "operation": "create",
                    "client_version": 1,
                    "payload": {
                        "amount": "10.1234",  # Invalid 4 fractional places
                        "direction": "expense",
                        "counterparty": "Invalid Precision",
                        "category": "Testing",
                    },
                }
            ]
        },
    )
    assert resp_422.status_code == 422


def test_category_completeness_flag_and_exclusion_of_deleted():
    """Verify categories_complete flag and confirm deleted categories are excluded from pull."""
    data, headers, _ = create_sync_user()
    cat_id = str(uuid4())

    # Create custom category
    create_resp = client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "category",
                    "entity_id": cat_id,
                    "operation": "create",
                    "client_version": 1,
                    "payload": {
                        "name": "Consulting Services",
                        "direction": "income",
                        "icon": "Briefcase",
                        "color": "#10b981",
                    },
                }
            ]
        },
    )
    assert create_resp.status_code == 200

    # Initial pull: categories_complete MUST be True and include custom category
    pull1 = client.get("/api/v1/sync/pull", headers=headers).json()
    assert pull1["categories_complete"] is True
    cat_ids = [c["id"] for c in pull1["categories"]]
    assert cat_id in cat_ids

    # Delete custom category
    del_resp = client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "category",
                    "entity_id": cat_id,
                    "operation": "delete",
                    "client_version": 1,
                    "payload": {},
                }
            ]
        },
    )
    assert del_resp.status_code == 200
    assert del_resp.json()["results"][0]["status"] == "synced"

    # Subsequent pull: categories_complete MUST be True and deleted category MUST be excluded
    pull2 = client.get("/api/v1/sync/pull", headers=headers).json()
    assert pull2["categories_complete"] is True
    cat_ids_after = [c["id"] for c in pull2["categories"]]
    assert cat_id not in cat_ids_after


def test_monotonic_sync_revision_cursor_and_concurrent_consistency():
    """
    Verify monotonically increasing sync_revision sequence cursors.
    Demonstrates that late-committed updates advance sync_revision and are discovered
    by subsequent incremental pulls without relying on clock skew lookbacks.
    """
    data, headers, _ = create_sync_user()
    tx1_id = str(uuid4())
    tx2_id = str(uuid4())
    tx3_id = str(uuid4())

    # Create Tx 1 and Tx 2
    push_1 = client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx1_id,
                    "operation": "create",
                    "client_version": 1,
                    "payload": {
                        "amount": "100.00",
                        "direction": "expense",
                        "counterparty": "Vendor A",
                        "category": "General",
                    },
                },
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx2_id,
                    "operation": "create",
                    "client_version": 1,
                    "payload": {
                        "amount": "200.00",
                        "direction": "expense",
                        "counterparty": "Vendor B",
                        "category": "General",
                    },
                },
            ]
        },
    )
    assert push_1.status_code == 200

    # Create Tx 3 in separate request
    push_2 = client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx3_id,
                    "operation": "create",
                    "client_version": 1,
                    "payload": {
                        "amount": "300.00",
                        "direction": "expense",
                        "counterparty": "Vendor C",
                        "category": "General",
                    },
                }
            ]
        },
    )
    assert push_2.status_code == 200

    # Pull initial transactions
    pull_all = client.get("/api/v1/sync/pull", headers=headers).json()
    txns = pull_all["transactions"]
    assert len(txns) == 3

    # Verify strict monotonicity of sync_revision
    revs = [t["sync_revision"] for t in txns]
    assert revs[0] < revs[1] < revs[2]

    # Incremental pull using integer revision cursor
    cursor_rev = str(revs[1])
    pull_incremental = client.get(
        "/api/v1/sync/pull",
        params={"since_cursor": cursor_rev},
        headers=headers,
    ).json()
    assert len(pull_incremental["transactions"]) == 1
    assert pull_incremental["transactions"][0]["id"] == tx3_id

    # Simulate an update on earlier Tx 1
    update_push = client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx1_id,
                    "operation": "update",
                    "client_version": 1,
                    "payload": {
                        "amount": "999.00",
                    },
                }
            ]
        },
    )
    assert update_push.status_code == 200
    assert update_push.json()["results"][0]["status"] == "synced"

    # Subsequent pull starting from cursor_rev (which previously saw Tx 3)
    # MUST now discover Tx 1's update because its sync_revision advanced beyond revs[2]!
    pull_after_update = client.get(
        "/api/v1/sync/pull",
        params={"since_cursor": str(revs[2])},
        headers=headers,
    ).json()
    assert len(pull_after_update["transactions"]) == 1
    updated_tx = pull_after_update["transactions"][0]
    assert updated_tx["id"] == tx1_id
    assert Decimal(str(updated_tx["amount"])) == Decimal("999.00")
    assert updated_tx["sync_revision"] > revs[2]


def test_real_neon_concurrency_lock_and_isolation():
    """
    Real concurrency integration test against live Neon PostgreSQL.
    Verifies:
    1. Transaction A acquires the user row lock and delays its commit.
    2. Transaction B for the same user is blocked from allocating/committing revision until A commits.
    3. Transaction C for a different user does NOT block and commits immediately while A is sleeping.
    4. Revisions allocate in strictly increasing order (rev_b > rev_a).
    5. An incremental pull after both commit discovers both changes without omission.
    """
    import threading
    import time
    from sqlalchemy import text

    SessionLocal = get_session_factory()

    data_a, headers_a, _ = create_sync_user()
    data_b, headers_b, _ = create_sync_user()

    from uuid import UUID
    user_a_id = UUID(data_a["user"]["id"])
    user_b_id = UUID(data_b["user"]["id"])

    tx1_id = str(uuid4())
    tx2_id = str(uuid4())
    tx3_id = str(uuid4())

    # Seed User A with two transactions
    resp_init = client.post(
        "/api/v1/sync/push",
        headers=headers_a,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx1_id,
                    "operation": "create",
                    "client_version": 1,
                    "payload": {
                        "amount": "10.00",
                        "direction": "expense",
                        "counterparty": "Seed 1",
                        "category": "General",
                    },
                },
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx2_id,
                    "operation": "create",
                    "client_version": 1,
                    "payload": {
                        "amount": "20.00",
                        "direction": "expense",
                        "counterparty": "Seed 2",
                        "category": "General",
                    },
                },
            ]
        },
    )
    assert resp_init.status_code == 200

    # Seed User B with one transaction
    resp_init_b = client.post(
        "/api/v1/sync/push",
        headers=headers_b,
        json={
            "items": [
                {
                    "operation_id": str(uuid4()),
                    "entity_type": "transaction",
                    "entity_id": tx3_id,
                    "operation": "create",
                    "client_version": 1,
                    "payload": {
                        "amount": "30.00",
                        "direction": "income",
                        "counterparty": "User B Seed",
                        "category": "Salary",
                    },
                }
            ]
        },
    )
    assert resp_init_b.status_code == 200

    # Get initial cursor for User A (before concurrent updates)
    pull_init = client.get("/api/v1/sync/pull", headers=headers_a).json()
    initial_cursor_a = pull_init["next_cursor"]

    # Thread coordination primitives
    lock_a_acquired = threading.Event()
    results = {}

    def worker_a():
        with SessionLocal() as s_a:
            # Step 1: Acquire user lock for User A
            s_a.execute(select(User.id).where(User.id == user_a_id).with_for_update())
            lock_a_acquired.set()

            # Mutate tx1
            tx1 = s_a.get(Transaction, tx1_id)
            tx1.amount = Decimal("111.00")
            tx1.amount_paise = 11100
            tx1.server_version += 1
            tx1.sync_revision = s_a.scalar(text("SELECT nextval('sync_revision_seq')"))
            tx1.updated_at = datetime.now(timezone.utc)

            # Hold lock and delay commit by 2.5 seconds
            time.sleep(2.5)
            results["time_a_before_commit"] = time.time()
            s_a.commit()
            results["time_a_committed"] = time.time()
            results["rev_a"] = tx1.sync_revision

    def worker_b():
        # Ensure Worker A has acquired lock first
        lock_a_acquired.wait(timeout=5.0)
        with SessionLocal() as s_b:
            results["time_b_attempt_start"] = time.time()
            # This MUST block in PostgreSQL until Worker A commits!
            s_b.execute(select(User.id).where(User.id == user_a_id).with_for_update())
            results["time_b_unblocked"] = time.time()

            # Mutate tx2
            tx2 = s_b.get(Transaction, tx2_id)
            tx2.amount = Decimal("222.00")
            tx2.amount_paise = 22200
            tx2.server_version += 1
            tx2.sync_revision = s_b.scalar(text("SELECT nextval('sync_revision_seq')"))
            tx2.updated_at = datetime.now(timezone.utc)

            s_b.commit()
            results["time_b_committed"] = time.time()
            results["rev_b"] = tx2.sync_revision

    def worker_c():
        # Worker C operates concurrently for User B
        lock_a_acquired.wait(timeout=5.0)
        with SessionLocal() as s_c:
            results["time_c_attempt_start"] = time.time()
            # Acquires lock on User B - MUST NOT be blocked by User A!
            s_c.execute(select(User.id).where(User.id == user_b_id).with_for_update())
            tx3 = s_c.get(Transaction, tx3_id)
            tx3.amount = Decimal("333.00")
            tx3.amount_paise = 33300
            tx3.server_version += 1
            tx3.sync_revision = s_c.scalar(text("SELECT nextval('sync_revision_seq')"))
            tx3.updated_at = datetime.now(timezone.utc)

            s_c.commit()
            results["time_c_committed"] = time.time()
            results["rev_c"] = tx3.sync_revision

    t_a = threading.Thread(target=worker_a)
    t_b = threading.Thread(target=worker_b)
    t_c = threading.Thread(target=worker_c)

    t_a.start()
    t_b.start()
    t_c.start()

    t_a.join(timeout=10.0)
    t_b.join(timeout=10.0)
    t_c.join(timeout=10.0)

    # 1. Verify User C (different user) was NOT blocked by User A
    assert results["time_c_committed"] < results["time_a_before_commit"], (
        "User C (different user) must not be blocked by User A's row lock"
    )

    # 2. Verify Worker B was blocked by Worker A until Worker A committed
    assert results["time_b_unblocked"] >= results["time_a_before_commit"], (
        "Worker B must remain blocked until Worker A commits"
    )
    assert results["time_b_committed"] > results["time_a_committed"]

    # 3. Verify monotonic sequence allocation: Revision B must be strictly greater than Revision A
    assert results["rev_b"] > results["rev_a"], (
        f"Revision B ({results['rev_b']}) must be strictly greater than Revision A ({results['rev_a']})"
    )

    # 4. Verify incremental pull for User A from previous cursor discovers BOTH updates
    pull_final_a = client.get(
        "/api/v1/sync/pull",
        params={"since_cursor": initial_cursor_a},
        headers=headers_a,
    ).json()

    pulled_txns = pull_final_a["transactions"]
    assert len(pulled_txns) == 2, f"Expected 2 updated transactions, got {len(pulled_txns)}"
    pulled_map = {t["id"]: t for t in pulled_txns}

    assert tx1_id in pulled_map
    assert Decimal(str(pulled_map[tx1_id]["amount"])) == Decimal("111.00")
    assert pulled_map[tx1_id]["amount_paise"] == 11100

    assert tx2_id in pulled_map
    assert Decimal(str(pulled_map[tx2_id]["amount"])) == Decimal("222.00")
    assert pulled_map[tx2_id]["amount_paise"] == 22200

    # 5. Verify User B's update is intact and isolated
    pull_b = client.get("/api/v1/sync/pull", headers=headers_b).json()
    assert len(pull_b["transactions"]) == 1
    assert pull_b["transactions"][0]["id"] == tx3_id
    assert Decimal(str(pull_b["transactions"][0]["amount"])) == Decimal("333.00")



