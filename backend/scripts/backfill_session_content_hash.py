"""Backfill `sessions.content_hash` for rows uploaded before the column existed.

Runs once after deploying migration 672acd66fc7d. Without it, legacy rows
have `file_key IS NOT NULL` but `content_hash IS NULL`, which means the
pull side's diff (`remote.content_hash !== sidecar.content_hash`) always
sees NULL on the remote and re-downloads the body forever — pull never
converges for those rows.

The script is idempotent: it only touches rows where `content_hash IS NULL`,
so re-running just no-ops. A row whose file is missing from the store
(e.g. a stale row from a wiped bucket) gets skipped with a warning rather
than aborting the run; orphaned rows are diagnosed separately.

Usage:
    pdm run python -m scripts.backfill_session_content_hash --all
    pdm run python -m scripts.backfill_session_content_hash --user-id <uuid>
    pdm run python -m scripts.backfill_session_content_hash --all --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import logging
import sys
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.database import engine
from app.models.session import Session
from app.services.file_store import get_file_store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill-session-hash")

# Process rows in chunks so a multi-GB file store doesn't load every Session
# row into memory at once. The chunk size is small because each row triggers
# a file_store.get; the network round-trip dominates.
CHUNK_SIZE = 50


async def backfill(user_id: uuid.UUID | None, dry_run: bool) -> None:
    file_store = get_file_store()
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

    # Snapshot the target ids up-front. A live select would re-walk the
    # table after each commit and skip rows whose `content_hash` we just
    # set — wastes time but isn't a correctness issue. Snapshot is just
    # cleaner.
    async with SessionLocal() as db:
        id_query = select(Session.id).where(
            Session.file_key.is_not(None),
            Session.content_hash.is_(None),
        )
        if user_id is not None:
            id_query = id_query.where(Session.user_id == user_id)
        id_query = id_query.order_by(Session.created_at.asc())
        target_ids = (await db.execute(id_query)).scalars().all()

    log.info("found %d session(s) needing backfill", len(target_ids))
    if not target_ids:
        return
    if dry_run:
        log.info("dry-run: would backfill %d row(s); no writes performed", len(target_ids))
        return

    processed = 0
    skipped_missing = 0
    skipped_error = 0

    for i in range(0, len(target_ids), CHUNK_SIZE):
        chunk_ids = target_ids[i : i + CHUNK_SIZE]
        async with SessionLocal() as db:
            rows = (
                (await db.execute(select(Session).where(Session.id.in_(chunk_ids)))).scalars().all()
            )
            for row in rows:
                if not row.file_key:
                    # Could happen if another writer cleared file_key
                    # between the snapshot and now. Defensive; not expected.
                    skipped_missing += 1
                    continue
                try:
                    data = await file_store.get(row.file_key)
                except Exception as e:
                    # File store may be missing the object (stale row, wiped
                    # bucket, permissions). Skip and let a separate orphan
                    # check deal with it.
                    log.warning("file_store.get failed for %s (%s): %s", row.id, row.file_key, e)
                    skipped_error += 1
                    continue

                row.content_hash = hashlib.sha256(data).hexdigest()
                # We don't know exactly when content was uploaded for legacy
                # rows. `updated_at` would be the closest signal, but it's
                # been bumped by every subsequent metadata change. Stamping
                # `now()` here is honest about the meaning: "this is when
                # we recorded the hash", not when bytes hit storage.
                row.content_uploaded_at = datetime.now(UTC)
                processed += 1
            await db.commit()
        log.info(
            "progress: %d/%d processed (skipped: %d missing, %d errors)",
            processed,
            len(target_ids),
            skipped_missing,
            skipped_error,
        )

    log.info(
        "done: processed=%d skipped_missing=%d skipped_error=%d",
        processed,
        skipped_missing,
        skipped_error,
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--user-id", type=str, help="Backfill a single user by UUID.")
    g.add_argument("--all", action="store_true", help="Backfill every user with legacy rows.")
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be backfilled without writing.",
    )
    args = ap.parse_args()

    user_id: uuid.UUID | None = None
    if args.user_id:
        try:
            user_id = uuid.UUID(args.user_id)
        except ValueError:
            log.error("invalid --user-id; expected a UUID")
            sys.exit(2)

    asyncio.run(backfill(user_id=user_id, dry_run=args.dry_run))


if __name__ == "__main__":
    main()
