from decimal import Decimal
import pytest

from .services import recorded_flow


@pytest.fixture(autouse=True)
def cleanup_fixed_test_users():
    """Overrides the database cleanup fixture: nothing in this module touches a database."""
    yield


def test_recorded_flow_is_not_debt() -> None:
    assert recorded_flow(Decimal("2500"), Decimal("300")) == Decimal("2200")
