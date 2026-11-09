"""Sync payload validation and model shape for unified-ledger metadata. Needs no database."""
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.db.models import Transaction
from app.sync import SyncItemPayload, SyncPullTransaction, ledger_values


@pytest.fixture(autouse=True)
def cleanup_fixed_test_users():
    """Overrides the database cleanup fixture: nothing in this module touches a database."""
    yield


def test_older_clients_get_safe_defaults():
    values = ledger_values(SyncItemPayload(amount="10.00", direction="expense", counterparty="X", category="Y"))
    assert values["txn_kind"] == "payment"
    assert values["verification_status"] == "verified"
    assert values["account_last4"] is None


def test_ledger_values_are_carried():
    dup = uuid4()
    payload = SyncItemPayload(txn_kind="refund", verification_status="needs_review", capture_source="notification",
                              account_last4="1234", bank_name="HDFC Bank", payment_app="Google Pay", possible_duplicate_of=dup, confidence=0.75)
    values = ledger_values(payload)
    assert (values["txn_kind"], values["possible_duplicate_of"], values["confidence"]) == ("refund", dup, 0.75)


@pytest.mark.parametrize("field,value", [
    ("account_last4", "123456789012"),  # a full account number is refused
    ("account_last4", "12a4"),
    ("txn_kind", "income"),
    ("verification_status", "maybe"),
    ("capture_source", "bank_login"),
    ("confidence", 1.5),
])
def test_invalid_values_are_rejected(field, value):
    with pytest.raises(ValidationError):
        SyncItemPayload(**{field: value})


def test_model_and_pull_schema_expose_every_field():
    columns = Transaction.__table__.columns.keys()
    for name in ("txn_kind", "verification_status", "capture_source", "account_last4", "bank_name", "payment_app", "possible_duplicate_of", "confidence"):
        assert name in columns
        assert name in SyncPullTransaction.model_fields
