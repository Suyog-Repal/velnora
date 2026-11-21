from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from .auth import hash_token
from .db.models import RefreshToken, User
from .db.session import get_session_factory
from .main import app

client = TestClient(app)


def row_for(token: str) -> Optional[RefreshToken]:
    with get_session_factory()() as session:
        return session.scalar(select(RefreshToken).where(RefreshToken.token_hash == hash_token(token)))


def age_revocation(token: str, seconds: int) -> None:
    """Pretend the token was rotated `seconds` ago."""
    with get_session_factory()() as session:
        row = session.scalar(select(RefreshToken).where(RefreshToken.token_hash == hash_token(token)))
        assert row is not None and row.revoked_at is not None
        row.revoked_at = datetime.now(timezone.utc) - timedelta(seconds=seconds)
        session.commit()


def token_count(user_id: str) -> int:
    with get_session_factory()() as session:
        return session.scalar(select(func.count()).select_from(RefreshToken).where(RefreshToken.user_id == UUID(user_id)))


def refresh(token: str):
    return client.post("/api/v1/auth/refresh", json={"refresh_token": token})


def register_user() -> tuple[dict, dict[str, str]]:
    email = f"user-{uuid4()}@example.com"
    response = client.post("/api/v1/auth/register", json={"full_name": "Test User", "email": email, "password": "SecurePass1", "terms_accepted": True})
    assert response.status_code == 201
    payload = response.json()
    return payload, {"Authorization": f"Bearer {payload['access_token']}"}


def test_registration_login_and_me() -> None:
    payload, headers = register_user()
    assert payload["user"]["full_name"] == "Test User"
    assert client.get("/api/v1/me", headers=headers).json()["email"] == payload["user"]["email"]
    login = client.post("/api/v1/auth/login", json={"email": payload["user"]["email"], "password": "SecurePass1"})
    assert login.status_code == 200


def test_validation_duplicate_and_wrong_password() -> None:
    payload, _ = register_user()
    duplicate = client.post("/api/v1/auth/register", json={"full_name": "Other", "email": payload["user"]["email"], "password": "SecurePass1", "terms_accepted": True})
    assert duplicate.status_code == 409
    wrong = client.post("/api/v1/auth/login", json={"email": payload["user"]["email"], "password": "WrongPass1"})
    assert wrong.status_code == 401
    weak = client.post("/api/v1/auth/register", json={"full_name": "Other", "email": f"weak-{uuid4()}@example.com", "password": "weak", "terms_accepted": True})
    assert weak.status_code == 422


def test_registration_contract_and_terms_error() -> None:
    email = f"contract-{uuid4()}@example.com"
    response = client.post(
        "/api/v1/auth/register",
        json={"full_name": "Contract User", "email": email, "password": "SecurePass1", "terms_accepted": True},
    )

    assert response.status_code == 201
    payload = response.json()
    assert set(payload) == {"user", "access_token", "refresh_token", "token_type"}
    assert payload["user"] == {
        "id": payload["user"]["id"],
        "full_name": "Contract User",
        "email": email,
    }

    terms_response = client.post(
        "/api/v1/auth/register",
        json={"full_name": "No Terms User", "email": f"terms-{uuid4()}@example.com", "password": "SecurePass1", "terms_accepted": False},
    )
    assert terms_response.status_code == 400
    assert terms_response.json()["detail"] == "Terms acceptance is required"


def test_refresh_rotation_and_logout_revocation() -> None:
    payload, headers = register_user()
    refreshed = client.post("/api/v1/auth/refresh", json={"refresh_token": payload["refresh_token"]})
    assert refreshed.status_code == 200
    rotated = refreshed.json()
    age_revocation(payload["refresh_token"], 61)  # outside the reuse grace the spent token is rejected
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": payload["refresh_token"]}).status_code == 401
    assert client.post("/api/v1/auth/logout", headers={"Authorization": f"Bearer {rotated['access_token']}"}, json={"refresh_token": rotated["refresh_token"]}).status_code == 204
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": rotated["refresh_token"]}).status_code == 401
    assert client.get("/api/v1/me", headers=headers).status_code == 200


def test_transaction_requires_owner_and_is_scoped() -> None:
    first, first_headers = register_user()
    second, second_headers = register_user()
    created = client.post("/api/v1/transactions", headers=first_headers, json={"amount": "2000", "direction": "income", "counterparty": "Rahul", "category": "Other Income"})
    assert created.status_code == 201
    transaction_id = created.json()["id"]
    assert client.get("/api/v1/transactions", headers=second_headers).json() == []
    assert client.get(f"/api/v1/transactions/{transaction_id}", headers=second_headers).status_code == 404
    assert client.get("/api/v1/me", headers={"Authorization": "Bearer invalid"}).status_code == 401
    assert first["user"]["id"] != second["user"]["id"]


def _race(token: str, workers: int) -> list[int]:
    import threading

    barrier = threading.Barrier(workers)
    codes: list[int] = []

    def attempt() -> None:
        local = TestClient(app)
        barrier.wait()
        codes.append(local.post("/api/v1/auth/refresh", json={"refresh_token": token}).status_code)

    threads = [threading.Thread(target=attempt) for _ in range(workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return sorted(codes)


def test_concurrent_refresh_with_one_token_rotates_once_and_grants_one_grace_use() -> None:
    """Six simultaneous requests with one unused token: one rotates it, one gets the single grace use, the rest are rejected."""
    payload, _ = register_user()
    assert _race(payload["refresh_token"], 6) == [200, 200, 401, 401, 401, 401]
    assert row_for(payload["refresh_token"]) is None  # the grace use consumed the rotated row


def test_concurrent_grace_reuse_gives_exactly_one_success() -> None:
    payload, _ = register_user()
    assert refresh(payload["refresh_token"]).status_code == 200  # rotated; the original is now inside the grace window
    assert _race(payload["refresh_token"], 6) == [200, 401, 401, 401, 401, 401]


def test_grace_reuse_inside_60_seconds_works_once_and_never_touches_revoked_at() -> None:
    payload, _ = register_user()
    token = payload["refresh_token"]
    first = refresh(token)
    assert first.status_code == 200
    assert row_for(token).revoked_at is not None

    again = refresh(token)  # inside the grace window: a fresh pair
    assert again.status_code == 200
    assert again.json()["refresh_token"] not in (token, first.json()["refresh_token"])
    assert row_for(token) is None  # consumed by deletion; revoked_at was never rewritten
    assert refresh(token).status_code == 401  # single use
    assert refresh(first.json()["refresh_token"]).status_code == 200  # the tokens issued meanwhile still work
    assert refresh(again.json()["refresh_token"]).status_code == 200


def test_reuse_after_60_seconds_is_rejected_and_the_row_is_left_alone() -> None:
    payload, _ = register_user()
    token = payload["refresh_token"]
    assert refresh(token).status_code == 200
    age_revocation(token, 61)
    assert refresh(token).status_code == 401
    row = row_for(token)
    assert row is not None and row.revoked_at is not None  # a rejected attempt changes nothing


def test_reuse_after_sign_out_is_rejected_and_sign_out_deletes_the_row() -> None:
    payload, _ = register_user()
    token = payload["refresh_token"]
    headers = {"Authorization": f"Bearer {payload['access_token']}"}
    assert client.post("/api/v1/auth/logout", headers=headers, json={"refresh_token": token}).status_code == 204
    assert row_for(token) is None
    assert refresh(token).status_code == 401


def test_the_token_rotated_just_before_sign_out_cannot_start_a_new_session() -> None:
    payload, _ = register_user()
    old = payload["refresh_token"]
    rotated = refresh(old).json()  # `old` is now inside its grace window
    headers = {"Authorization": f"Bearer {rotated['access_token']}"}
    assert client.post("/api/v1/auth/logout", headers=headers, json={"refresh_token": rotated["refresh_token"]}).status_code == 204
    assert row_for(old) is None and row_for(rotated["refresh_token"]) is None
    assert refresh(old).status_code == 401
    assert refresh(rotated["refresh_token"]).status_code == 401


def test_sign_out_without_a_token_deletes_every_refresh_token_of_the_user() -> None:
    payload, _ = register_user()
    user_id = payload["user"]["id"]
    second = client.post("/api/v1/auth/login", json={"email": payload["user"]["email"], "password": "SecurePass1"}).json()
    rotated = refresh(second["refresh_token"]).json()  # leaves a rotated row as well
    assert token_count(user_id) >= 3
    assert client.post("/api/v1/auth/logout", headers={"Authorization": f"Bearer {rotated['access_token']}"}, json={}).status_code == 204
    assert token_count(user_id) == 0
    for token in (payload["refresh_token"], second["refresh_token"], rotated["refresh_token"]):
        assert refresh(token).status_code == 401


def test_deleting_the_account_deletes_its_refresh_tokens() -> None:
    payload, _ = register_user()
    user_id = UUID(payload["user"]["id"])
    assert token_count(payload["user"]["id"]) == 1
    with get_session_factory()() as session:
        session.delete(session.get(User, user_id))
        session.commit()
    assert token_count(payload["user"]["id"]) == 0
    assert refresh(payload["refresh_token"]).status_code == 401


def test_failed_rotation_rolls_back_so_the_old_token_still_works(monkeypatch) -> None:
    """If issuing the new pair fails after the old token was claimed, nothing is committed: the caller keeps a usable token."""
    from . import main as main_module

    payload, _ = register_user()
    token = payload["refresh_token"]

    def broken_issue(*_args, **_kwargs):
        raise RuntimeError("simulated failure while issuing the new pair")

    monkeypatch.setattr(main_module, "issue_tokens", broken_issue)
    failing = TestClient(app, raise_server_exceptions=False)
    assert failing.post("/api/v1/auth/refresh", json={"refresh_token": token}).status_code == 500
    monkeypatch.undo()

    retried = client.post("/api/v1/auth/refresh", json={"refresh_token": token})
    assert retried.status_code == 200
    assert retried.json()["refresh_token"] != token


def test_refresh_rejects_unknown_and_expired_tokens() -> None:
    payload, _ = register_user()
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": "x" * 40}).status_code == 401
    # An access token is not a refresh token.
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": payload["access_token"]}).status_code == 401


# --- Refresh outcome logging -------------------------------------------------------------------------------------------

def refresh_log(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "velnora" and r.getMessage().startswith("auth refresh")]


def test_refresh_logs_ok_within_grace_and_revoked_outcomes(caplog) -> None:
    import logging

    caplog.set_level(logging.INFO, logger="velnora")
    payload, _ = register_user()
    token = payload["refresh_token"]
    rotated = refresh(token)
    assert refresh(token).status_code == 200  # within grace
    assert refresh(token).status_code == 401  # its single grace use is spent
    lines = refresh_log(caplog)
    assert lines[0].startswith("auth refresh outcome=ok reason=- token_age_s=")
    assert lines[1].startswith("auth refresh outcome=within_grace")
    assert lines[2].startswith("auth refresh outcome=revoked reason=no_row")


def test_refresh_logs_a_stale_rotation_as_revoked_with_how_long_ago(caplog) -> None:
    import logging

    caplog.set_level(logging.INFO, logger="velnora")
    payload, _ = register_user()
    token = payload["refresh_token"]
    assert refresh(token).status_code == 200
    age_revocation(token, 120)
    assert refresh(token).status_code == 401
    last = refresh_log(caplog)[-1]
    assert "outcome=revoked reason=rotated_stale" in last and "revoked_ago_s=12" in last  # 120 s, give or take the clock


def test_refresh_logs_user_missing_and_row_expired(caplog) -> None:
    import logging

    from .auth import create_token

    caplog.set_level(logging.INFO, logger="velnora")
    ghost = create_token(uuid4(), "refresh", timedelta(days=1))  # a valid token for a user that does not exist
    assert refresh(ghost).status_code == 401
    assert "outcome=user_missing" in refresh_log(caplog)[-1]

    payload, _ = register_user()
    with get_session_factory()() as session:
        row = session.scalar(select(RefreshToken).where(RefreshToken.token_hash == hash_token(payload["refresh_token"])))
        row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        session.commit()
    assert refresh(payload["refresh_token"]).status_code == 401
    assert "outcome=expired reason=row_expired" in refresh_log(caplog)[-1]


def test_refresh_log_never_contains_tokens_hashes_ids_or_emails(caplog) -> None:
    import logging

    caplog.set_level(logging.DEBUG)
    payload, _ = register_user()
    token = payload["refresh_token"]
    secrets = [token, payload["access_token"], hash_token(token), payload["user"]["id"], payload["user"]["email"]]
    refresh(token)
    refresh(token)
    refresh(token)
    text = "\n".join(r.getMessage() for r in caplog.records if r.name == "velnora")
    assert "auth refresh outcome=" in text
    for secret in secrets:
        assert secret not in text


@pytest.mark.no_db
def test_refresh_logs_an_expired_token_without_touching_the_database(caplog) -> None:
    import logging

    from .auth import create_token

    caplog.set_level(logging.INFO, logger="velnora")
    expired = create_token(uuid4(), "refresh", timedelta(seconds=-30))
    response = client.post("/api/v1/auth/refresh", json={"refresh_token": expired})
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid or expired session"}  # the response is unchanged: the reason is log-only
    line = refresh_log(caplog)[-1]
    assert "outcome=expired reason=- token_age_s=" in line
    assert expired not in line


@pytest.mark.no_db
def test_refresh_logs_an_invalid_token_as_invalid(caplog) -> None:
    import logging

    caplog.set_level(logging.INFO, logger="velnora")
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": "not-a-jwt-but-long-enough-xx"}).status_code == 401
    assert "outcome=invalid" in refresh_log(caplog)[-1]
