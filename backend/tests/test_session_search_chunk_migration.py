from __future__ import annotations

import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import DBAPIError

from app.core.config import settings
from app.core.query_utils import websearch_query
from app.models.session import (
    SESSION_SEARCH_CHUNK_MAX_CHARACTERS,
    SESSION_SEARCH_CHUNK_OVERLAP_CHARACTERS,
    SessionMessageSearch,
)
from app.services.session_search import _message_search_document

PREVIOUS_REVISION = "e4b8c2d6f1a9"
CHUNK_REVISION = "a4d8c1e7f2b6"
BACKEND_DIR = Path(__file__).parents[1]


def _sync_url(url: URL, *, database: str) -> URL:
    return url.set(drivername="postgresql+psycopg2", database=database)


def _run(database_url: URL, *args: str) -> None:
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url.render_as_string(hide_password=False)
    subprocess.run(args, cwd=BACKEND_DIR, env=env, check=True)


def _run_alembic(database_url: URL, *args: str) -> None:
    _run(database_url, str(Path(sys.executable).with_name("alembic")), *args)


def test_session_search_chunk_migration_recovers_failed_expression_index() -> None:
    source_url = make_url(os.getenv("DATABASE_URL", settings.database_url))
    database_name = f"clawdi_session_search_chunks_{uuid.uuid4().hex}"
    admin_engine = create_engine(
        _sync_url(source_url, database="postgres"),
        isolation_level="AUTOCOMMIT",
    )
    database_url = source_url.set(database=database_name)
    database_engine = create_engine(_sync_url(source_url, database=database_name))
    user_id = uuid.uuid4()
    session_id = uuid.uuid4()
    revision = "snapshot:" + "a" * 64
    content = " ".join(f"token{index:08x}" for index in range(180_000))

    with admin_engine.connect() as connection:
        connection.execute(text(f'CREATE DATABASE "{database_name}"'))
    try:
        _run_alembic(database_url, "upgrade", PREVIOUS_REVISION)
        with database_engine.begin() as connection:
            connection.execute(
                text("INSERT INTO users (id, clerk_id) VALUES (:id, :clerk_id)"),
                {"id": user_id, "clerk_id": f"search-chunks-{user_id}"},
            )
            connection.execute(
                text(
                    "INSERT INTO sessions "
                    "(id, user_id, local_session_id, started_at, content_hash, "
                    "search_index_revision) "
                    "VALUES (:id, :user_id, 'large-search-session', now(), :hash, :revision)"
                ),
                {
                    "id": session_id,
                    "user_id": user_id,
                    "hash": "a" * 64,
                    "revision": revision,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO session_message_search "
                    "(user_id, session_id, content_revision, position, role, content) "
                    "VALUES (:user_id, :session_id, :revision, 0, 'user', :content)"
                ),
                {
                    "user_id": user_id,
                    "session_id": session_id,
                    "revision": revision,
                    "content": content,
                },
            )

        failing_index_engine = create_engine(
            _sync_url(source_url, database=database_name),
            isolation_level="AUTOCOMMIT",
        )
        try:
            with pytest.raises(DBAPIError, match="string is too long for tsvector"):
                with failing_index_engine.connect() as connection:
                    connection.execute(
                        text(
                            "CREATE INDEX CONCURRENTLY "
                            "ix_session_message_search_content_fts "
                            "ON session_message_search USING gin "
                            "(to_tsvector('simple'::regconfig, content))"
                        )
                    )
        finally:
            failing_index_engine.dispose()

        with database_engine.connect() as connection:
            assert (
                connection.execute(
                    text(
                        "SELECT indisvalid FROM pg_index "
                        "WHERE indexrelid = to_regclass("
                        "'ix_session_message_search_content_fts')"
                    )
                ).scalar_one()
                is False
            )

        _run_alembic(database_url, "upgrade", CHUNK_REVISION)
        _run(
            database_url,
            sys.executable,
            "-m",
            "scripts.backfill_session_search",
            "--all",
            "--chunks-only",
        )

        with database_engine.connect() as connection:
            chunks = list(
                connection.execute(
                    text(
                        "SELECT chunk_index, content FROM session_message_search "
                        "WHERE session_id = :session_id ORDER BY chunk_index"
                    ),
                    {"session_id": session_id},
                )
            )
            assert len(chunks) > 100
            assert [row.chunk_index for row in chunks] == list(range(len(chunks)))
            assert all(len(row.content) <= SESSION_SEARCH_CHUNK_MAX_CHARACTERS for row in chunks)
            reconstructed = chunks[0].content + "".join(
                row.content[SESSION_SEARCH_CHUNK_OVERLAP_CHARACTERS:] for row in chunks[1:]
            )
            assert reconstructed == content
            assert (
                connection.execute(
                    text(
                        "SELECT indisvalid FROM pg_index "
                        "WHERE indexrelid = to_regclass("
                        "'ix_session_message_search_content_fts')"
                    )
                ).scalar_one()
                is True
            )
            search_statement = select(SessionMessageSearch.position).where(
                _message_search_document().op("@@")(websearch_query("token00000001 token00000002"))
            )
            compiled_search = search_statement.compile(
                dialect=database_engine.dialect,
                compile_kwargs={"literal_binds": True},
            )
            connection.execute(text("SET LOCAL enable_seqscan = off"))
            plan = "\n".join(
                row[0] for row in connection.execute(text(f"EXPLAIN {compiled_search}"))
            )
            assert "ix_session_message_search_content_fts" in plan

        _run_alembic(database_url, "downgrade", PREVIOUS_REVISION)
        assert "chunk_index" not in {
            column["name"]
            for column in inspect(database_engine).get_columns("session_message_search")
        }
    finally:
        database_engine.dispose()
        with admin_engine.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)'))
        admin_engine.dispose()
