from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime
from io import BytesIO

import httpx
import pytest
from fastapi import UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.auth import AuthContext, get_auth
from app.main import app
from app.models.api_key import ApiKey
from app.models.memory import Memory
from app.models.session import Session
from app.models.session_permission import PERMISSION_KIND_LINK, SessionPermission
from app.routes.memories import attach_source_machines
from app.services.file_store import FileStore


class _DeleteTrackingFileStore:
    def __init__(self, delegate: FileStore, *, fail_delete: bool = False) -> None:
        self._delegate = delegate
        self._fail_delete = fail_delete
        self.deleted: list[str] = []

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        await self._delegate.put(key, data, content_type)

    async def get(self, key: str) -> bytes:
        return await self._delegate.get(key)

    async def delete(self, key: str) -> None:
        self.deleted.append(key)
        if self._fail_delete:
            raise RuntimeError("test file-store delete failure")
        await self._delegate.delete(key)

    async def exists(self, key: str) -> bool:
        return await self._delegate.exists(key)


class _BlockingPutFileStore(_DeleteTrackingFileStore):
    def __init__(
        self,
        delegate: FileStore,
        *,
        put_started: asyncio.Event,
        release_put: asyncio.Event,
    ) -> None:
        super().__init__(delegate)
        self._put_started = put_started
        self._release_put = release_put

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        self._put_started.set()
        await self._release_put.wait()
        await super().put(key, data, content_type)


async def _create_session(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    local_session_id: str,
    file_key: str | None = None,
) -> Session:
    now = datetime.now(UTC)
    session = Session(
        user_id=user_id,
        local_session_id=local_session_id,
        started_at=now,
        last_activity_at=now,
        file_key=file_key,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


async def _register_env(client: httpx.AsyncClient) -> str:
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
    return response.json()["id"]


@pytest.mark.asyncio
async def test_delete_session_requires_dashboard_owner_and_hides_visibility(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
) -> None:
    owned = await _create_session(
        db_session,
        user_id=seed_user.id,
        local_session_id=f"owned-{uuid.uuid4().hex}",
    )
    foreign = await _create_session(
        db_session,
        user_id=uuid.uuid4(),
        local_session_id=f"foreign-{uuid.uuid4().hex}",
    )

    previous_auth = app.dependency_overrides[get_auth]

    async def cli_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=ApiKey(user_id=seed_user.id))

    app.dependency_overrides[get_auth] = cli_auth
    try:
        cli_response = await client.delete(f"/v1/sessions/{owned.id}")
    finally:
        app.dependency_overrides[get_auth] = previous_auth

    assert cli_response.status_code == 403
    assert await db_session.get(Session, owned.id) is not None
    assert (await client.delete(f"/v1/sessions/{foreign.id}")).status_code == 404
    assert (await client.delete(f"/v1/sessions/{uuid.uuid4()}")).status_code == 404


@pytest.mark.asyncio
async def test_delete_session_cascades_permission_clears_memory_and_deletes_content(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
) -> None:
    from app.routes import sessions as sessions_route

    local_session_id = f"delete-{uuid.uuid4().hex}"
    file_key = f"sessions/{seed_user.id}/{local_session_id}.json"
    await sessions_route.file_store.put(file_key, b"[]")
    session = await _create_session(
        db_session,
        user_id=seed_user.id,
        local_session_id=local_session_id,
        file_key=file_key,
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
    permission_id = permission.id
    memory_id = memory.id

    response = await client.delete(f"/v1/sessions/{session.id}")

    assert response.status_code == 204
    assert response.content == b""
    assert await db_session.get(Session, session.id) is None
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
    assert not await sessions_route.file_store.exists(file_key)


@pytest.mark.asyncio
async def test_delete_session_commits_when_content_cleanup_fails(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    from app.routes import sessions as sessions_route

    local_session_id = f"cleanup-failure-{uuid.uuid4().hex}"
    file_key = f"sessions/{seed_user.id}/{local_session_id}.json"
    session = await _create_session(
        db_session,
        user_id=seed_user.id,
        local_session_id=local_session_id,
        file_key=file_key,
    )
    store = _DeleteTrackingFileStore(sessions_route.file_store, fail_delete=True)
    monkeypatch.setattr(sessions_route, "file_store", store)
    caplog.set_level(logging.WARNING, logger="app.routes.sessions")

    response = await client.delete(f"/v1/sessions/{session.id}")

    assert response.status_code == 204
    assert await db_session.get(Session, session.id) is None
    assert set(store.deleted) == {
        file_key,
        f"sessions/{seed_user.id}/{session.id}.json",
    }
    assert "session_content_delete_failed" in caplog.text


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_upload_keys_do_not_reuse_deleted_session_generation(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    engine,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.routes import sessions as sessions_route

    environment_id = await _register_env(client)
    local_session_id = f"generation-{uuid.uuid4().hex}"
    started_at = datetime.now(UTC).isoformat()
    batch = await client.post(
        "/v1/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": environment_id,
                    "local_session_id": local_session_id,
                    "started_at": started_at,
                    "message_count": 1,
                    "content_hash": "a" * 64,
                }
            ]
        },
    )
    assert batch.status_code == 200, batch.text
    first = await db_session.scalar(
        select(Session).where(
            Session.user_id == seed_user.id,
            Session.local_session_id == local_session_id,
        )
    )
    assert first is not None
    legacy_key = f"sessions/{seed_user.id}/{local_session_id}.json"
    await sessions_route.file_store.put(legacy_key, b"old")
    first.file_key = legacy_key
    await db_session.commit()
    store = _DeleteTrackingFileStore(sessions_route.file_store)
    monkeypatch.setattr(sessions_route, "file_store", store)
    first_content = b'[{"role":"user","content":"first"}]'

    first_upload = await client.post(
        f"/v1/sessions/{local_session_id}/upload",
        files={"file": ("session.json", first_content, "application/json")},
    )

    assert first_upload.status_code == 200, first_upload.text
    first_key = first_upload.json()["file_key"]
    assert first_key == f"sessions/{seed_user.id}/{first.id}.json"
    assert store.deleted == [legacy_key]
    assert not await store.exists(legacy_key)

    hash_change = await client.post(
        "/v1/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": environment_id,
                    "local_session_id": local_session_id,
                    "started_at": started_at,
                    "message_count": 2,
                    "content_hash": "f" * 64,
                }
            ]
        },
    )
    assert hash_change.status_code == 200, hash_change.text
    assert await db_session.scalar(select(Session.file_key).where(Session.id == first.id)) is None
    assert await store.exists(first_key)
    assert (await client.delete(f"/v1/sessions/{first.id}")).status_code == 204
    recreate = await client.post(
        "/v1/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": environment_id,
                    "local_session_id": local_session_id,
                    "started_at": started_at,
                    "message_count": 1,
                    "content_hash": "b" * 64,
                }
            ]
        },
    )
    assert recreate.status_code == 200, recreate.text
    second = await db_session.scalar(
        select(Session).where(
            Session.user_id == seed_user.id,
            Session.local_session_id == local_session_id,
        )
    )
    assert second is not None
    second_content = b'[{"role":"user","content":"second"}]'
    second_upload = await client.post(
        f"/v1/sessions/{local_session_id}/upload",
        files={"file": ("session.json", second_content, "application/json")},
    )
    assert second_upload.status_code == 200, second_upload.text
    second_key = second_upload.json()["file_key"]
    assert second.id != first.id
    assert second_key != first_key

    # Simulate delayed cleanup from the first deletion after recreation.
    await store.delete(first_key)
    assert await store.exists(second_key)

    put_started = asyncio.Event()
    release_put = asyncio.Event()
    blocking_store = _BlockingPutFileStore(
        store,
        put_started=put_started,
        release_put=release_put,
    )
    monkeypatch.setattr(sessions_route, "file_store", blocking_store)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    auth = AuthContext(user=seed_user)

    async def reupload() -> str:
        async with session_factory() as upload_db:
            result = await sessions_route.upload_session_content(
                local_session_id=local_session_id,
                file=UploadFile(
                    file=BytesIO(b'[{"role":"user","content":"replacement"}]'),
                    filename="session.json",
                ),
                auth=auth,
                db=upload_db,
            )
            return result.file_key

    async def delete_during_upload() -> None:
        async with session_factory() as delete_db:
            await sessions_route.delete_session(second.id, auth=auth, db=delete_db)

    upload_task = asyncio.create_task(reupload())
    await asyncio.wait_for(put_started.wait(), timeout=5)
    delete_task = asyncio.create_task(delete_during_upload())
    await asyncio.sleep(0.05)
    delete_waited_for_upload = not delete_task.done()
    release_put.set()
    uploaded_key, _ = await asyncio.wait_for(
        asyncio.gather(upload_task, delete_task),
        timeout=10,
    )

    assert delete_waited_for_upload
    assert uploaded_key == second_key
    async with session_factory() as verify_db:
        assert await verify_db.get(Session, second.id) is None
    assert not await blocking_store.exists(second_key)


@pytest.mark.asyncio
async def test_memory_enrichment_clears_unresolvable_external_session_provenance(
    db_session: AsyncSession,
    seed_user,
) -> None:
    stale_session_id = uuid.uuid4()
    item = {
        "id": "mem0-memory",
        "content": "External memory",
        "category": "fact",
        "source": "mem0",
        "source_session_id": str(stale_session_id),
        "source_environment_id": None,
    }

    enriched = await attach_source_machines(db_session, AuthContext(user=seed_user), [item])

    assert enriched[0]["source_session_id"] is None
    assert enriched[0]["content"] == "External memory"
