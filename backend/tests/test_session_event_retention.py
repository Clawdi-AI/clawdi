from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.session import Session, SessionEventChunk, SessionEventGeneration
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
    )


def chunk(session_id: uuid.UUID, generation_id: uuid.UUID, key: str) -> SessionEventChunk:
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
    db_session.add_all([current, superseded, abandoned, recent])
    await db_session.flush()
    session.content_protocol = "events-v1"
    session.event_generation_id = current.id
    session.event_revision = 1
    session.event_count = 1
    session.event_head_hash = current.final_head_hash
    db_session.add_all(
        [
            chunk(session.id, superseded.id, "events/superseded.ndjson"),
            chunk(session.id, abandoned.id, "events/abandoned.ndjson"),
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
        assert remaining == {current.id, recent.id}
    finally:
        await db_session.delete(session)
        await db_session.commit()
