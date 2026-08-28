"""Backfill the rebuildable visible-message Session search index.

Usage:
    pdm run python -m scripts.backfill_session_search --user-id <uuid>
    pdm run python -m scripts.backfill_session_search --all
    pdm run python -m scripts.backfill_session_search --all --workers 8
    pdm run python -m scripts.backfill_session_search --all --dry-run
    pdm run python -m scripts.backfill_session_search --all --force
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import uuid
from typing import Literal

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.database import engine
from app.models.session import Session
from app.services.file_store import get_file_store
from app.services.session_search import (
    current_search_revision,
    event_search_projection_complete,
    rebuild_session_search_index,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill-session-search")

MAX_WORKERS = 16
CHUNK_SIZE = MAX_WORKERS

type BackfillOutcome = Literal["indexed", "skipped", "failed"]


def worker_count(value: str) -> int:
    try:
        workers = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("workers must be an integer") from exc
    if not 1 <= workers <= MAX_WORKERS:
        raise argparse.ArgumentTypeError(f"workers must be between 1 and {MAX_WORKERS}")
    return workers


async def backfill_user(
    user_id: uuid.UUID,
    *,
    force: bool,
    dry_run: bool,
    workers: int,
) -> int:
    if not 1 <= workers <= MAX_WORKERS:
        raise ValueError(f"workers must be between 1 and {MAX_WORKERS}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    target_filters = (
        Session.user_id == user_id,
        or_(
            Session.file_key.is_not(None),
            Session.event_generation_id.is_not(None),
        ),
    )

    if dry_run:
        async with session_factory() as db:
            total = (
                await db.execute(select(func.count(Session.id)).where(*target_filters))
            ).scalar_one()
        log.info("user %s: would inspect %d sessions", user_id, total)
        return 0

    file_store = get_file_store()
    indexed = 0
    skipped = 0
    failed = 0
    inspected = 0
    last_id: uuid.UUID | None = None
    worker_slots = asyncio.Semaphore(workers)

    async def backfill_session(session_id: uuid.UUID) -> BackfillOutcome:
        async with worker_slots, session_factory() as db:
            try:
                session = await db.get(Session, session_id)
                if session is None:
                    return "skipped"
                revision = current_search_revision(session)
                projection_current = session.search_index_revision == revision
                if (
                    projection_current
                    and session.content_protocol == "events-v1"
                    and session.event_generation_id is not None
                ):
                    projection_current = await event_search_projection_complete(
                        db,
                        session.event_generation_id,
                    )
                if revision is None or (not force and projection_current):
                    return "skipped"
                rebuilt = await rebuild_session_search_index(db, session, file_store)
                await db.commit()
            except Exception:
                log.exception("session search backfill failed session_id=%s", session_id)
                return "failed"
            if rebuilt:
                return "indexed"
            # The authoritative revision changed while its object was being read.
            # The live ingest path indexed that revision; a later run can retry.
            return "skipped"

    while True:
        async with session_factory() as db:
            query = select(Session.id).where(*target_filters)
            if last_id is not None:
                query = query.where(Session.id > last_id)
            session_ids = list(
                (await db.execute(query.order_by(Session.id).limit(CHUNK_SIZE))).scalars()
            )
        if not session_ids:
            break
        outcomes = await asyncio.gather(
            *(backfill_session(session_id) for session_id in session_ids)
        )
        indexed += outcomes.count("indexed")
        skipped += outcomes.count("skipped")
        failed += outcomes.count("failed")
        inspected += len(session_ids)
        last_id = session_ids[-1]
        log.info(
            "user %s: inspected=%d indexed=%d skipped=%d failed=%d",
            user_id,
            inspected,
            indexed,
            skipped,
            failed,
        )
    return failed


async def backfill_all(*, force: bool, dry_run: bool, workers: int) -> int:
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as db:
        user_ids = list((await db.execute(select(Session.user_id).distinct())).scalars())
    failed = 0
    for user_id in user_ids:
        failed += await backfill_user(
            user_id,
            force=force,
            dry_run=dry_run,
            workers=workers,
        )
    return failed


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill the rebuildable visible-message Session search index."
    )
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--user-id", type=uuid.UUID)
    target.add_argument("--all", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--workers",
        type=worker_count,
        default=1,
        help=f"concurrent Session rebuilds (1-{MAX_WORKERS}; default: 1)",
    )
    args = parser.parse_args()
    if args.all:
        failed = asyncio.run(
            backfill_all(
                force=args.force,
                dry_run=args.dry_run,
                workers=args.workers,
            )
        )
    else:
        assert args.user_id is not None
        failed = asyncio.run(
            backfill_user(
                args.user_id,
                force=args.force,
                dry_run=args.dry_run,
                workers=args.workers,
            )
        )
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
