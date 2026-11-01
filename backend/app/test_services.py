from decimal import Decimal

from .services import recorded_flow


def test_recorded_flow_is_not_debt() -> None:
    assert recorded_flow(Decimal("2500"), Decimal("300")) == Decimal("2200")
