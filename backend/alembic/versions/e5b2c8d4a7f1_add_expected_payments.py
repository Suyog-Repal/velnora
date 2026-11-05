"""add expected_payments

Revision ID: e5b2c8d4a7f1
Revises: d3a9b7c2e1f4
Create Date: 2026-11-06 12:00:00.000000

Additive only: one new table. No existing data is modified or dropped.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'e5b2c8d4a7f1'
down_revision: Union[str, Sequence[str], None] = 'd3a9b7c2e1f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'expected_payments',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('person', sa.String(80), nullable=False),
        sa.Column('direction', sa.String(8), nullable=False),
        sa.Column('amount_paise', sa.BigInteger(), nullable=False),
        sa.Column('paid_paise', sa.BigInteger(), nullable=False, server_default='0'),
        sa.Column('note', sa.String(200), nullable=True),
        sa.Column('due_date', sa.String(10), nullable=True),
        sa.Column('status', sa.String(12), nullable=False),
        sa.Column('settled_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('payments', sa.JSON(), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_expected_payments_user_id', 'expected_payments', ['user_id'])


def downgrade() -> None:
    op.drop_table('expected_payments')
