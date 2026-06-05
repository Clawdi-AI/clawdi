"""Durable queue for XTrace memory ingest work."""

from __future__ import annotations

import asyncio
import json
import logging
import socket
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import settings
from app.core.database import async_session_factory
from app.models.session import Session
from app.models.skill import Skill
from app.models.xtrace_ingest import XTraceMemoryIngest
from app.services.file_store import get_file_store
from app.services.xtrace_ingest_budget import decide_xtrace_user_budget, xtrace_cost_metadata
from app.services.xtrace_ingest_policy import (
    decide_xtrace_session_ingest,
    xtrace_policy_response,
    xtrace_skip_response,
)
from app.services.xtrace_memory import (
    ingest_xtrace_session_memories,
    ingest_xtrace_skill_memories,
    xtrace_memory_configured,
    xtrace_session_source_key,
    xtrace_skill_source_key,
)

log = logging.getLogger(__name__)

_DEFAULT_WORKER_ID = f"{socket.gethostname()}:{uuid4()}"


async def enqueue_xtrace_session_ingest(
    db: AsyncSession,
    *,
    session: Session,
) -> XTraceMemoryIngest | None:
    if not xtrace_memory_configured():
        return None

    source_key = xtrace_session_source_key(session)
    existing = (
        await db.execute(
            select(XTraceMemoryIngest)
            .where(
                XTraceMemoryIngest.source_type == "session",
                XTraceMemoryIngest.source_key == source_key,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    decision = decide_xtrace_session_ingest(session)
    if not decision.should_ingest:
        job = XTraceMemoryIngest(
            user_id=session.user_id,
            source_type="session",
            session_id=session.id,
            local_session_id=session.local_session_id,
            source_key=source_key,
            status="skipped",
            attempt_count=0,
            created_ref_count=0,
            updated_ref_count=0,
            mirrored_count=0,
            response=xtrace_skip_response(decision),
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        return job

    budget = await decide_xtrace_user_budget(
        db,
        user_id=session.user_id,
        requested_messages=decision.estimated_xtrace_messages,
    )
    if budget is not None and not budget.allowed:
        job = XTraceMemoryIngest(
            user_id=session.user_id,
            source_type="session",
            session_id=session.id,
            local_session_id=session.local_session_id,
            source_key=source_key,
            status="skipped",
            attempt_count=0,
            created_ref_count=0,
            updated_ref_count=0,
            mirrored_count=0,
            response=xtrace_skip_response(
                decision,
                reason="budget_exceeded",
                budget=budget.as_response(),
            ),
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        return job

    job = XTraceMemoryIngest(
        user_id=session.user_id,
        source_type="session",
        session_id=session.id,
        local_session_id=session.local_session_id,
        source_key=source_key,
        status="queued",
        attempt_count=0,
        created_ref_count=0,
        updated_ref_count=0,
        mirrored_count=0,
        response={
            "queued_at": datetime.now(UTC).isoformat(),
            "policy": xtrace_policy_response(decision),
            "_clawdi": xtrace_cost_metadata(
                estimated_source_messages=decision.estimated_source_messages,
                estimated_xtrace_messages=decision.estimated_xtrace_messages,
            ),
        },
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


async def enqueue_xtrace_skill_ingest(
    db: AsyncSession,
    *,
    skill: Skill,
) -> XTraceMemoryIngest | None:
    if not xtrace_memory_configured():
        return None

    source_key = xtrace_skill_source_key(skill)
    existing = (
        await db.execute(
            select(XTraceMemoryIngest)
            .where(
                XTraceMemoryIngest.source_type == "skill",
                XTraceMemoryIngest.source_key == source_key,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    job = XTraceMemoryIngest(
        user_id=skill.user_id,
        source_type="skill",
        skill_id=skill.id,
        source_key=source_key,
        status="queued",
        attempt_count=0,
        created_ref_count=0,
        updated_ref_count=0,
        mirrored_count=0,
        response=None,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


async def run_xtrace_ingest_job(
    job_id: UUID,
    *,
    session_factory: async_sessionmaker[AsyncSession] = async_session_factory,
    db: AsyncSession | None = None,
) -> None:
    if db is not None:
        await _run_xtrace_ingest_job_in_session(db, job_id)
        return

    async with session_factory() as session:
        await _run_xtrace_ingest_job_in_session(session, job_id)


async def _run_xtrace_ingest_job_in_session(db: AsyncSession, job_id: UUID) -> None:
    job = await db.get(XTraceMemoryIngest, job_id)
    if job is None:
        log.error("xtrace_ingest_job_missing job_id=%s", job_id)
        return
    if job.status == "queued":
        await _mark_job_claimed(db, job, worker_id=_DEFAULT_WORKER_ID)
    elif job.status not in {"running"}:
        log.info("xtrace_ingest_job_not_active job_id=%s status=%s", job_id, job.status)
        return

    try:
        if job.source_type == "session":
            result = await _run_session_job(db, job)
        elif job.source_type == "skill":
            result = await _run_skill_job(db, job)
        else:
            raise ValueError(f"unsupported XTrace ingest source type: {job.source_type}")
        if result is None:
            job.status = "skipped"
            job.response = job.response or {"skipped_at": datetime.now(UTC).isoformat()}
        job.claimed_at = None
        job.claimed_by = None
        job.error = None
        await db.commit()
    except Exception as exc:
        await db.rollback()
        job = await db.get(XTraceMemoryIngest, job_id)
        if job is not None:
            _schedule_failed_job(job, exc)
            await db.commit()
        log.exception("xtrace_ingest_job_failed job_id=%s", job_id)


async def run_queued_xtrace_ingest_jobs(
    *,
    limit: int = 10,
    session_factory: async_sessionmaker[AsyncSession] = async_session_factory,
    db: AsyncSession | None = None,
) -> int:
    if db is not None:
        jobs = await claim_queued_xtrace_ingest_jobs(db, limit=limit, worker_id=_DEFAULT_WORKER_ID)
        for job in jobs:
            await run_xtrace_ingest_job(job.id, session_factory=session_factory, db=db)
        return len(jobs)

    async with session_factory() as session:
        jobs = await claim_queued_xtrace_ingest_jobs(
            session, limit=limit, worker_id=_DEFAULT_WORKER_ID
        )
        job_ids = [job.id for job in jobs]
    for job_id in job_ids:
        await run_xtrace_ingest_job(job_id, session_factory=session_factory)
    return len(job_ids)


async def claim_queued_xtrace_ingest_jobs(
    db: AsyncSession,
    *,
    limit: int,
    worker_id: str,
) -> list[XTraceMemoryIngest]:
    now = datetime.now(UTC)
    rows = (
        (
            await db.execute(
                select(XTraceMemoryIngest)
                .where(
                    XTraceMemoryIngest.status == "queued",
                    or_(
                        XTraceMemoryIngest.next_attempt_at.is_(None),
                        XTraceMemoryIngest.next_attempt_at <= now,
                    ),
                )
                .order_by(XTraceMemoryIngest.created_at.asc())
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        )
        .scalars()
        .all()
    )
    for job in rows:
        _mark_job_claimed_in_memory(job, worker_id=worker_id, now=now)
    if rows:
        await db.commit()
    return rows


async def _mark_job_claimed(
    db: AsyncSession,
    job: XTraceMemoryIngest,
    *,
    worker_id: str,
) -> None:
    _mark_job_claimed_in_memory(job, worker_id=worker_id, now=datetime.now(UTC))
    await db.commit()


def _mark_job_claimed_in_memory(
    job: XTraceMemoryIngest,
    *,
    worker_id: str,
    now: datetime,
) -> None:
    job.status = "running"
    job.claimed_at = now
    job.claimed_by = worker_id
    job.next_attempt_at = None
    job.error = None
    job.attempt_count = (job.attempt_count or 0) + 1


def _schedule_failed_job(job: XTraceMemoryIngest, exc: Exception) -> None:
    attempts = job.attempt_count or 0
    error = str(exc)[:4000]
    job.error = error
    job.response = {
        **(job.response or {}),
        "error": error,
        "attempt_count": attempts,
        "failed_at": datetime.now(UTC).isoformat(),
    }
    job.claimed_at = None
    job.claimed_by = None
    if attempts >= max(1, settings.xtrace_memory_max_attempts):
        job.status = "failed"
        job.next_attempt_at = None
        return

    delay = settings.xtrace_memory_retry_base_seconds * (2 ** max(0, attempts - 1))
    job.status = "queued"
    job.next_attempt_at = datetime.now(UTC) + timedelta(seconds=max(1.0, delay))


async def run_xtrace_ingest_worker(
    *,
    session_factory: async_sessionmaker[AsyncSession] = async_session_factory,
) -> None:
    while True:
        try:
            if xtrace_memory_configured():
                processed = await run_queued_xtrace_ingest_jobs(
                    limit=max(1, settings.xtrace_memory_worker_batch_size),
                    session_factory=session_factory,
                )
                if processed:
                    log.info("xtrace_ingest_worker_drained count=%s", processed)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("xtrace_ingest_worker_tick_failed")
        await asyncio.sleep(max(1.0, settings.xtrace_memory_worker_poll_seconds))


async def _run_session_job(db: AsyncSession, job: XTraceMemoryIngest):
    if job.session_id is None:
        raise ValueError("session ingest job is missing session_id")
    session = await db.get(Session, job.session_id)
    if session is None:
        raise ValueError(f"session not found: {job.session_id}")
    if not session.file_key:
        raise ValueError(f"session content not uploaded: {job.session_id}")

    decision = decide_xtrace_session_ingest(session)
    if not decision.should_ingest:
        job.status = "skipped"
        job.response = xtrace_skip_response(decision)
        return None

    data = await get_file_store().get(session.file_key)
    parsed = json.loads(data)
    if not isinstance(parsed, list):
        raise ValueError("session content is not a JSON message list")
    messages = [m for m in parsed if isinstance(m, dict)]
    return await ingest_xtrace_session_memories(
        db,
        session=session,
        messages=messages,
        ingest_record=job,
    )


async def _run_skill_job(db: AsyncSession, job: XTraceMemoryIngest):
    if job.skill_id is None:
        raise ValueError("skill ingest job is missing skill_id")
    skill = await db.get(Skill, job.skill_id)
    if skill is None:
        raise ValueError(f"skill not found: {job.skill_id}")
    if not skill.file_key:
        raise ValueError(f"skill content not uploaded: {job.skill_id}")

    data = await get_file_store().get(skill.file_key)
    return await ingest_xtrace_skill_memories(
        db,
        skill=skill,
        data=data,
        ingest_record=job,
    )
