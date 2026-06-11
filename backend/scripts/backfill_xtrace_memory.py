"""Backfill stored Clawdi sessions and skills into XTrace Memory.

Usage:
    pdm run python -m scripts.backfill_xtrace_memory --all
    pdm run python -m scripts.backfill_xtrace_memory --sessions --limit 100
    pdm run python -m scripts.backfill_xtrace_memory --skills --force
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.database import engine
from app.models.session import Session
from app.models.skill import Skill
from app.models.xtrace_ingest import XTraceMemoryIngest
from app.services.file_store import get_file_store
from app.services.xtrace_memory import (
    ingest_xtrace_session_memories,
    ingest_xtrace_skill_memories,
    xtrace_memory_configured,
    xtrace_session_source_key,
    xtrace_skill_source_key,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill-xtrace-memory")


@dataclass
class Totals:
    considered: int = 0
    sent: int = 0
    skipped: int = 0
    failed: int = 0
    mirrored: int = 0


async def run(
    *,
    include_sessions: bool,
    include_skills: bool,
    user_id: uuid.UUID | None,
    limit: int | None,
    force: bool,
    dry_run: bool,
) -> int:
    if not xtrace_memory_configured():
        log.error(
            "XTrace memory is not configured. Set XTRACE_MEMORY_ENABLED=true, "
            "XTRACE_API_KEY, and XTRACE_ORG_ID."
        )
        return 2

    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
    async with SessionLocal() as db:
        totals = Totals()
        if include_sessions:
            session_totals = await _backfill_sessions(
                db,
                user_id=user_id,
                limit=limit,
                force=force,
                dry_run=dry_run,
            )
            _merge_totals(totals, session_totals)
        if include_skills:
            skill_totals = await _backfill_skills(
                db,
                user_id=user_id,
                limit=limit,
                force=force,
                dry_run=dry_run,
            )
            _merge_totals(totals, skill_totals)

    log.info(
        "done considered=%s sent=%s skipped=%s failed=%s mirrored=%s dry_run=%s",
        totals.considered,
        totals.sent,
        totals.skipped,
        totals.failed,
        totals.mirrored,
        dry_run,
    )
    return 1 if totals.failed else 0


async def _backfill_sessions(
    db,
    *,
    user_id: uuid.UUID | None,
    limit: int | None,
    force: bool,
    dry_run: bool,
) -> Totals:
    totals = Totals()
    stmt = select(Session).where(Session.file_key.is_not(None))
    if user_id is not None:
        stmt = stmt.where(Session.user_id == user_id)
    stmt = stmt.order_by(Session.last_activity_at.desc())
    if limit is not None:
        stmt = stmt.limit(limit)

    sessions = (await db.execute(stmt)).scalars().all()
    file_store = get_file_store()
    for session in sessions:
        totals.considered += 1
        source_key = xtrace_session_source_key(session)
        if not force and await _already_ingested(db, "session", source_key):
            totals.skipped += 1
            continue
        if dry_run:
            totals.skipped += 1
            log.info(
                "dry_run session local_session_id=%s source_key=%s",
                session.local_session_id,
                source_key,
            )
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
            totals.failed += 1
            log.exception("session_backfill_failed local_session_id=%s", session.local_session_id)
            continue
        if result is None:
            totals.skipped += 1
            continue
        totals.sent += 1
        totals.mirrored += result.mirrored_count
        log.info(
            "session_backfilled local_session_id=%s job_id=%s status=%s "
            "created=%s updated=%s mirrored=%s",
            session.local_session_id,
            result.job_id,
            result.status,
            result.created_ref_count,
            result.updated_ref_count,
            result.mirrored_count,
        )
    return totals


async def _backfill_skills(
    db,
    *,
    user_id: uuid.UUID | None,
    limit: int | None,
    force: bool,
    dry_run: bool,
) -> Totals:
    totals = Totals()
    stmt = select(Skill).where(Skill.is_active.is_(True), Skill.file_key.is_not(None))
    if user_id is not None:
        stmt = stmt.where(Skill.user_id == user_id)
    stmt = stmt.order_by(Skill.updated_at.desc())
    if limit is not None:
        stmt = stmt.limit(limit)

    skills = (await db.execute(stmt)).scalars().all()
    file_store = get_file_store()
    for skill in skills:
        totals.considered += 1
        source_key = xtrace_skill_source_key(skill)
        if not force and await _already_ingested(db, "skill", source_key):
            totals.skipped += 1
            continue
        if dry_run:
            totals.skipped += 1
            log.info("dry_run skill skill_key=%s source_key=%s", skill.skill_key, source_key)
            continue

        try:
            data = await file_store.get(skill.file_key)
            result = await ingest_xtrace_skill_memories(db, skill=skill, data=data)
        except Exception:
            await db.rollback()
            totals.failed += 1
            log.exception("skill_backfill_failed skill_key=%s", skill.skill_key)
            continue
        if result is None:
            totals.skipped += 1
            continue
        totals.sent += 1
        totals.mirrored += result.mirrored_count
        log.info(
            "skill_backfilled skill_key=%s job_id=%s status=%s created=%s updated=%s mirrored=%s",
            skill.skill_key,
            result.job_id,
            result.status,
            result.created_ref_count,
            result.updated_ref_count,
            result.mirrored_count,
        )
    return totals


async def _already_ingested(db, source_type: str, source_key: str) -> bool:
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


def _merge_totals(target: Totals, source: Totals) -> None:
    target.considered += source.considered
    target.sent += source.sent
    target.skipped += source.skipped
    target.failed += source.failed
    target.mirrored += source.mirrored


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--all", action="store_true", help="Backfill sessions and skills.")
    mode.add_argument("--sessions", action="store_true", help="Backfill sessions only.")
    mode.add_argument("--skills", action="store_true", help="Backfill skills only.")
    ap.add_argument("--user-id", type=str, help="Limit backfill to one Clawdi user UUID.")
    ap.add_argument("--limit", type=int, help="Maximum rows per selected source type.")
    ap.add_argument("--force", action="store_true", help="Re-send rows already audited.")
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print candidates without calling XTrace.",
    )
    args = ap.parse_args()

    user_id: uuid.UUID | None = None
    try:
        if args.user_id:
            user_id = uuid.UUID(args.user_id)
    except ValueError:
        log.error("invalid --user-id UUID")
        sys.exit(2)

    include_sessions = args.all or args.sessions
    include_skills = args.all or args.skills
    sys.exit(
        asyncio.run(
            run(
                include_sessions=include_sessions,
                include_skills=include_skills,
                user_id=user_id,
                limit=args.limit,
                force=args.force,
                dry_run=args.dry_run,
            )
        )
    )


if __name__ == "__main__":
    main()
