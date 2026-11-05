"""Merchant phone / location / receipt / budget / merchant-alias sync, validation and user isolation."""

from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from backend.app.main import app
from backend.app.db.session import get_session_factory
from backend.app.db.models import User

client = TestClient(app)
created = []

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


@pytest.fixture(autouse=True)
def cleanup():
    yield
    with get_session_factory()() as s:
        for u in s.scalars(select(User).where(User.id.in_(created))).all():
            s.delete(u)
        s.commit()


def user():
    email = f"grp_{uuid4().hex[:10]}@example.com"
    r = client.post("/api/v1/auth/register", json={"full_name": "G", "email": email, "password": "SecurePassword123!", "terms_accepted": True})
    assert r.status_code == 201
    d = r.json()
    created.append(d["user"]["id"])
    return {"Authorization": f"Bearer {d['access_token']}"}


def push(h, entity_type, entity_id, operation, payload, version=1):
    r = client.post("/api/v1/sync/push", headers=h, json={"items": [{
        "operation_id": str(uuid4()), "entity_type": entity_type, "entity_id": entity_id,
        "operation": operation, "client_version": version, "payload": payload}]})
    return r


def tx_payload(**extra):
    base = {"amount": "10.00", "direction": "expense", "counterparty": "Cafe", "category": "Food & Dining"}
    base.update(extra)
    return base


def pull(h):
    r = client.get("/api/v1/sync/pull", headers=h)
    assert r.status_code == 200
    return r.json()


def test_optional_phone_and_details_roundtrip_edit_clear():
    h = user()
    tid = str(uuid4())
    # create without any phone: must work
    r = push(h, "transaction", tid, "create", tx_payload())
    assert r.json()["results"][0]["status"] == "synced"
    row = [t for t in pull(h)["transactions"] if t["id"] == tid][0]
    assert row["merchant_phone"] is None and row["location_confirmed"] is False
    # add phone + location
    r = push(h, "transaction", tid, "update", tx_payload(merchant_phone="+919876543210", location_lat=18.52, location_lng=73.85,
                                                        location_name="Cafe", location_confirmed=True))
    assert r.json()["results"][0]["status"] == "synced"
    row = [t for t in pull(h)["transactions"] if t["id"] == tid][0]
    assert row["merchant_phone"] == "+919876543210" and row["location_lat"] == 18.52 and row["location_confirmed"] is True
    # clear phone with explicit null; location untouched when absent
    r = push(h, "transaction", tid, "update", {"merchant_phone": None}, version=row["server_version"])
    assert r.json()["results"][0]["status"] == "synced"
    row = [t for t in pull(h)["transactions"] if t["id"] == tid][0]
    assert row["merchant_phone"] is None and row["location_name"] == "Cafe"


@pytest.mark.parametrize("bad", ["9876543210", "+12", "+0123456789", "abc", "+91 98765 43210", "+9198765432101234567"])
def test_invalid_phone_rejected(bad):
    h = user()
    r = push(h, "transaction", str(uuid4()), "create", tx_payload(merchant_phone=bad))
    assert r.status_code == 422


def test_invalid_location_rejected():
    h = user()
    assert push(h, "transaction", str(uuid4()), "create", tx_payload(location_lat=123, location_lng=0)).status_code == 422


def test_phone_and_location_isolated_between_users():
    a, b = user(), user()
    tid = str(uuid4())
    push(a, "transaction", tid, "create", tx_payload(merchant_phone="+919876543210"))
    assert all(t["id"] != tid for t in pull(b)["transactions"])
    res = push(b, "transaction", tid, "update", tx_payload(merchant_phone="+919000000000")).json()["results"][0]
    assert res["status"] == "error" and "another user" in res["error"]
    assert [t for t in pull(a)["transactions"] if t["id"] == tid][0]["merchant_phone"] == "+919876543210"


def test_budget_sync_edit_delete_isolation():
    a, b = user(), user()
    bid = str(uuid4())
    assert push(a, "budget", bid, "create", {"category": "Food & Dining", "amount_paise": 500000}).json()["results"][0]["status"] == "synced"
    assert push(a, "budget", bid, "update", {"category": "Food & Dining", "amount_paise": 600000}).json()["results"][0]["status"] == "synced"
    assert [x for x in pull(a)["budgets"] if x["id"] == bid][0]["amount_paise"] == 600000
    assert pull(b)["budgets"] == []
    assert push(b, "budget", bid, "update", {"amount_paise": 1}).json()["results"][0]["status"] == "error"
    assert push(b, "budget", bid, "delete", {}).json()["results"][0]["status"] == "error"
    assert push(a, "budget", bid, "delete", {}).json()["results"][0]["status"] == "synced"
    assert [x for x in pull(a)["budgets"] if x["id"] == bid][0]["deleted_at"] is not None
    # idempotent repeat + no resurrection
    assert push(a, "budget", bid, "update", {"amount_paise": 9}).json()["results"][0]["status"] == "synced"
    assert [x for x in pull(a)["budgets"] if x["id"] == bid][0]["amount_paise"] == 600000


def test_merchant_alias_sync_and_isolation():
    a, b = user(), user()
    aid = str(uuid4())
    p = {"match_key": "SPJIMR MESS", "original_text": "SPJIMR MESS", "display_name": "SPJIMR Mess", "category": "Food & Dining"}
    assert push(a, "merchant_alias", aid, "create", p).json()["results"][0]["status"] == "synced"
    row = pull(a)["merchant_aliases"][0]
    assert row["match_key"] == "spjimr mess" and row["display_name"] == "SPJIMR Mess"
    assert pull(b)["merchant_aliases"] == []
    assert push(b, "merchant_alias", aid, "update", p).json()["results"][0]["status"] == "error"


def test_receipt_upload_download_isolation_and_validation():
    a, b = user(), user()
    tid = str(uuid4())
    push(a, "transaction", tid, "create", tx_payload())
    png = {**a, "Content-Type": "image/png"}
    r = client.post(f"/api/v1/receipts?transaction_id={tid}", headers=png, content=PNG)
    assert r.status_code == 201
    rid = r.json()["id"]
    assert client.get(f"/api/v1/receipts/{rid}", headers=a).content == PNG
    assert client.get(f"/api/v1/receipts/{rid}", headers=b).status_code == 404
    assert client.post(f"/api/v1/receipts?transaction_id={tid}", headers={**b, "Content-Type": "image/png"}, content=PNG).status_code == 404
    assert client.post(f"/api/v1/receipts?transaction_id={tid}", headers={**a, "Content-Type": "text/plain"}, content=b"x").status_code == 415
    assert client.post(f"/api/v1/receipts?transaction_id={tid}", headers=png, content=b"not an image").status_code == 422
    assert client.post(f"/api/v1/receipts?transaction_id={tid}", headers=png, content=PNG + b"0" * (5 * 1024 * 1024)).status_code == 413
    assert client.delete(f"/api/v1/receipts/{rid}", headers=b).status_code == 204
    assert client.get(f"/api/v1/receipts/{rid}", headers=a).status_code == 200  # B could not delete A's receipt
    assert client.delete(f"/api/v1/receipts/{rid}", headers=a).status_code == 204
    assert client.get(f"/api/v1/receipts/{rid}", headers=a).status_code == 404


def test_expected_payment_sync_partial_settle_delete_isolation():
    a, b = user(), user()
    eid = str(uuid4())
    p = {"person": "Ravi Kumar", "direction": "receive", "amount_paise": 50000, "paid_paise": 0, "note": "Dinner split",
         "due_date": "2026-12-01", "status": "pending", "payments": []}
    assert push(a, "expected_payment", eid, "create", p).json()["results"][0]["status"] == "synced"
    row = pull(a)["expected_payments"][0]
    assert (row["person"], row["amount_paise"], row["note"], row["due_date"], row["status"]) == ("Ravi Kumar", 50000, "Dinner split", "2026-12-01", "pending")
    # partial payment, then settled, history preserved
    p2 = {**p, "paid_paise": 20000, "payments": [{"transaction_id": None, "amount_paise": 20000, "at": "2026-11-06T00:00:00Z"}]}
    assert push(a, "expected_payment", eid, "update", p2).json()["results"][0]["status"] == "synced"
    p3 = {**p, "paid_paise": 50000, "status": "settled", "settled_at": "2026-11-07T10:00:00Z", "payments": p2["payments"] + [{"transaction_id": "t1", "amount_paise": 30000, "at": "x"}]}
    assert push(a, "expected_payment", eid, "update", p3).json()["results"][0]["status"] == "synced"
    row = pull(a)["expected_payments"][0]
    assert (row["paid_paise"], row["status"], len(row["payments"])) == (50000, "settled", 2) and row["settled_at"] is not None
    # validation
    assert push(a, "expected_payment", str(uuid4()), "create", {**p, "direction": "gift"}).json()["results"][0]["status"] == "error"
    assert push(a, "expected_payment", str(uuid4()), "create", {**p, "status": "weird"}).json()["results"][0]["status"] == "error"
    assert push(a, "expected_payment", str(uuid4()), "create", {"person": " ", "amount_paise": 5}).json()["results"][0]["status"] == "error"
    assert push(a, "expected_payment", str(uuid4()), "create", {**p, "due_date": "01/12/2026"}).status_code == 422
    # isolation
    assert pull(b)["expected_payments"] == []
    assert push(b, "expected_payment", eid, "update", p).json()["results"][0]["status"] == "error"
    assert push(b, "expected_payment", eid, "delete", {}).json()["results"][0]["status"] == "error"
    # soft delete + no resurrection
    assert push(a, "expected_payment", eid, "delete", {}).json()["results"][0]["status"] == "synced"
    assert pull(a)["expected_payments"][0]["deleted_at"] is not None
    push(a, "expected_payment", eid, "update", p)
    assert pull(a)["expected_payments"][0]["deleted_at"] is not None
