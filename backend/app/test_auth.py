from uuid import uuid4

from fastapi.testclient import TestClient

from .main import app

client = TestClient(app)


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


def test_concurrent_refresh_with_one_token_lets_only_one_request_win() -> None:
    """Two requests presenting the same refresh token at once: exactly one may consume it."""
    import threading

    payload, _ = register_user()
    token = payload["refresh_token"]
    workers = 6
    barrier = threading.Barrier(workers)
    codes: list[int] = []
    bodies: list[dict] = []

    def attempt() -> None:
        local = TestClient(app)
        barrier.wait()
        response = local.post("/api/v1/auth/refresh", json={"refresh_token": token})
        codes.append(response.status_code)
        if response.status_code == 200:
            bodies.append(response.json())

    threads = [threading.Thread(target=attempt) for _ in range(workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert sorted(codes) == [200] + [401] * (workers - 1)
    # The winner's new refresh token works, and the original one stays spent.
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": bodies[0]["refresh_token"]}).status_code == 200
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": token}).status_code == 401


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
