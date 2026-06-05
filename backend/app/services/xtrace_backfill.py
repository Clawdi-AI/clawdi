"""Persistent XTrace backfill jobs for stored sessions and skills."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.database import async_session_factory
from app.models.session import Session
from app.models.skill import Skill
from app.models.xtrace_backfill_job import XTraceBackfillJob
from app.models.xtrace_ingest import XTraceMemoryIngest
from app.services.file_store import get_file_store
from app.services.xtrace_memory import (
    ingest_xtrace_session_memories,
    ingest_xtrace_skill_memories,
    xtrace_memory_configured,
    xtrace_session_source_key,
    xtrace_skill_source_key,
)

log = logging.getLogger(__name__)

_ACTIVE_STATUSES = {"queued", "running"}
_COMMIT_EVERY = 10


async def create_xtrace_backfill_job(
    db: AsyncSession,
    *,
    requested_by_user_id: UUID | None,
    scope_user_id: UUID | None,
    include_sessions: bool,
    include_skills: bool,
    force: bool,
    dry_run: bool,
    limit: int | None,
) -> XTraceBackfillJob:
    if not xtrace_memory_configured():
        raise RuntimeError("XTrace memory is not configured")

    if not include_sessions and not include_skills:
        raise ValueError("at least one source type must be selected")

    scope_filter = (
        XTraceBackfillJob.scope_user_id.is_(None)
        if scope_user_id is None
        else or_(
            XTraceBackfillJob.scope_user_id.is_(None),
            XTraceBackfillJob.scope_user_id == scope_user_id,
        )
    )
    active = (
        await db.execute(
            select(XTraceBackfillJob.id)
            .where(
                scope_filter,
                XTraceBackfillJob.status.in_(_ACTIVE_STATUSES),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if active is not None:
        raise RuntimeError(f"backfill job already active: {active}")

    job = XTraceBackfillJob(
        requested_by_user_id=requested_by_user_id,
        scope_user_id=scope_user_id,
        include_sessions=include_sessions,
        include_skills=include_skills,
        force=force,
        dry_run=dry_run,
        limit=limit,
        status="queued",
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


async def run_xtrace_backfill_job(
    job_id: UUID,
    *,
    session_factory: async_sessionmaker[AsyncSession] = async_session_factory,
) -> None:
    async with session_factory() as db:
        job = await db.get(XTraceBackfillJob, job_id)
        if job is None:
            log.error("xtrace_backfill_job_missing job_id=%s", job_id)
            return
        if job.status not in _ACTIVE_STATUSES:
            log.info("xtrace_backfill_job_not_active job_id=%s status=%s", job_id, job.status)
            return

        job.status = "running"
        job.started_at = datetime.now(UTC)
        await db.commit()

        try:
            if job.include_sessions:
                await _backfill_sessions(db, job)
            if job.include_skills:
                await _backfill_skills(db, job)
            job.status = "succeeded" if job.failed_count == 0 else "failed"
            job.finished_at = datetime.now(UTC)
            job.current_source_type = None
            job.current_source_key = None
            await db.commit()
            log.info(
                "xtrace_backfill_job_finished job_id=%s status=%s considered=%s "
                "sent=%s skipped=%s failed=%s mirrored=%s",
                job.id,
                job.status,
                job.considered_count,
                job.sent_count,
                job.skipped_count,
                job.failed_count,
                job.mirrored_count,
            )
        except Exception as exc:
            await db.rollback()
            job = await db.get(XTraceBackfillJob, job_id)
            if job is not None:
                job.status = "failed"
                job.error = str(exc)[:4000]
                job.finished_at = datetime.now(UTC)
                await db.commit()
            log.exception("xtrace_backfill_job_failed job_id=%s", job_id)


async def _backfill_sessions(db: AsyncSession, job: XTraceBackfillJob) -> None:
    stmt = select(Session).where(Session.file_key.is_not(None))
    if job.scope_user_id is not None:
        stmt = stmt.where(Session.user_id == job.scope_user_id)
    stmt = stmt.order_by(Session.last_activity_at.desc())
    if job.limit is not None:
        stmt = stmt.limit(job.limit)

    sessions = (await db.execute(stmt)).scalars().all()
    file_store = get_file_store()
    for session in sessions:
        source_key = xtrace_session_source_key(session)
        job.current_source_type = "session"
        job.current_source_key = source_key
        job.considered_count += 1
        job.sessions_considered += 1
        if not job.force and await _already_ingested(db, "session", source_key):
            _increment_skipped(job, "session")
            await _commit_periodically(db, job)
            continue
        if job.dry_run:
            _increment_skipped(job, "session")
            await _commit_periodically(db, job)
            continue

        try:
            data = await file_store.get(session.file_key)
            parsed = json.loads(data)
            if not isinstance(parsed, list):
                raise ValueError("session content is not a JSON message list")
            messages: list[dict[str, Any]] = [m for m in parsed if isinstance(m, dict)]
            result = await ingest_xtrace_session_memories(db, session=session, messages=messages)
        except Exception:
            await db.rollback()
            await db.refresh(job)
            _increment_failed(job, "session")
            await db.commit()
            log.exception("xtrace_backfill_session_failed source_key=%s", source_key)
            continue
        if result is None:
            _increment_skipped(job, "session")
        else:
            _increment_sent(job, "session", result.mirrored_count)
        await _commit_periodically(db, job)
    await db.commit()


async def _backfill_skills(db: AsyncSession, job: XTraceBackfillJob) -> None:
    stmt = select(Skill).where(Skill.is_active.is_(True), Skill.file_key.is_not(None))
    if job.scope_user_id is not None:
        stmt = stmt.where(Skill.user_id == job.scope_user_id)
    stmt = stmt.order_by(Skill.updated_at.desc())
    if job.limit is not None:
        stmt = stmt.limit(job.limit)

    skills = (await db.execute(stmt)).scalars().all()
    file_store = get_file_store()
    for skill in skills:
        source_key = xtrace_skill_source_key(skill)
        job.current_source_type = "skill"
        job.current_source_key = source_key
        job.considered_count += 1
        job.skills_considered += 1
        if not job.force and await _already_ingested(db, "skill", source_key):
            _increment_skipped(job, "skill")
            await _commit_periodically(db, job)
            continue
        if job.dry_run:
            _increment_skipped(job, "skill")
            await _commit_periodically(db, job)
            continue

        try:
            data = await file_store.get(skill.file_key)
            result = await ingest_xtrace_skill_memories(db, skill=skill, data=data)
        except Exception:
            await db.rollback()
            await db.refresh(job)
            _increment_failed(job, "skill")
            await db.commit()
            log.exception("xtrace_backfill_skill_failed source_key=%s", source_key)
            continue
        if result is None:
            _increment_skipped(job, "skill")
        else:
            _increment_sent(job, "skill", result.mirrored_count)
        await _commit_periodically(db, job)
    await db.commit()


async def _already_ingested(db: AsyncSession, source_type: str, source_key: str) -> bool:
    row = (
        await db.execute(
            select(XTraceMemoryIngest.id)
            .where(
                XTraceMemoryIngest.source_type == source_type,
                XTraceMemoryIngest.source_key == source_key,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    return row is not None


def _increment_skipped(job: XTraceBackfillJob, source_type: str) -> None:
    job.skipped_count += 1
    if source_type == "session":
        job.sessions_skipped += 1
    else:
        job.skills_skipped += 1


def _increment_failed(job: XTraceBackfillJob, source_type: str) -> None:
    job.failed_count += 1
    if source_type == "session":
        job.sessions_failed += 1
    else:
        job.skills_failed += 1


def _increment_sent(job: XTraceBackfillJob, source_type: str, mirrored_count: int) -> None:
    job.sent_count += 1
    job.mirrored_count += mirrored_count
    if source_type == "session":
        job.sessions_sent += 1
        job.sessions_mirrored += mirrored_count
    else:
        job.skills_sent += 1
        job.skills_mirrored += mirrored_count


async def _commit_periodically(db: AsyncSession, job: XTraceBackfillJob) -> None:
    if job.considered_count % _COMMIT_EVERY == 0:
        await db.commit()
