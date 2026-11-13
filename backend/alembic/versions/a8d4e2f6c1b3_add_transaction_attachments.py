"""add transaction_attachments (multiple photos / scanned pages per transaction)

Revision ID: a8d4e2f6c1b3
Revises: f7c3a1d9e2b6
Create Date: 2026-11-12 10:00:00.000000

Additive only: one new table. Existing transactions and receipts are not touched.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'a8d4e2f6c1b3'
down_revision: Union[str, Sequence[str], None] = 'f7c3a1d9e2b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'transaction_attachments',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('transaction_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('attachment_type', sa.String(20), nullable=False, server_default='photo'),
        sa.Column('page_index', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('content_type', sa.String(40), nullable=False),
        sa.Column('size_bytes', sa.Integer(), nullable=False),
        sa.Column('width', sa.Integer(), nullable=True),
        sa.Column('height', sa.Integer(), nullable=True),
        sa.Column('data', sa.LargeBinary(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index('ix_transaction_attachments_user_id', 'transaction_attachments', ['user_id'])
    op.create_index('ix_transaction_attachments_transaction_id', 'transaction_attachments', ['transaction_id'])
    op.create_index('ix_transaction_attachments_tx_user', 'transaction_attachments', ['transaction_id', 'user_id'])


def downgrade() -> None:
    op.drop_index('ix_transaction_attachments_tx_user', table_name='transaction_attachments')
    op.drop_index('ix_transaction_attachments_transaction_id', table_name='transaction_attachments')
    op.drop_index('ix_transaction_attachments_user_id', table_name='transaction_attachments')
    op.drop_table('transaction_attachments')
