"""Index bounded Session message search chunks online.

Revision ID: a4d8c1e7f2b6
Revises: f7c9a2e5d1b4
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a4d8c1e7f2b6"
down_revision: str | Sequence[str] | None = "f7c9a2e5d1b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "session_message_search"
_PRIMARY_KEY = "pk_session_message_search"
_CHUNK_UNIQUE_INDEX = "ux_session_message_search_chunk_identity"
_FTS_INDEX = "ix_session_message_search_content_fts"
_NEXT_FTS_INDEX = "ix_session_message_search_content_fts_chunked"
_MAX_CHUNK_CHARACTERS = 18_000


def _index_validity(name: str) -> bool | None:
    return (
        op.get_bind()
        .execute(
            sa.text("SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass(:index_name)"),
            {"index_name": name},
        )
        .scalar_one_or_none()
    )


def _primary_key_has_chunk_index() -> bool:
    return bool(
        op.get_bind()
        .execute(
            sa.text(
                "SELECT EXISTS ("
                "SELECT 1 FROM pg_constraint constraint_row "
                "JOIN unnest(constraint_row.conkey) AS key(attnum) ON true "
                "JOIN pg_attribute attribute "
                "ON attribute.attrelid = constraint_row.conrelid "
                "AND attribute.attnum = key.attnum "
                "WHERE constraint_row.conrelid = to_regclass(:table_name) "
                "AND constraint_row.contype = 'p' "
                "AND attribute.attname = 'chunk_index'"
                ")"
            ),
            {"table_name": _TABLE},
        )
        .scalar_one()
    )


def _drop_index_concurrently(name: str) -> None:
    if _index_validity(name) is not None:
        with op.get_context().autocommit_block():
            op.drop_index(
                name,
                table_name=_TABLE,
                postgresql_concurrently=True,
            )


def upgrade() -> None:
    op.execute(
        sa.text(
            f"ALTER TABLE {_TABLE} ADD COLUMN IF NOT EXISTS chunk_index integer NOT NULL DEFAULT 0"
        )
    )
    op.execute(
        sa.text(
            "DO $$ BEGIN "
            "IF NOT EXISTS ("
            "SELECT 1 FROM pg_constraint "
            "WHERE conrelid = to_regclass('session_message_search') "
            "AND conname = 'ck_session_message_search_chunk_index'"
            ") THEN "
            f"ALTER TABLE {_TABLE} ADD CONSTRAINT "
            "ck_session_message_search_chunk_index "
            "CHECK (chunk_index >= 0) NOT VALID; "
            "END IF; END $$"
        )
    )

    if not _primary_key_has_chunk_index():
        if _index_validity(_CHUNK_UNIQUE_INDEX) is False:
            _drop_index_concurrently(_CHUNK_UNIQUE_INDEX)
        with op.get_context().autocommit_block():
            op.create_index(
                _CHUNK_UNIQUE_INDEX,
                _TABLE,
                ["session_id", "content_revision", "position", "chunk_index"],
                unique=True,
                postgresql_concurrently=True,
                if_not_exists=True,
            )
        op.execute(
            sa.text(
                f"ALTER TABLE {_TABLE} DROP CONSTRAINT {_PRIMARY_KEY}, "
                f"ADD CONSTRAINT {_PRIMARY_KEY} PRIMARY KEY "
                f"USING INDEX {_CHUNK_UNIQUE_INDEX}"
            )
        )

    if _index_validity(_NEXT_FTS_INDEX) is False:
        _drop_index_concurrently(_NEXT_FTS_INDEX)
    with op.get_context().autocommit_block():
        op.create_index(
            _NEXT_FTS_INDEX,
            _TABLE,
            [
                sa.text(
                    "(CASE WHEN char_length(content) <= "
                    f"{_MAX_CHUNK_CHARACTERS} "
                    "THEN to_tsvector('simple'::regconfig, content) "
                    "ELSE to_tsvector('simple'::regconfig, ''::text) END)"
                )
            ],
            postgresql_using="gin",
            postgresql_concurrently=True,
            if_not_exists=True,
        )
    _drop_index_concurrently(_FTS_INDEX)
    op.execute(sa.text(f"ALTER INDEX {_NEXT_FTS_INDEX} RENAME TO {_FTS_INDEX}"))


def downgrade() -> None:
    # Search rows are a rebuildable S3 projection. Disable and clear them so an
    # old application never evaluates an unbounded tsvector after the schema
    # returns to one row per message.
    op.execute(sa.text("UPDATE sessions SET search_index_revision = NULL"))
    op.execute(sa.text("UPDATE session_event_chunks SET search_indexed_at = NULL"))
    op.execute(sa.text(f"DELETE FROM {_TABLE}"))
    _drop_index_concurrently(_FTS_INDEX)
    op.execute(
        sa.text(
            f"ALTER TABLE {_TABLE} DROP CONSTRAINT {_PRIMARY_KEY}, "
            f"ADD CONSTRAINT {_PRIMARY_KEY} PRIMARY KEY "
            "(session_id, content_revision, position)"
        )
    )
    op.execute(
        sa.text(
            f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS ck_session_message_search_chunk_index"
        )
    )
    op.execute(sa.text(f"ALTER TABLE {_TABLE} DROP COLUMN chunk_index"))
