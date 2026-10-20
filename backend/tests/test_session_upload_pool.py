"""Real PostgreSQL requests must make progress while object writes are blocked."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

import httpx
import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlalchemy.pool import QueuePool

from app.core import auth, database
from app.core.config import settings
from app.main import app
from app.models.api_key import ApiKey
from app.models.session import Session, SessionEventChunk
from app.routes import session_events, sessions, sync
from app.services import distributed_state
from app.services.api_key import mint_api_key
from app.services.file_store import FileStore
from app.services.file_store_s3 import S3ObjectStoreError
from app.services.runtime_source import (
    RUNTIME_AGENT_PLUGIN_GITHUB_RELEASE_SOURCE_CAPABILITY,
    RUNTIME_AGENT_PLUGINS_MANIFEST_CAPABILITY,
    RUNTIME_BUNDLE_V2_MEDIA_TYPE,
    RUNTIME_CAPABILITIES_HEADER,
)
from app.services.session_events import EMPTY_EVENT_HEAD, advance_event_head
from tests.conftest import create_env_with_project, create_test_hosted_runtime_state
from tests.hosted_runtime_fixtures import (
    CANONICAL_CODEX_TOOLS,
    ensure_canonical_codex_tool_provider,
)
from tests.test_session_events import _chunk, _commit_generation, _event
from tests.test_sync_events import _connected_request

pytestmark = pytest.mark.committed_db


class _BlockedStore:
    def __init__(self, delegate: FileStore, *, fail: bool):
        self.delegate = delegate
        self.fail = fail
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.writes = 0

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        self.writes += 1
        if self.writes == 4:
            self.started.set()
        await self.release.wait()
        if self.fail:
            raise S3ObjectStoreError("S3 object write failed")
        await self.delegate.put(key, data, content_type)


@pytest.mark.parametrize("path", ["snapshot", "chunk", "append"])
@pytest.mark.parametrize("outcome", ["publish", "storage_failure", "revoked"])
async def test_blocked_uploads_release_pool_and_revalidate_before_publish(
    db_session, seed_user, monkeypatch, path, outcome
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"blocked-upload-{seed_user.id}",
        machine_name="Blocked upload",
        agent_type="openclaw",
    )
    state = await create_test_hosted_runtime_state(db_session, env, runtime_name="openclaw")
    await ensure_canonical_codex_tool_provider(db_session, seed_user)
    state.tools = CANONICAL_CODEX_TOOLS
    minted = await mint_api_key(
        db_session, user_id=seed_user.id, environment_id=env.id, label="blocked-upload"
    )
    env_id = env.id
    key_id = minted.api_key.id
    await db_session.commit()
    headers = {"Authorization": f"Bearer {minted.raw_key}"}
    manifest_headers = {
        "Accept": RUNTIME_BUNDLE_V2_MEDIA_TYPE,
        RUNTIME_CAPABILITIES_HEADER: ",".join(
            (
                RUNTIME_AGENT_PLUGINS_MANIFEST_CAPABILITY,
                RUNTIME_AGENT_PLUGIN_GITHUB_RELEASE_SOURCE_CAPABILITY,
            )
        ),
    }
    monkeypatch.setattr(settings, "db_pool_timeout", 0.3)
    ordinary = database._create_engine(pool_size=2, max_overflow=0)
    factory = async_sessionmaker(
        ordinary, class_=database.async_session_factory.class_, expire_on_commit=False
    )
    monkeypatch.setattr(database, "engine", ordinary)
    for module in (database, sync, distributed_state):
        monkeypatch.setattr(module, "async_session_factory", factory)
    pool = ordinary.sync_engine.pool
    assert isinstance(pool, QueuePool)
    uploads: list[asyncio.Task[httpx.Response]] = []
    iterator = None
    store = _BlockedStore(sessions.file_store, fail=outcome == "storage_failure")
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test", headers=headers
        ) as client:
            local_id = f"blocked-{path}"
            batch = {
                "sessions": [
                    {
                        "environment_id": str(env_id),
                        "local_session_id": local_id,
                        "started_at": datetime.now(UTC).isoformat(),
                        "content_protocol": "snapshot-v1" if path == "snapshot" else "events-v1",
                    }
                ]
            }
            created = await client.post("/v1/sessions/batch", json=batch)
            assert created.status_code == 200, created.text
            event = _event(
                0, "message", "first", role="user", parts=[{"type": "text", "text": "first"}]
            )
            if path == "snapshot":
                url = f"/v1/sessions/{local_id}/upload"
                data = {"environment_id": str(env_id)}
                body = b'[{"role":"user","content":"snapshot"}]'
            elif path == "chunk":
                generation = str(uuid.uuid4())
                staged = await client.post(
                    f"/v1/sessions/{local_id}/events/generations",
                    json={
                        "environment_id": str(env_id),
                        "generation": generation,
                        "append_id": str(uuid.uuid4()),
                        "base_generation": None,
                        "base_revision": 0,
                        "base_count": 0,
                        "base_head_hash": EMPTY_EVENT_HEAD,
                        "final_count": 1,
                        "final_head_hash": advance_event_head(EMPTY_EVENT_HEAD, [event]),
                    },
                )
                assert staged.status_code == 200, staged.text
                body, content_hash = _chunk([event])
                url = f"/v1/sessions/{local_id}/events/generations/{generation}/chunks/0"
                data = {"base_head_hash": EMPTY_EVENT_HEAD, "content_hash": content_hash}
            else:
                generation, head, _ = await _commit_generation(
                    client, environment_id=str(env_id), local_session_id=local_id, events=[event]
                )
                event = _event(
                    1, "message", "second", role="user", parts=[{"type": "text", "text": "second"}]
                )
                body, content_hash = _chunk([event])
                url = f"/v1/sessions/{local_id}/events/append"
                data = {
                    "environment_id": str(env_id),
                    "append_id": str(uuid.uuid4()),
                    "generation": generation,
                    "base_revision": "1",
                    "base_count": "1",
                    "base_head_hash": head,
                    "final_count": "2",
                    "final_head_hash": advance_event_head(head, [event]),
                    "content_hash": content_hash,
                }
            await db_session.close()
            monkeypatch.setattr(sessions, "file_store", store)
            monkeypatch.setattr(session_events, "file_store", store)

            async def upload():
                return await client.request(
                    "PUT" if path == "chunk" else "POST",
                    url,
                    data=data,
                    files={"file": ("content", body, "application/octet-stream")},
                )

            uploads = [asyncio.create_task(upload()) for _ in range(4)]
            async with asyncio.timeout(10):
                await store.started.wait()
                assert pool.checkedout() == 0
                # Batch touches the SAME Session row that the uploads used to
                # lock for the entire remote write, rather than an unrelated row.
                assert (await client.post("/v1/sessions/batch", json=batch)).status_code == 200
                manifest = await client.get("/v1/runtime/manifest", headers=manifest_headers)
                assert manifest.status_code == 200, manifest.text
                assert (await client.get("/v1/sessions")).status_code == 200
                async with factory() as db:
                    context = await auth._auth_via_api_key(minted.raw_key, db)
                assert context is not None
                stream = await sync.events(_connected_request(), context, None)
                iterator = stream.body_iterator.__aiter__()
                assert await anext(iterator) == b": connected\n\n"
                assert pool.checkedout() == 0
                lease_id = await db_session.scalar(
                    select(distributed_state.SyncSubscriptionLease.id).where(
                        distributed_state.SyncSubscriptionLease.user_id == seed_user.id
                    )
                )
                assert lease_id is not None
                assert await sync.refresh_sync_subscription_lease(
                    lease_id, ttl=sync.SUBSCRIPTION_LEASE_TTL
                )
                await db_session.rollback()
                if outcome == "revoked":
                    await db_session.execute(
                        update(ApiKey)
                        .where(ApiKey.id == key_id)
                        .values(revoked_at=datetime.now(UTC))
                    )
                    await db_session.commit()
                store.release.set()
                responses = await asyncio.gather(*uploads)
            if outcome == "publish":
                assert sum(response.status_code == 200 for response in responses) >= 1
                assert all(response.status_code in {200, 409} for response in responses)
            else:
                assert all(
                    response.status_code == (503 if outcome == "storage_failure" else 401)
                    for response in responses
                )
                row = (
                    await db_session.execute(
                        select(Session).where(
                            Session.user_id == seed_user.id, Session.local_session_id == local_id
                        )
                    )
                ).scalar_one()
                assert row.file_key is None
                assert row.event_count == (1 if path == "append" else 0)
                if path == "chunk":
                    assert not (
                        await db_session.execute(
                            select(SessionEventChunk.id).where(
                                SessionEventChunk.session_id == row.id
                            )
                        )
                    ).first()
                if outcome == "storage_failure":
                    for response in responses:
                        assert response.json() == {
                            "detail": "Object storage temporarily unavailable"
                        }
                        assert response.headers["Retry-After"] == "1"
                    store.fail = False
                    # A failed storage call left no published state; the exact
                    # request can safely finish and be retried after recovery.
                    retry = await upload()
                    assert retry.status_code == 200, retry.text
                    if path != "snapshot":
                        replay = await upload()
                        assert replay.status_code == 200, replay.text
                        assert replay.json() == retry.json()
    finally:
        store.release.set()
        for task in uploads:
            if not task.done():
                task.cancel()
        await asyncio.gather(*uploads, return_exceptions=True)
        if iterator is not None:
            await iterator.aclose()
        await ordinary.dispose()
