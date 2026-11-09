"""
Pytest configuration for Velnora backend tests.

Database tests write to and delete from a real PostgreSQL database, so they only run against one that is clearly
disposable: ``TEST_DATABASE_URL`` when it is set, otherwise a server on this machine. Anything else stops the run
before a connection is made. Tests that need the database fail immediately, with the reason, when it is not usable.

Fixed test user accounts are cleaned up before and after each test to guarantee isolation and repeat execution
without unique constraint conflicts.
"""

import os
from typing import Optional

import pytest
from sqlalchemy import inspect, select
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import OperationalError

from app.config import _load_dotenv_files, normalize_database_url
from app.db.session import get_runtime_engine, get_session_factory
from app.db.models import User

FIXED_TEST_EMAILS = [
    "api-test@example.com",
    "transaction-test@example.com",
]

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
# psycopg waits 130 s per address by default, and on Windows a refused connection only ends when that wait expires.
CONNECT_TIMEOUT_SECONDS = "5"
NO_CONNECTION_URL = "postgresql+psycopg://refused@127.0.0.1:1/refused?connect_timeout=2"


def _clean(name: str) -> str:
    return (os.environ.get(name) or "").strip().strip("'\"")


def _server(url: URL) -> tuple[Optional[str], Optional[str]]:
    """One Neon database has a pooled and a direct host name; both count as the same server."""
    return (url.host or "").replace("-pooler.", "."), url.database


def _refusal_reason(target: URL, explicit: bool) -> Optional[str]:
    if (_clean("ENVIRONMENT") or _clean("VELNORA_ENV")).lower() == "production":
        return "Refusing to run tests with ENVIRONMENT=production."
    if target.host in LOCAL_HOSTS:
        return None
    if not explicit:
        return "Refusing to run tests against a remote DATABASE_URL. Set TEST_DATABASE_URL to a disposable database."
    for name in ("DATABASE_URL", "DIRECT_DATABASE_URL"):
        configured = _clean(name)
        if configured and _server(make_url(normalize_database_url(configured))) == _server(target):
            return f"Refusing to run tests: TEST_DATABASE_URL is the same database as {name}."
    return None


def _select_test_database() -> Optional[str]:
    """Points the app's settings at the test database (settings are read later). Returns why it refused, if it did."""
    _load_dotenv_files()
    explicit = _clean("TEST_DATABASE_URL")
    target = make_url(normalize_database_url(explicit or _clean("DATABASE_URL")))

    refusal = _refusal_reason(target, bool(explicit))
    if refusal:
        url = NO_CONNECTION_URL
    else:
        if "connect_timeout" not in target.query:
            target = target.update_query_dict({"connect_timeout": CONNECT_TIMEOUT_SECONDS})
        url = target.render_as_string(hide_password=False)
    os.environ["DATABASE_URL"] = url
    os.environ["DIRECT_DATABASE_URL"] = url
    return refusal


DATABASE_REFUSAL = _select_test_database()


@pytest.fixture(scope="session")
def test_database():
    """Checks the database once. A failure here is reported by every test that needs it, without waiting again."""
    if DATABASE_REFUSAL:
        pytest.exit(DATABASE_REFUSAL, returncode=2)
    try:
        migrated = inspect(get_runtime_engine()).has_table("users")
    except OperationalError:
        pytest.fail("The test database is not reachable. Start it, or set TEST_DATABASE_URL (see backend/README.md).", pytrace=False)
    if not migrated:
        pytest.fail("The test database has no tables. Run `alembic upgrade head` against it first.", pytrace=False)


@pytest.fixture(autouse=True)
def cleanup_fixed_test_users(test_database):
    """Ensure fixed test user accounts are cleaned up before and after each test."""
    SessionLocal = get_session_factory()

    def _cleanup():
        with SessionLocal() as session:
            users = session.scalars(select(User).where(User.email.in_(FIXED_TEST_EMAILS))).all()
            for user in users:
                session.delete(user)
            session.commit()

    _cleanup()
    yield
    _cleanup()
