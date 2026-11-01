from decimal import Decimal


def recorded_flow(received: Decimal, paid: Decimal) -> Decimal:
    """Return recorded counterparty flow, never a debt or balance owed."""
    return received - paid
