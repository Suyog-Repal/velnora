from fastapi.testclient import TestClient

from .main import app

client = TestClient(app)


def test_create_and_list_transaction() -> None:
    registration = client.post(
        "/api/v1/auth/register",
        json={"full_name": "Transaction Test User", "email": "transaction-test@example.com", "password": "SecurePass1", "terms_accepted": True},
    )
    headers = {"Authorization": f"Bearer {registration.json()['access_token']}"}
    response = client.post(
        "/api/v1/transactions",
        json={"amount": "2000", "direction": "income", "counterparty": "Rahul", "category": "Other Income"},
        headers=headers,
    )
    assert response.status_code == 201
    assert response.json()["counterparty"] == "Rahul"
    assert len(client.get("/api/v1/transactions", headers=headers).json()) >= 1
