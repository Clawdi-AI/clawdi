"""Backfill the rebuildable visible-message Session search index.

Usage:
    pdm run python -m scripts.backfill_session_search --user-id <uuid>
    pdm run python -m scripts.backfill_session_search --all
    pdm run python -m scripts.backfill_session_search --all --dry-run
    pdm run python -m scripts.backfill_session_search --all --force
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import uuid

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.database import engine
from app.models.session import Session
from app.services.file_store import get_file_store
from app.services.session_search import current_search_revision, rebuild_session_search_index

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill-session-search")

CHUNK_SIZE = 16


async def backfill_user(user_id: uuid.UUID, *, force: bool, dry_run: bool) -> int:
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
        for session_id in session_ids:
            async with session_factory() as db:
                session = await db.get(Session, session_id)
                if session is None:
                    skipped += 1
                    continue
                revision = current_search_revision(session)
                if revision is None or (not force and session.search_index_revision == revision):
                    skipped += 1
                    continue
                try:
                    rebuilt = await rebuild_session_search_index(db, session, file_store)
                    await db.commit()
                    if rebuilt:
                        indexed += 1
                    else:
                        # The authoritative revision changed while its object was
                        # being read. The live ingest path indexed that revision;
                        # a later backfill run can retry if it still needs work.
                        skipped += 1
                except Exception:
                    failed += 1
                    log.exception("session search backfill failed session_id=%s", session_id)
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


async def backfill_all(*, force: bool, dry_run: bool) -> int:
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as db:
        user_ids = list((await db.execute(select(Session.user_id).distinct())).scalars())
    failed = 0
    for user_id in user_ids:
        failed += await backfill_user(user_id, force=force, dry_run=dry_run)
    return failed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--user-id", type=uuid.UUID)
    target.add_argument("--all", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.all:
        failed = asyncio.run(backfill_all(force=args.force, dry_run=args.dry_run))
    else:
        assert args.user_id is not None
        failed = asyncio.run(backfill_user(args.user_id, force=args.force, dry_run=args.dry_run))
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
