"""add unified ledger metadata to transactions

Revision ID: f7c3a1d9e2b6
Revises: e5b2c8d4a7f1
Create Date: 2026-11-09 12:00:00.000000

Additive only: new columns with defaults or NULL. No existing value is changed or dropped, and no uniqueness
constraint is added, because a reference id is not guaranteed unique across a bank's history.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'f7c3a1d9e2b6'
down_revision: Union[str, Sequence[str], None] = 'e5b2c8d4a7f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('transactions', sa.Column('txn_kind', sa.String(20), nullable=False, server_default='payment'))
    op.add_column('transactions', sa.Column('verification_status', sa.String(20), nullable=False, server_default='verified'))
    op.add_column('transactions', sa.Column('capture_source', sa.String(20), nullable=True))
    op.add_column('transactions', sa.Column('account_last4', sa.String(4), nullable=True))
    op.add_column('transactions', sa.Column('bank_name', sa.String(60), nullable=True))
    op.add_column('transactions', sa.Column('payment_app', sa.String(40), nullable=True))
    op.add_column('transactions', sa.Column('possible_duplicate_of', postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column('transactions', sa.Column('confidence', sa.Float(), nullable=True))
    op.create_index('ix_transactions_user_verification', 'transactions', ['user_id', 'verification_status'])


def downgrade() -> None:
    op.drop_index('ix_transactions_user_verification', table_name='transactions')
    for column in ('confidence', 'possible_duplicate_of', 'payment_app', 'bank_name', 'account_last4', 'capture_source', 'verification_status', 'txn_kind'):
        op.drop_column('transactions', column)
