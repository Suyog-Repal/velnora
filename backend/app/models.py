from decimal import Decimal
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, Field


class Direction(str, Enum):
    income = "income"
    expense = "expense"


class TransactionPayload(BaseModel):
    amount: Decimal = Field(gt=0)
    direction: Direction
    counterparty: str = Field(min_length=1, max_length=160)
    category: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)


class TransactionIdentity(BaseModel):
    id: UUID
    user_id: UUID
