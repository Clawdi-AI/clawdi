from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.session import Session, SessionEventChunk, SessionEventGeneration
from app.models.session_share import SessionShare
from app.models.user import User
from app.services.session_event_retention_worker import SessionEventRetentionWorker

pytestmark = pytest.mark.committed_db


class RecordingFileStore:
    def __init__(self) -> None:
        self.deleted: list[str] = []

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        del key, data, content_type

    async def get(self, key: str) -> bytes:
        raise FileNotFoundError(key)

    async def delete(self, key: str) -> None:
        self.deleted.append(key)

    async def exists(self, key: str) -> bool:
        del key
        return False


def generation(
    session_id: uuid.UUID,
    *,
    status: str,
    created_at: datetime,
) -> SessionEventGeneration:
    return SessionEventGeneration(
        id=uuid.uuid4(),
        session_id=session_id,
        append_id=uuid.uuid4(),
        status=status,
        base_revision=0,
        base_count=0,
        base_head_hash="0" * 64,
        final_count=1,
        final_head_hash="1" * 64,
        created_at=created_at,
        updated_at=created_at,
    )


def chunk(
    session_id: uuid.UUID,
    generation_id: uuid.UUID,
    key: str,
    *,
    created_at: datetime | None = None,
) -> SessionEventChunk:
    activity = created_at or datetime.now(UTC)
    return SessionEventChunk(
        id=uuid.uuid4(),
        session_id=session_id,
        generation_id=generation_id,
        start_seq=0,
        end_seq=0,
        event_count=1,
        base_head_hash="0" * 64,
        result_head_hash="1" * 64,
        content_hash="2" * 64,
        file_key=key,
        created_at=activity,
        updated_at=activity,
    )


@pytest.mark.asyncio
async def test_retention_deletes_only_stale_noncurrent_generations(
    db_session: AsyncSession,
    engine,
    seed_user: User,
) -> None:
    now = datetime.now(UTC)
    session = Session(
        user_id=seed_user.id,
        local_session_id=f"retention-{uuid.uuid4().hex}",
        started_at=now,
        last_activity_at=now,
    )
    db_session.add(session)
    await db_session.flush()

    current = generation(session.id, status="committed", created_at=now - timedelta(days=30))
    current.superseded_at = now - timedelta(days=20)
    superseded = generation(session.id, status="committed", created_at=now - timedelta(days=30))
    superseded.superseded_at = now - timedelta(days=8)
    abandoned = generation(session.id, status="staging", created_at=now - timedelta(days=2))
    recent = generation(session.id, status="staging", created_at=now)
    recent.base_revision = 1
    shared = generation(session.id, status="committed", created_at=now - timedelta(days=30))
    shared.superseded_at = now - timedelta(days=8)
    db_session.add_all([current, superseded, abandoned, recent, shared])
    await db_session.flush()
    session.content_protocol = "events-v1"
    session.event_generation_id = current.id
    session.event_revision = 1
    session.event_count = 1
    session.event_head_hash = current.final_head_hash
    db_session.add_all(
        [
            chunk(session.id, superseded.id, "events/superseded.ndjson"),
            chunk(
                session.id,
                abandoned.id,
                "events/abandoned.ndjson",
                created_at=abandoned.created_at,
            ),
            chunk(session.id, shared.id, "events/shared.ndjson"),
            SessionShare(
                session_id=session.id,
                created_by=seed_user.id,
                scope="session",
                end_position=0,
                source_protocol="events-v1",
                source_revision=shared.final_head_hash,
                event_generation_id=shared.id,
                event_count=shared.final_count,
                public_metadata={
                    "title": "Shared generation",
                    "agent_type": None,
                    "model": None,
                    "started_at": now.isoformat(),
                    "message_count": 1,
                },
            ),
        ]
    )
    await db_session.commit()
    try:
        store = RecordingFileStore()
        worker = SessionEventRetentionWorker(
            async_sessionmaker(engine, expire_on_commit=False),
            file_store=store,
        )
        deleted = {await worker.run_once(now=now), await worker.run_once(now=now)}

        assert deleted == {superseded.id, abandoned.id}
        assert await worker.run_once(now=now) is None
        assert set(store.deleted) == {"events/superseded.ndjson", "events/abandoned.ndjson"}

        remaining = set(
            await db_session.scalars(
                select(SessionEventGeneration.id).where(
                    SessionEventGeneration.session_id == session.id
                )
            )
        )
        assert remaining == {current.id, recent.id, shared.id}

        share = (
            await db_session.execute(
                select(SessionShare).where(SessionShare.event_generation_id == shared.id)
            )
        ).scalar_one()
        share.revoked_at = now
        await db_session.commit()
        assert await worker.run_once(now=now) == shared.id
        assert "events/shared.ndjson" in store.deleted
    finally:
        await db_session.delete(session)
        await db_session.commit()


@pytest.mark.asyncio
async def test_retention_reclaims_obsolete_bases_and_preserves_active_uploads(
    db_session: AsyncSession,
    engine,
    seed_user: User,
) -> None:
    now = datetime.now(UTC)
    session = Session(
        user_id=seed_user.id,
        local_session_id=f"staging-retention-{uuid.uuid4().hex}",
        started_at=now,
        last_activity_at=now,
        event_revision=5,
    )
    db_session.add(session)
    await db_session.flush()

    obsolete = generation(session.id, status="staging", created_at=now - timedelta(hours=2))
    obsolete.base_revision = 4
    locked = generation(session.id, status="staging", created_at=now - timedelta(hours=2))
    locked.base_revision = 4
    active = generation(session.id, status="staging", created_at=now - timedelta(days=2))
    active.base_revision = 5
    active.updated_at = now
    legacy_active = generation(session.id, status="staging", created_at=now - timedelta(days=2))
    legacy_active.base_revision = 5
    recent = generation(session.id, status="staging", created_at=now)
    recent.base_revision = 4
    abandoned = generation(session.id, status="staging", created_at=now - timedelta(days=2))
    abandoned.base_revision = 5
    current = generation(session.id, status="committed", created_at=now)
    current.base_revision = 4
    superseded = generation(session.id, status="committed", created_at=now)
    superseded.superseded_at = now
    db_session.add_all(
        [obsolete, locked, active, legacy_active, recent, abandoned, current, superseded]
    )
    await db_session.flush()
    session.event_generation_id = current.id
    db_session.add_all(
        [
            chunk(
                session.id, obsolete.id, "events/obsolete.ndjson", created_at=obsolete.created_at
            ),
            chunk(session.id, locked.id, "events/locked.ndjson", created_at=locked.created_at),
            chunk(session.id, legacy_active.id, "events/active.ndjson"),
        ]
    )
    await db_session.commit()
    try:
        store = RecordingFileStore()
        sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
        worker = SessionEventRetentionWorker(sessionmaker, file_store=store)
        async with sessionmaker() as uploading:
            await uploading.execute(
                select(SessionEventGeneration)
                .where(SessionEventGeneration.id == locked.id)
                .with_for_update()
            )
            assert {await worker.run_once(now=now), await worker.run_once(now=now)} == {
                obsolete.id,
                abandoned.id,
            }
            assert await worker.run_once(now=now) is None
            assert store.deleted == ["events/obsolete.ndjson"]
            await uploading.rollback()

        assert await worker.run_once(now=now) == locked.id
        assert await worker.run_once(now=now) is None
        remaining = set(
            await db_session.scalars(
                select(SessionEventGeneration.id).where(
                    SessionEventGeneration.session_id == session.id
                )
            )
        )
        assert remaining == {active.id, legacy_active.id, recent.id, current.id, superseded.id}
        assert store.deleted == ["events/obsolete.ndjson", "events/locked.ndjson"]
    finally:
        await db_session.delete(session)
        await db_session.commit()


@pytest.mark.asyncio
async def test_absolute_staging_cap_overrides_fresh_activity_but_preserves_current_and_shared(
    db_session: AsyncSession, engine, seed_user: User
) -> None:
    now = datetime.now(UTC)
    session = Session(
        user_id=seed_user.id,
        local_session_id=f"absolute-cap-{uuid.uuid4().hex}",
        started_at=now,
        last_activity_at=now,
    )
    db_session.add(session)
    await db_session.flush()
    old = now - timedelta(days=2, seconds=1)
    heartbeat = generation(session.id, status="staging", created_at=old)
    heartbeat.updated_at = now
    fresh_chunk = generation(session.id, status="staging", created_at=old)
    under_cap = generation(session.id, status="staging", created_at=now - timedelta(hours=39))
    under_cap.updated_at = now
    current = generation(session.id, status="staging", created_at=old)
    shared = generation(session.id, status="staging", created_at=old)
    db_session.add_all([heartbeat, fresh_chunk, under_cap, current, shared])
    await db_session.flush()
    session.event_generation_id = current.id
    db_session.add_all(
        [
            chunk(session.id, fresh_chunk.id, "events/expired-fresh-chunk.ndjson", created_at=now),
            SessionShare(
                session_id=session.id,
                created_by=seed_user.id,
                scope="session",
                end_position=0,
                source_protocol="events-v1",
                source_revision=shared.final_head_hash,
                event_generation_id=shared.id,
                event_count=1,
                public_metadata={"title": "Shared generation"},
            ),
        ]
    )
    await db_session.commit()
    try:
        store = RecordingFileStore()
        worker = SessionEventRetentionWorker(
            async_sessionmaker(engine, expire_on_commit=False), file_store=store
        )
        assert {await worker.run_once(now=now), await worker.run_once(now=now)} == {
            heartbeat.id,
            fresh_chunk.id,
        }
        assert await worker.run_once(now=now) is None
        assert store.deleted == ["events/expired-fresh-chunk.ndjson"]
        remaining = set(
            await db_session.scalars(
                select(SessionEventGeneration.id).where(
                    SessionEventGeneration.session_id == session.id
                )
            )
        )
        assert remaining == {under_cap.id, current.id, shared.id}
    finally:
        await db_session.delete(session)
        await db_session.commit()
