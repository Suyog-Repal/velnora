"""add transaction details, merchant aliases, budgets, receipts

Revision ID: d3a9b7c2e1f4
Revises: c1f8e4a90b2d
Create Date: 2026-11-05 12:00:00.000000

Additive only: new nullable columns and new tables. No data is modified or dropped.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'd3a9b7c2e1f4'
down_revision: Union[str, Sequence[str], None] = 'c1f8e4a90b2d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('transactions', sa.Column('merchant_phone', sa.String(20), nullable=True))
    op.add_column('transactions', sa.Column('payment_method', sa.String(40), nullable=True))
    op.add_column('transactions', sa.Column('receipt_remote_id', sa.String(64), nullable=True))
    op.add_column('transactions', sa.Column('location_lat', sa.Float(), nullable=True))
    op.add_column('transactions', sa.Column('location_lng', sa.Float(), nullable=True))
    op.add_column('transactions', sa.Column('location_name', sa.String(200), nullable=True))
    op.add_column('transactions', sa.Column('location_address', sa.Text(), nullable=True))
    op.add_column('transactions', sa.Column('location_confirmed', sa.Boolean(), nullable=False, server_default=sa.text('false')))

    op.create_table(
        'merchant_aliases',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('match_key', sa.String(200), nullable=False),
        sa.Column('original_text', sa.String(200), nullable=False),
        sa.Column('display_name', sa.String(160), nullable=False),
        sa.Column('category', sa.String(80), nullable=True),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_merchant_aliases_user_id', 'merchant_aliases', ['user_id'])

    op.create_table(
        'budgets',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('category', sa.String(80), nullable=True),
        sa.Column('amount_paise', sa.BigInteger(), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_budgets_user_id', 'budgets', ['user_id'])

    op.create_table(
        'receipts',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('transaction_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('content_type', sa.String(40), nullable=False),
        sa.Column('size_bytes', sa.Integer(), nullable=False),
        sa.Column('data', sa.LargeBinary(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_receipts_user_id', 'receipts', ['user_id'])
    op.create_index('ix_receipts_transaction_id', 'receipts', ['transaction_id'])


def downgrade() -> None:
    op.drop_table('receipts')
    op.drop_table('budgets')
    op.drop_table('merchant_aliases')
    for col in ('location_confirmed', 'location_address', 'location_name', 'location_lng', 'location_lat',
                'receipt_remote_id', 'payment_method', 'merchant_phone'):
        op.drop_column('transactions', col)
