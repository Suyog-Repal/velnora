"""add_sync_revision_to_transactions

Revision ID: c1f8e4a90b2d
Revises: 7998192abc5a
Create Date: 2026-11-02 21:45:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c1f8e4a90b2d'
down_revision: Union[str, Sequence[str], None] = '7998192abc5a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Create global monotonic sequence for sync revisions
    op.execute("CREATE SEQUENCE IF NOT EXISTS sync_revision_seq START WITH 1 INCREMENT BY 1;")

    # 2. Add sync_revision column with server default nextval('sync_revision_seq')
    op.add_column(
        'transactions',
        sa.Column(
            'sync_revision',
            sa.BigInteger(),
            server_default=sa.text("nextval('sync_revision_seq')"),
            nullable=False,
        )
    )

    # 3. Create indices for fast revision queries and user-scoped revision queries
    op.create_index(op.f('ix_transactions_sync_revision'), 'transactions', ['sync_revision'], unique=False)
    op.create_index('ix_transactions_user_revision', 'transactions', ['user_id', 'sync_revision'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_transactions_user_revision', table_name='transactions')
    op.drop_index(op.f('ix_transactions_sync_revision'), table_name='transactions')
    op.drop_column('transactions', 'sync_revision')
    op.execute("DROP SEQUENCE IF EXISTS sync_revision_seq;")
