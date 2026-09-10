from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import delete, select

from app.core.auth import AuthContext
from app.models.api_key import ApiKey
from app.models.distributed_state import SyncSubscriptionLease
from app.models.session import Session
from app.models.user import User
from app.routes.session_content_events import _read_version, session_content_events
from app.services import sync_events
from app.services.session_content_notifications import (
    notify_session_content_changed,
    session_content_changed,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.committed_db]


async def test_notifications_commit_rollback_and_listener_recovery(db_session):
    first_id, second_id = uuid4(), uuid4()
    await sync_events.start_postgres_listener()
    first = session_content_changed.subscribe(str(first_id))
    second = None
    try:
        await notify_session_content_changed(db_session, first_id)
        assert not first.is_set()
        await db_session.commit()
        await asyncio.wait_for(first.wait(), 2)
        first.clear()
        await notify_session_content_changed(db_session, first_id)
        await db_session.rollback()
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(first.wait(), 0.1)
        # Commits made while LISTEN is unavailable must be reconciled by both
        # existing watchers and watchers that subscribed during the outage.
        await sync_events.stop_postgres_listener()
        second = session_content_changed.subscribe(str(second_id))
        await notify_session_content_changed(db_session, first_id)
        await notify_session_content_changed(db_session, second_id)
        await db_session.commit()
        await sync_events.start_postgres_listener()
        await asyncio.wait_for(first.wait(), 2)
        await asyncio.wait_for(second.wait(), 2)
    finally:
        session_content_changed.unsubscribe(str(first_id), first)
        if second is not None:
            session_content_changed.unsubscribe(str(second_id), second)
        await sync_events.stop_postgres_listener()


async def make_session_key(db, user):
    session = Session(user_id=user.id, local_session_id=uuid4().hex, started_at=datetime.now(UTC))
    token = f"clawdi_{uuid4().hex}"
    key = ApiKey(
        user_id=user.id,
        key_hash=hashlib.sha256(token.encode()).hexdigest(),
        key_prefix=token[:16],
        label="content stream fixture",
        scopes=["sessions:read"],
    )
    db.add_all([session, key])
    await db.commit()
    return session, key, HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


async def test_content_authority_and_readiness(db_session, seed_user, environment_project):
    session, key, credentials = await make_session_key(db_session, seed_user)
    session.content_hash = "a" * 64
    await db_session.commit()
    version, _ = await _read_version(session.id, credentials, seed_user.id)
    assert not version.has_content  # Metadata hash is not evidence of upload.
    session.file_key = "test-content.json"
    await db_session.commit()
    ready, _ = await _read_version(session.id, credentials, seed_user.id)
    assert ready.has_content and ready.content_hash == version.content_hash
    other = User(clerk_id=f"test_{uuid4().hex}", email="other@example.test", name="Other owner")
    db_session.add(other)
    await db_session.commit()
    try:
        _, _, other_credentials = await make_session_key(db_session, other)
        with pytest.raises(HTTPException) as denied:
            await _read_version(session.id, other_credentials, other.id)
        assert denied.value.status_code == 404
    finally:
        await db_session.execute(delete(User).where(User.id == other.id))
        await db_session.commit()
    from app.models.session import AgentEnvironment

    environment_id = await db_session.scalar(
        select(AgentEnvironment.id).where(
            AgentEnvironment.default_project_id == environment_project.id
        )
    )
    key.environment_id = environment_id
    await db_session.commit()
    with pytest.raises(HTTPException) as bound:
        await _read_version(session.id, credentials, seed_user.id)
    assert bound.value.status_code == 404
    key.revoked_at = datetime.now(UTC)
    await db_session.commit()
    with pytest.raises(HTTPException) as revoked:
        await _read_version(session.id, credentials, seed_user.id)
    assert revoked.value.status_code == 401


async def test_stream_header_failure_releases_lease(db_session, seed_user):
    session, key, credentials = await make_session_key(db_session, seed_user)
    response = await session_content_events(session.id, credentials, AuthContext(seed_user, key))

    async def failed_send(message):
        raise OSError("client disconnected before headers")

    with pytest.raises(OSError):
        await response.stream_response(failed_send)
    assert (
        await db_session.scalar(
            select(SyncSubscriptionLease.id).where(SyncSubscriptionLease.user_id == seed_user.id)
        )
        is None
    )


async def test_credential_deadline_cancels_backpressure_and_releases_lease(db_session, seed_user):
    session, key, credentials = await make_session_key(db_session, seed_user)
    key.expires_at = datetime.now(UTC) + timedelta(seconds=1)
    await db_session.commit()
    response = await session_content_events(session.id, credentials, AuthContext(seed_user, key))
    sent = asyncio.Event()

    async def blocked_send(message):
        sent.set()
        await asyncio.Event().wait()

    await asyncio.wait_for(response.stream_response(blocked_send), 3)
    assert sent.is_set()
    assert (
        await db_session.scalar(
            select(SyncSubscriptionLease.id).where(SyncSubscriptionLease.user_id == seed_user.id)
        )
        is None
    )


async def test_lost_lease_interrupts_blocked_send(db_session, seed_user, monkeypatch):
    from app.routes import session_content_events as route

    session, key, credentials = await make_session_key(db_session, seed_user)
    response = await session_content_events(session.id, credentials, AuthContext(seed_user, key))
    sending = asyncio.Event()

    async def lost_lease(lease_id, closed):
        await sending.wait()
        closed.set()

    async def blocked_send(message):
        sending.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(route, "_refresh_subscription_lease", lost_lease)
    await asyncio.wait_for(response.stream_response(blocked_send), 2)
    assert (
        await db_session.scalar(
            select(SyncSubscriptionLease.id).where(SyncSubscriptionLease.user_id == seed_user.id)
        )
        is None
    )


async def test_legacy_snapshot_discovers_byte_identity_without_empty_hash_cache(tmp_path):
    from app.services.file_store import LocalFileStore
    from app.services.session_content import load_snapshot_projection

    store = LocalFileStore(str(tmp_path))
    key = f"{uuid4()}.json"
    for content in (
        b'[{"role":"user","content":"first"}]',
        b'[{"role":"user","content":"rewritten"}]',
    ):
        await store.put(key, content)
        projection = await load_snapshot_projection(key, "", store)
        assert projection.content_revision == f"snapshot:{hashlib.sha256(content).hexdigest()}"
