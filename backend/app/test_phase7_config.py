"""
Phase 7: production configuration and deployment readiness.

These tests use plain dictionaries / dependency overrides only: they never read a real .env file, never open a
database connection and never contain a real secret.
"""

import pytest
from fastapi.testclient import TestClient

from backend.app.config import (
    DEV_DATABASE_URL,
    DEV_JWT_SECRET,
    ConfigError,
    derive_direct_database_url,
    load_settings,
    normalize_database_url,
)

STRONG_SECRET = "test-only-secret-" + "x" * 32          # placeholder value for tests, not a real credential
PROD_DB = "postgresql://appuser:test-password@db.example.test/velnora"


def prod_env(**overrides: str) -> dict[str, str]:
    env = {
        "ENVIRONMENT": "production",
        "DATABASE_URL": PROD_DB,
        "JWT_SECRET_KEY": STRONG_SECRET,
        "VELNORA_CORS_ORIGINS": "https://app.example.test",
    }
    env.update(overrides)
    return env


# ── development defaults ─────────────────────────────────────────────────────
def test_development_defaults_work_with_an_empty_environment():
    s = load_settings({})
    assert s.environment == "development" and not s.is_production
    assert s.jwt_secret_key == DEV_JWT_SECRET
    assert s.database_url == DEV_DATABASE_URL
    assert s.cors_origins == ("http://localhost:8081",)
    assert (s.jwt_access_token_expire_minutes, s.jwt_refresh_token_expire_days) == (15, 30)
    assert s.log_level == "INFO"


def test_legacy_aliases_are_still_honoured():
    s = load_settings({"VELNORA_ENV": "staging", "VELNORA_JWT_SECRET": "legacy-secret"})
    assert s.environment == "staging" and s.jwt_secret_key == "legacy-secret"
    # the canonical name wins when both are present
    assert load_settings({"JWT_SECRET_KEY": "canonical", "VELNORA_JWT_SECRET": "legacy"}).jwt_secret_key == "canonical"


# ── production validation ────────────────────────────────────────────────────
def test_valid_production_configuration_loads():
    s = load_settings(prod_env())
    assert s.is_production
    assert s.database_url.startswith("postgresql+psycopg://")        # driver added to Render/Neon's postgresql:// URL
    assert s.jwt_secret_key == STRONG_SECRET
    assert s.cors_origins == ("https://app.example.test",) and s.cors_allows_credentials


@pytest.mark.parametrize("overrides, expected", [
    ({"JWT_SECRET_KEY": ""}, "JWT_SECRET_KEY"),
    ({"JWT_SECRET_KEY": DEV_JWT_SECRET}, "JWT_SECRET_KEY"),
    ({"JWT_SECRET_KEY": "short"}, "at least 32"),
    ({"DATABASE_URL": ""}, "DATABASE_URL is required"),
    ({"DATABASE_URL": "postgresql://<user>:<password>@<host>/<dbname>"}, "placeholder"),
    ({"DATABASE_URL": "mysql://u:p@h/db"}, "must be a PostgreSQL URL"),
    ({"VELNORA_CORS_ORIGINS": "*"}, "not '*'"),
    ({"VELNORA_CORS_ORIGINS": "https://a.example.test,*"}, "not '*'"),
])
def test_unsafe_production_configuration_fails_with_a_clear_message(overrides, expected):
    with pytest.raises(ConfigError) as exc:
        load_settings(prod_env(**overrides))
    assert expected in str(exc.value)


def test_error_messages_never_contain_secret_values():
    with pytest.raises(ConfigError) as exc:
        load_settings(prod_env(JWT_SECRET_KEY="short-secret-value", DATABASE_URL="postgresql://u:hunter2@<host>/db"))
    message = str(exc.value)
    assert "short-secret-value" not in message and "hunter2" not in message


def test_all_problems_are_reported_together():
    with pytest.raises(ConfigError) as exc:
        load_settings({"ENVIRONMENT": "production"})
    message = str(exc.value)
    assert "DATABASE_URL" in message and "JWT_SECRET_KEY" in message


def test_invalid_numbers_and_levels_are_rejected():
    for env, name in [({"JWT_ACCESS_TOKEN_EXPIRE_MINUTES": "soon"}, "JWT_ACCESS_TOKEN_EXPIRE_MINUTES"),
                      ({"JWT_REFRESH_TOKEN_EXPIRE_DAYS": "0"}, "JWT_REFRESH_TOKEN_EXPIRE_DAYS"),
                      ({"LOG_LEVEL": "chatty"}, "LOG_LEVEL"), ({"ENVIRONMENT": "prod"}, "ENVIRONMENT")]:
        with pytest.raises(ConfigError) as exc:
            load_settings(env)
        assert name in str(exc.value)
    s = load_settings({"JWT_ACCESS_TOKEN_EXPIRE_MINUTES": "60", "JWT_REFRESH_TOKEN_EXPIRE_DAYS": "7", "LOG_LEVEL": "warning"})
    assert (s.jwt_access_token_expire_minutes, s.jwt_refresh_token_expire_days, s.log_level) == (60, 7, "WARNING")


def test_development_allows_a_wildcard_but_never_with_credentials():
    s = load_settings({"VELNORA_CORS_ORIGINS": "*"})
    assert s.cors_origins == ("*",) and s.cors_allows_credentials is False


# ── database URLs ────────────────────────────────────────────────────────────
def test_database_url_normalisation():
    assert normalize_database_url("postgres://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_database_url("postgresql://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_database_url("postgresql+psycopg://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_database_url("  'postgres://u:p@h/db'  ") == "postgresql+psycopg://u:p@h/db"


def test_direct_url_for_migrations():
    pooled = "postgresql+psycopg://u:p@ep-abc-pooler.region.aws.neon.tech/db?sslmode=require"
    assert derive_direct_database_url(None, pooled) == "postgresql+psycopg://u:p@ep-abc.region.aws.neon.tech/db?sslmode=require"
    assert derive_direct_database_url("postgresql://u:p@direct.example.test/db", pooled) == "postgresql+psycopg://u:p@direct.example.test/db"
    assert derive_direct_database_url("postgresql://<user>:<pw>@<host>/db", pooled).endswith("neon.tech/db?sslmode=require")  # placeholder ignored
    render_url = "postgresql+psycopg://u:p@dpg-x/db"                     # non-Neon provider: same URL
    assert derive_direct_database_url(None, render_url) == render_url
    assert load_settings(prod_env()).direct_database_url == load_settings(prod_env()).database_url


# ── application: health, CORS, JWT ───────────────────────────────────────────
@pytest.fixture()
def client():
    from backend.app.main import app
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_health_endpoint_is_lightweight_and_exposes_nothing_sensitive(client):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "velnora-api"}
    body = response.text.lower()
    for forbidden in ("database", "secret", "password", "postgres", "jwt"):
        assert forbidden not in body


class _FakeDb:
    def __init__(self, fail: bool): self.fail = fail
    def execute(self, *_a, **_k):
        if self.fail:
            raise RuntimeError("connection to server at db.example.test failed: password authentication failed for user appuser")


def test_readiness_reports_ok_or_a_generic_503(client):
    from backend.app.db.session import get_db
    from backend.app.main import app
    app.dependency_overrides[get_db] = lambda: _FakeDb(fail=False)
    ok = client.get("/api/v1/health/ready")
    assert ok.status_code == 200 and ok.json() == {"status": "ok", "database": "ok"}
    app.dependency_overrides[get_db] = lambda: _FakeDb(fail=True)
    bad = client.get("/api/v1/health/ready")
    assert bad.status_code == 503 and bad.json() == {"status": "unavailable", "database": "unavailable"}
    for leaked in ("db.example.test", "appuser", "password", "RuntimeError"):
        assert leaked not in bad.text


def test_cors_allows_configured_origin_only(client):
    allowed = client.options("/api/v1/health", headers={"Origin": "http://localhost:8081", "Access-Control-Request-Method": "GET"})
    assert allowed.headers.get("access-control-allow-origin") == "http://localhost:8081"
    assert allowed.headers.get("access-control-allow-credentials") == "true"
    blocked = client.options("/api/v1/health", headers={"Origin": "https://evil.example.test", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in blocked.headers


def test_existing_api_routes_are_still_registered(client):
    paths = {route.path for route in client.app.routes}
    for expected in ("/api/v1/health", "/api/v1/auth/register", "/api/v1/auth/login", "/api/v1/auth/refresh", "/api/v1/auth/logout",
                     "/api/v1/transactions", "/api/v1/me"):
        assert expected in paths, expected
    assert any(p.startswith("/api/v1/sync") for p in paths)
    assert any(p.startswith("/api/v1/receipts") for p in paths)


def test_jwt_uses_the_configured_secret_and_lifetimes():
    from uuid import uuid4
    from datetime import timedelta
    import jwt
    from backend.app import auth
    from backend.app.config import get_settings
    s = get_settings()
    assert auth.JWT_SECRET == s.jwt_secret_key
    assert (auth.ACCESS_TOKEN_MINUTES, auth.REFRESH_TOKEN_DAYS) == (s.jwt_access_token_expire_minutes, s.jwt_refresh_token_expire_days)
    token = auth.create_token(uuid4(), "access", timedelta(minutes=5))
    claims = jwt.decode(token, s.jwt_secret_key, algorithms=[auth.JWT_ALGORITHM])
    assert claims["type"] == "access"
    with pytest.raises(jwt.InvalidSignatureError):
        jwt.decode(token, "a-different-secret-key-for-testing-only!!", algorithms=[auth.JWT_ALGORITHM])


def test_start_command_module_path_exists():
    # `uvicorn backend.app.main:app` is the Render start command, so this exact import path must resolve.
    import importlib
    module = importlib.import_module("backend.app.main")
    assert module.app.title == "Velnora API"
