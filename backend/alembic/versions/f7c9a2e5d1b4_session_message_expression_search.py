"""Build Session message full-text search without rewriting the table.

Revision ID: f7c9a2e5d1b4
Revises: e4b8c2d6f1a9
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f7c9a2e5d1b4"
down_revision: str | Sequence[str] | None = "e4b8c2d6f1a9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_EXPRESSION_INDEX = "ix_session_message_search_content_fts"


def _expression_index_is_invalid() -> bool:
    valid = op.get_bind().execute(
        sa.text(
            "SELECT indisvalid FROM pg_index "
            "WHERE indexrelid = to_regclass(:index_name)"
        ),
        {"index_name": _EXPRESSION_INDEX},
    ).scalar_one_or_none()
    return valid is False


def upgrade() -> None:
    invalid_expression_index = _expression_index_is_invalid()
    with op.get_context().autocommit_block():
        if invalid_expression_index:
            op.drop_index(
                _EXPRESSION_INDEX,
                table_name="session_message_search",
                postgresql_concurrently=True,
            )
        op.create_index(
            _EXPRESSION_INDEX,
            "session_message_search",
            [sa.text("to_tsvector('simple'::regconfig, content)")],
            postgresql_using="gin",
            postgresql_concurrently=True,
            if_not_exists=True,
        )


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.drop_index(
            _EXPRESSION_INDEX,
            table_name="session_message_search",
            postgresql_concurrently=True,
            if_exists=True,
        )
