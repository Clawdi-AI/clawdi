from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime

import httpx
import pytest
from fastapi import Request
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.auth import AuthContext, get_auth
from app.main import app
from app.models.api_key import ApiKey
from app.models.memory import Memory
from app.models.session import Session, SessionSyncSuppression
from app.models.session_permission import PERMISSION_KIND_LINK, SessionPermission
from app.routes.memories import attach_source_machines
from app.schemas.session import SessionBatchRequest
from app.services.file_store import FileStore


class _ControlledDeleteFileStore:
    def __init__(
        self,
        delegate: FileStore,
        *,
        fail: bool = False,
        started: asyncio.Event | None = None,
        release: asyncio.Event | None = None,
    ) -> None:
        self._delegate = delegate
        self._fail = fail
        self._started = started
        self._release = release

    async def delete(self, key: str) -> None:
        if self._started is not None:
            self._started.set()
        if self._release is not None:
            await self._release.wait()
        if self._fail:
            raise RuntimeError("test storage failure")
        await self._delegate.delete(key)


async def _create_session(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    local_session_id: str,
    environment_id: uuid.UUID | None = None,
    file_key: str | None = None,
) -> Session:
    now = datetime.now(UTC)
    session = Session(
        user_id=user_id,
        environment_id=environment_id,
        local_session_id=local_session_id,
        started_at=now,
        last_activity_at=now,
        file_key=file_key,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


async def _is_suppressed(db: AsyncSession, user_id: uuid.UUID, local_id: str) -> bool:
    return await db.get(SessionSyncSuppression, (user_id, local_id)) is not None


async def _register_env(client: httpx.AsyncClient) -> uuid.UUID:
    response = await client.post(
        "/v1/environments",
        json={
            "machine_id": f"session-delete-{uuid.uuid4().hex}",
            "machine_name": "Session deletion test",
            "agent_type": "claude-code",
            "agent_version": "test",
            "os": "linux",
        },
    )
    assert response.status_code == 200, response.text
    return uuid.UUID(response.json()["id"])


def _batch_body(environment_id: uuid.UUID, local_session_ids: list[str]) -> SessionBatchRequest:
    now = datetime.now(UTC)
    return SessionBatchRequest(
        sessions=[
            {
                "environment_id": environment_id,
                "local_session_id": local_session_id,
                "started_at": now,
                "message_count": 1,
                "content_hash": chr(97 + index) * 64,
            }
            for index, local_session_id in enumerate(local_session_ids)
        ]
    )


@pytest.mark.asyncio
async def test_delete_session_is_durable_and_preserves_memories(
    client: httpx.AsyncClient,
    anon_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
) -> None:
    from app.routes import sessions as sessions_route

    environment_id = await _register_env(client)
    local_session_id = f"z-delete-{uuid.uuid4().hex}"
    content_key = f"sessions/{seed_user.id}/{local_session_id}.json"
    await sessions_route.file_store.put(content_key, b"[]")
    session = await _create_session(
        db_session,
        user_id=seed_user.id,
        environment_id=environment_id,
        local_session_id=local_session_id,
        file_key=None,
    )
    permission = SessionPermission(
        session_id=session.id,
        kind=PERMISSION_KIND_LINK,
        role="viewer",
        invited_by=seed_user.id,
        accepted_at=datetime.now(UTC),
    )
    memory = Memory(
        user_id=seed_user.id,
        content="Keep this extracted memory",
        source="session",
        source_session_id=session.id,
    )
    db_session.add_all([permission, memory])
    await db_session.commit()
    session_id = session.id
    permission_id = permission.id
    memory_id = memory.id
    assert (await anon_client.get(f"/v1/public/sessions/{session_id}")).status_code == 200

    dashboard_auth = app.dependency_overrides[get_auth]

    async def cli_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=ApiKey(user_id=seed_user.id))

    app.dependency_overrides[get_auth] = cli_auth
    try:
        assert (await client.delete(f"/v1/sessions/{session_id}")).status_code == 403
    finally:
        app.dependency_overrides[get_auth] = dashboard_auth

    response = await client.delete(f"/v1/sessions/{session_id}")

    assert response.status_code == 204
    assert not await sessions_route.file_store.exists(content_key)
    assert (
        await db_session.scalar(
            select(SessionPermission.id).where(SessionPermission.id == permission_id)
        )
        is None
    )
    preserved_memory = (
        await db_session.execute(
            select(Memory.content, Memory.source_session_id).where(Memory.id == memory_id)
        )
    ).one()
    assert preserved_memory == ("Keep this extracted memory", None)
    assert await _is_suppressed(db_session, seed_user.id, local_session_id)
    assert (await anon_client.get(f"/v1/public/sessions/{session_id}")).status_code == 404

    second_suppressed_id = f"a-delete-{uuid.uuid4().hex}"
    db_session.add(
        SessionSyncSuppression(
            user_id=seed_user.id,
            local_session_id=second_suppressed_id,
        )
    )
    await db_session.commit()

    batch = await client.post(
        "/v1/sessions/batch",
        json=_batch_body(
            environment_id,
            [local_session_id, second_suppressed_id, local_session_id],
        ).model_dump(mode="json"),
    )
    assert batch.status_code == 200, batch.text
    assert batch.json() == {
        "created": 0,
        "updated": 0,
        "unchanged": 0,
        "needs_content": [],
        "rejected": [],
        "suppressed": [local_session_id, second_suppressed_id],
    }
    assert await db_session.get(Session, session_id) is None


@pytest.mark.asyncio
async def test_delete_session_storage_failure_is_retryable(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    from app.routes import sessions as sessions_route

    user_id = seed_user.id
    local_session_id = f"cleanup-failure-{uuid.uuid4().hex}"
    content_key = f"sessions/{user_id}/{local_session_id}.json"
    file_store = sessions_route.file_store
    await file_store.put(content_key, b"private transcript")
    session = await _create_session(
        db_session,
        user_id=user_id,
        local_session_id=local_session_id,
        file_key=content_key,
    )
    store = _ControlledDeleteFileStore(file_store, fail=True)
    monkeypatch.setattr(sessions_route, "file_store", store)
    caplog.set_level(logging.ERROR, logger="app.routes.sessions")

    session_id = session.id
    response = await client.delete(f"/v1/sessions/{session_id}")

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Session storage is temporarily unavailable. Please retry."
    }
    assert "test storage failure" not in response.text
    assert "session_content_delete_failed" in caplog.text
    assert await db_session.scalar(select(Session.id).where(Session.id == session_id)) == session_id
    assert not await _is_suppressed(db_session, user_id, local_session_id)
    assert await file_store.exists(content_key)


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_delete_serializes_batch_before_suppression_check(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    engine,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.routes import sessions as sessions_route

    environment_id = await _register_env(client)
    local_session_id = f"concurrent-{uuid.uuid4().hex}"
    session = await _create_session(
        db_session,
        user_id=seed_user.id,
        environment_id=environment_id,
        local_session_id=local_session_id,
    )
    delete_started = asyncio.Event()
    release_delete = asyncio.Event()
    batch_lock_started = asyncio.Event()
    store = _ControlledDeleteFileStore(
        sessions_route.file_store,
        started=delete_started,
        release=release_delete,
    )
    monkeypatch.setattr(sessions_route, "file_store", store)

    def observe_lock_statement(_connection, _cursor, statement: str, *_args) -> None:
        if "FROM sessions" in statement and "FOR UPDATE" in statement:
            batch_lock_started.set()

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    auth = AuthContext(user=seed_user)
    async with session_factory() as delete_db, session_factory() as batch_db:
        delete_task = asyncio.create_task(
            sessions_route.delete_session(session.id, auth=auth, db=delete_db)
        )
        await asyncio.wait_for(delete_started.wait(), timeout=5)
        event.listen(engine.sync_engine, "before_cursor_execute", observe_lock_statement)
        try:
            batch_task = asyncio.create_task(
                sessions_route.batch_create_sessions(
                    _batch_body(environment_id, [local_session_id]),
                    Request({"type": "http", "headers": []}),
                    auth=auth,
                    db=batch_db,
                )
            )
            await asyncio.wait_for(batch_lock_started.wait(), timeout=5)
            assert not batch_task.done()
            release_delete.set()
            await delete_task
            batch_result = await batch_task
        finally:
            release_delete.set()
            event.remove(engine.sync_engine, "before_cursor_execute", observe_lock_statement)

    assert batch_result.suppressed == [local_session_id]
    assert batch_result.created == 0
    async with session_factory() as verify_db:
        assert await verify_db.get(Session, session.id) is None
        assert await _is_suppressed(verify_db, seed_user.id, local_session_id)


@pytest.mark.asyncio
async def test_memory_enrichment_clears_unresolvable_external_session_provenance(
    db_session: AsyncSession,
    seed_user,
) -> None:
    stale_session_id = uuid.uuid4()
    item = {
        "content": "External memory",
        "source_session_id": str(stale_session_id),
        "source_environment_id": None,
    }

    enriched = await attach_source_machines(db_session, AuthContext(user=seed_user), [item])

    assert enriched[0]["source_session_id"] is None
    assert enriched[0]["content"] == "External memory"
