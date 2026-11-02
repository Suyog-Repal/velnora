"""
Pytest configuration for Velnora backend tests.
Cleans up fixed test user accounts before and after tests to guarantee test isolation
and repeat execution without unique constraint conflicts.
"""

import pytest
from sqlalchemy import select
from backend.app.db.session import get_session_factory
from backend.app.db.models import User

FIXED_TEST_EMAILS = [
    "api-test@example.com",
    "transaction-test@example.com",
]


@pytest.fixture(autouse=True)
def cleanup_fixed_test_users():
    """Ensure fixed test user accounts are cleaned up before and after each test."""
    SessionLocal = get_session_factory()

    def _cleanup():
        try:
            with SessionLocal() as session:
                users = session.scalars(select(User).where(User.email.in_(FIXED_TEST_EMAILS))).all()
                for user in users:
                    session.delete(user)
                session.commit()
        except Exception:
            pass

    _cleanup()
    yield
    _cleanup()
