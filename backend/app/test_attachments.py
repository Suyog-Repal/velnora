"""Transaction attachments: idempotent upload, listing, download, delete tombstones, limits and user isolation."""

from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.main import app
from app.db.session import get_session_factory
from app.db.models import Attachment, User

client = TestClient(app)
created = []

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64
JPG = b"\xff\xd8\xff\xe0" + b"1" * 64


@pytest.fixture(autouse=True)
def cleanup():
    yield
    with get_session_factory()() as s:
        for a in s.scalars(select(Attachment).where(Attachment.user_id.in_([UUID(x) for x in created]))).all():
            s.delete(a)
        for u in s.scalars(select(User).where(User.id.in_(created))).all():
            s.delete(u)
        s.commit()


def user():
    email = f"att_{uuid4().hex[:10]}@example.com"
    r = client.post("/api/v1/auth/register", json={"full_name": "A", "email": email, "password": "SecurePassword123!", "terms_accepted": True})
    assert r.status_code == 201
    d = r.json()
    created.append(d["user"]["id"])
    return {"Authorization": f"Bearer {d['access_token']}"}


def new_tx(h):
    tid = str(uuid4())
    r = client.post("/api/v1/sync/push", headers=h, json={"items": [{
        "operation_id": str(uuid4()), "entity_type": "transaction", "entity_id": tid, "operation": "create", "client_version": 1,
        "payload": {"amount": "10.00", "direction": "expense", "counterparty": "Cafe", "category": "Food & Dining"}}]})
    assert r.json()["results"][0]["status"] == "synced"
    return tid


def put(h, aid, tid, body=PNG, ctype="image/png", **q):
    params = "&".join(f"{k}={v}" for k, v in {"transaction_id": tid, **q}.items())
    return client.put(f"/api/v1/receipts/attachments/{aid}?{params}", headers={**h, "Content-Type": ctype}, content=body)


def test_multiple_attachments_roundtrip_and_idempotent_retry():
    a = user()
    tid = new_tx(a)
    p1, p2 = str(uuid4()), str(uuid4())
    r = put(a, p1, tid, attachment_type="photo", page_index=0, width=1200, height=1600)
    assert r.status_code == 201 and r.json()["width"] == 1200
    assert put(a, p2, tid, body=JPG, ctype="image/jpeg", attachment_type="scan", page_index=1).status_code == 201
    # A retried upload of the same id is a 200 and never a second row.
    again = put(a, p1, tid)
    assert again.status_code == 200 and again.json()["id"] == p1
    listed = client.get(f"/api/v1/receipts/attachments?transaction_id={tid}", headers=a).json()
    assert [x["id"] for x in listed["attachments"]] == [p1, p2]
    assert listed["attachments"][1]["attachment_type"] == "scan"
    assert listed["deleted_ids"] == []
    got = client.get(f"/api/v1/receipts/attachments/{p2}", headers=a)
    assert got.status_code == 200 and got.content == JPG and got.headers["cache-control"] == "private, no-store"
    with get_session_factory()() as s:
        assert len(s.scalars(select(Attachment).where(Attachment.transaction_id == UUID(tid))).all()) == 2


def test_delete_is_idempotent_keeps_tombstone_and_blocks_resurrection():
    a = user()
    tid = new_tx(a)
    aid = str(uuid4())
    assert put(a, aid, tid).status_code == 201
    assert client.delete(f"/api/v1/receipts/attachments/{aid}", headers=a).status_code == 204
    assert client.delete(f"/api/v1/receipts/attachments/{aid}", headers=a).status_code == 204
    assert client.get(f"/api/v1/receipts/attachments/{aid}", headers=a).status_code == 404
    listed = client.get(f"/api/v1/receipts/attachments?transaction_id={tid}", headers=a).json()
    assert listed["attachments"] == [] and listed["deleted_ids"] == [aid]
    assert put(a, aid, tid).status_code == 410  # a stale retry cannot bring a deleted document back
    with get_session_factory()() as s:
        row = s.get(Attachment, UUID(aid))
        assert row.data == b"" and row.size_bytes == 0  # bytes cleared on delete


def test_isolation_between_accounts():
    a, b = user(), user()
    tid = new_tx(a)
    aid = str(uuid4())
    assert put(a, aid, tid).status_code == 201
    assert client.get(f"/api/v1/receipts/attachments/{aid}", headers=b).status_code == 404
    assert client.get(f"/api/v1/receipts/attachments?transaction_id={tid}", headers=b).json()["attachments"] == []
    assert put(b, str(uuid4()), tid).status_code == 404       # B cannot attach to A's transaction
    assert put(b, aid, tid).status_code == 404                 # nor reuse A's attachment id
    assert client.delete(f"/api/v1/receipts/attachments/{aid}", headers=b).status_code == 204
    assert client.get(f"/api/v1/receipts/attachments/{aid}", headers=a).status_code == 200  # untouched
    assert client.get(f"/api/v1/receipts/attachments/{aid}").status_code in (401, 403)     # no token, no bytes


def test_validation_and_limit():
    a = user()
    tid = new_tx(a)
    assert put(a, str(uuid4()), tid, body=b"x", ctype="text/plain").status_code == 415
    assert put(a, str(uuid4()), tid, body=b"not an image").status_code == 422
    assert put(a, str(uuid4()), tid, body=b"").status_code == 422
    assert put(a, str(uuid4()), tid, body=PNG + b"0" * (15 * 1024 * 1024)).status_code == 413
    assert put(a, str(uuid4()), tid, attachment_type="pdf").status_code == 422
    assert put(a, str(uuid4()), str(uuid4())).status_code == 404  # unknown transaction
    for i in range(10):
        assert put(a, str(uuid4()), tid, page_index=i).status_code == 201
    assert put(a, str(uuid4()), tid).status_code == 422
