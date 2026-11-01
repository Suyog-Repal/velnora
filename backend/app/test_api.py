from fastapi.testclient import TestClient

from .main import app


def test_health_and_transaction_creation() -> None:
    client = TestClient(app)
    assert client.get('/api/v1/health').json()['status'] == 'ok'
    registration = client.post('/api/v1/auth/register', json={
        'full_name': 'API Test User',
        'email': 'api-test@example.com',
        'password': 'SecurePass1',
        'terms_accepted': True,
    })
    headers = {'Authorization': f"Bearer {registration.json()['access_token']}"}
    response = client.post('/api/v1/transactions', json={
        'amount': '2000',
        'direction': 'income',
        'counterparty': 'Rahul',
        'category': 'Other Income',
    }, headers=headers)
    assert response.status_code == 201
    assert response.json()['counterparty'] == 'Rahul'
