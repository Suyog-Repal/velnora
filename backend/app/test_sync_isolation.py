"""
Sync push failure isolation and identity consistency:
- one invalid item never blocks the valid items of the same batch (per-item validation_error, nothing stored for it)
- a server failure on one item is reported as retryable internal_error without SQL text or values, and the batch continues
- deleting an id the server never had is idempotent
- a create matched to an existing row by reference answers with the canonical id, and a later update / delete pushed
  under the device's own id reaches THAT row instead of creating a second copy
"""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db.models import Transaction
from app.db.session import get_session_factory
from app.main import app
from app.test_phase4_sync import cleanup_phase4_test_users, create_sync_user  # noqa: F401 - fixture reused

client = TestClient(app)


def _item(entity_id, operation="create", client_version=1, **payload):
    base = {"amount": "250.00", "direction": "expense", "counterparty": "AutoTest Shop", "category": "Food"}
    return {"operation_id": str(uuid4()), "entity_type": "transaction", "entity_id": str(entity_id),
            "operation": operation, "client_version": client_version, "payload": {**base, **payload}}


def _push(headers, *items):
    resp = client.post("/api/v1/sync/push", headers=headers, json={"items": list(items)})
    assert resp.status_code == 200, resp.text
    return {r["operation_id"]: r for r in resp.json()["results"]}


def _count(**where):
    with get_session_factory()() as s:
        q = select(func.count()).select_from(Transaction)
        for k, v in where.items():
            q = q.where(getattr(Transaction, k) == v)
        return s.scalar(q)


def test_invalid_item_does_not_block_valid_items():
    _, headers, _ = create_sync_user()
    good1, bad, good2 = uuid4(), uuid4(), uuid4()
    i1, ib, i2 = _item(good1), _item(bad, txn_kind="not-a-kind", account_last4="9999999999"), _item(good2)
    res = _push(headers, i1, ib, i2)
    assert res[i1["operation_id"]]["status"] == "synced"
    assert res[i2["operation_id"]]["status"] == "synced"
    r = res[ib["operation_id"]]
    assert r["status"] == "error" and r["error_code"] == "validation_error"
    assert r["entity_id"] == str(bad) and r["operation"] == "create"
    assert "payload.txn_kind" in r["error"] and "payload.account_last4" in r["error"]
    assert "not-a-kind" not in r["error"] and "9999999999" not in r["error"]  # values are never echoed
    assert _count(id=good1) == 1 and _count(id=good2) == 1 and _count(id=bad) == 0


def test_item_too_malformed_to_name_its_entity_is_still_isolated():
    _, headers, _ = create_sync_user()
    good = uuid4()
    ig = _item(good)
    res = _push(headers, {"operation_id": "op-garbage", "entity_id": "not-a-uuid", "operation": "explode"}, ig)
    assert res["op-garbage"]["status"] == "error" and res["op-garbage"]["error_code"] == "validation_error"
    assert res["op-garbage"]["entity_id"] is None and res["op-garbage"]["operation"] is None
    assert res[ig["operation_id"]]["status"] == "synced" and _count(id=good) == 1


def test_internal_failure_is_retryable_sanitized_and_isolated(monkeypatch):
    import app.sync as sync_module

    _, headers, _ = create_sync_user()
    boom_id, ok_id = uuid4(), uuid4()
    real = sync_module.ledger_values

    def failing_ledger_values(payload):
        if payload.counterparty == "AutoTest Boom":
            raise RuntimeError('column "secret_internal" SELECT * FROM transactions WHERE amount = 250.00')
        return real(payload)

    monkeypatch.setattr(sync_module, "ledger_values", failing_ledger_values)
    ib, io = _item(boom_id, counterparty="AutoTest Boom"), _item(ok_id)
    res = _push(headers, ib, io)
    r = res[ib["operation_id"]]
    assert r["status"] == "error" and r["error_code"] == "internal_error"
    assert "SELECT" not in r["error"] and "secret_internal" not in r["error"] and "250" not in r["error"]
    assert res[io["operation_id"]]["status"] == "synced"
    assert _count(id=boom_id) == 0 and _count(id=ok_id) == 1


def test_handler_errors_carry_stable_codes():
    _, headers, _ = create_sync_user()
    incomplete = _item(uuid4())
    del incomplete["payload"]["counterparty"]
    unknown_partial = {"operation_id": str(uuid4()), "entity_type": "transaction", "entity_id": str(uuid4()),
                       "operation": "update", "client_version": 1, "payload": {"description": "x"}}
    res = _push(headers, incomplete, unknown_partial)
    assert res[incomplete["operation_id"]]["error_code"] == "missing_fields"
    assert res[unknown_partial["operation_id"]]["error_code"] == "not_found"


def test_delete_of_unknown_id_is_idempotent_and_does_not_fail_the_batch():
    _, headers, _ = create_sync_user()
    ghost, keep = uuid4(), uuid4()
    deletion = {"operation_id": str(uuid4()), "entity_type": "transaction", "entity_id": str(ghost),
                "operation": "delete", "client_version": 1, "payload": {"deleted_at": datetime.now(timezone.utc).isoformat()}}
    ik = _item(keep)
    for _ in range(2):  # replayed delete stays idempotent
        res = _push(headers, dict(deletion, operation_id=str(uuid4())), dict(ik, operation_id=str(uuid4())))
        statuses = sorted(r["status"] for r in res.values())
        assert statuses == ["synced", "synced"]
    assert _count(id=ghost) == 0  # nothing is created for an unknown delete
    assert _count(id=keep) == 1


def test_reference_dedup_answers_canonical_id_and_later_update_does_not_duplicate():
    _, headers, _ = create_sync_user()
    ref = f"AUTOTEST{uuid4().hex[:10].upper()}"
    canonical, device_copy = uuid4(), uuid4()
    first = _item(canonical, reference_id=ref)
    _push(headers, first)
    # A second device (or a re-capture) creates the same payment under its own id
    second = _item(device_copy, reference_id=ref)
    ack = _push(headers, second)[second["operation_id"]]
    assert ack["status"] == "synced" and ack["entity_id"] == str(canonical)
    assert _count(reference_id=ref) == 1

    # An OLD client that did not re-key now edits the payment under its own id: must update the canonical row
    edit = _item(device_copy, operation="update", client_version=ack["server_version"], reference_id=ref,
                 description="AutoTest edited", updated_at=(datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat())
    ack2 = _push(headers, edit)[edit["operation_id"]]
    assert ack2["status"] == "synced" and ack2["entity_id"] == str(canonical)
    assert _count(reference_id=ref) == 1 and _count(id=device_copy) == 0
    with get_session_factory()() as s:
        assert s.get(Transaction, canonical).description == "AutoTest edited"

    # ... and a delete under its own id removes the canonical row (still exactly one row, now a tombstone)
    gone = {"operation_id": str(uuid4()), "entity_type": "transaction", "entity_id": str(device_copy),
            "operation": "delete", "client_version": 2, "payload": {"reference_id": ref}}
    ack3 = _push(headers, gone)[gone["operation_id"]]
    assert ack3["status"] == "synced" and ack3["entity_id"] == str(canonical)
    with get_session_factory()() as s:
        assert s.get(Transaction, canonical).deleted_at is not None
    assert _count(reference_id=ref) == 1


def test_stale_update_via_twin_keeps_server_version_rules():
    _, headers, _ = create_sync_user()
    ref = f"AUTOTEST{uuid4().hex[:10].upper()}"
    canonical = uuid4()
    _push(headers, _item(canonical, reference_id=ref))
    bump = _item(canonical, operation="update", client_version=1, reference_id=ref, description="newer on server")
    _push(headers, bump)  # server_version -> 2
    stale = _item(uuid4(), operation="update", client_version=1, reference_id=ref, description="stale device edit")
    ack = _push(headers, stale)[stale["operation_id"]]
    assert ack["status"] == "conflict_resolved" and ack["entity_id"] == str(canonical)
    with get_session_factory()() as s:
        assert s.get(Transaction, canonical).description == "newer on server"
    assert _count(reference_id=ref) == 1
