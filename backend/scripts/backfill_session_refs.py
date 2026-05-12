"""Backfill `sessions.related_refs` from stored message content.

Runs once after deploying the migration that added the column. Without
it, sessions uploaded before the migration keep `related_refs = NULL` —
the sidebar's PR / repo / branch chips stay hidden.

The script is idempotent — it only touches rows where `related_refs`
IS NULL, so re-running is a no-op. `--force` overrides (use this after
fixing the extractor regex).

Usage:
    # Common case: backfill everything for one user.
    pdm run python -m scripts.backfill_session_refs --user-id <uuid>

    # Every user.
    pdm run python -m scripts.backfill_session_refs --all

    # Re-run after a regex fix.
    pdm run python -m scripts.backfill_session_refs --all --force

    # Count what would be done, change nothing.
    pdm run python -m scripts.backfill_session_refs --all --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.database import engine
from app.models.session import Session
from app.services.file_store import get_file_store
from app.services.session_refs import extract_related_refs

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill-session-refs")

# Each row triggers a file_store.get + a json.loads — network and CPU
# dominate. Keep the chunk small so a transient error doesn't roll back
# a large batch on commit.
CHUNK_SIZE = 32


async def _load_messages(file_key: str, file_store) -> list | None:
    """Fetch + parse the stored JSONL. Returns None if missing or invalid
    so the caller can skip the row with a warning instead of aborting."""
    try:
        data = await file_store.get(file_key)
    except Exception as e:
        log.warning("file_store miss for %s: %s", file_key, e)
        return None
    try:
        parsed = json.loads(data)
    except json.JSONDecodeError as e:
        log.warning("json parse failed for %s: %s", file_key, e)
        return None
    if not isinstance(parsed, list):
        log.warning("content for %s is not a list (got %s)", file_key, type(parsed).__name__)
        return None
    return parsed


async def _backfill_chunk(
    db,
    session_ids: list[uuid.UUID],
    *,
    force: bool,
    file_store,
) -> tuple[int, int]:
    """Process one chunk of session IDs. Returns (refs_updated, skipped)."""
    refs_updated = 0
    skipped = 0

    rows = (
        await db.execute(select(Session).where(Session.id.in_(session_ids)))
    ).scalars().all()

    for session in rows:
        if not session.file_key:
            skipped += 1
            continue

        if not force and session.related_refs is not None:
            skipped += 1
            continue

        messages = await _load_messages(session.file_key, file_store)
        if messages is None:
            skipped += 1
            continue

        try:
            session.related_refs = extract_related_refs(messages) or None
            refs_updated += 1
        except Exception:
            log.exception(
                "extract_related_refs failed for session %s — leaving field NULL",
                session.id,
            )

    return refs_updated, skipped


async def backfill_user(
    user_id: uuid.UUID,
    *,
    force: bool,
    dry_run: bool,
) -> None:
    file_store = get_file_store()
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

    # Snapshot target IDs up front so concurrent uploads landing during
    # backfill don't reshuffle our walk.
    async with SessionLocal() as db:
        id_query = select(Session.id).where(
            Session.user_id == user_id,
            Session.file_key.is_not(None),
        )
        if not force:
            id_query = id_query.where(Session.related_refs.is_(None))
        id_query = id_query.order_by(Session.created_at.asc())
        target_ids = (await db.execute(id_query)).scalars().all()

    if not target_ids:
        log.info("user %s: nothing to backfill", user_id)
        return
    log.info("user %s: %d sessions queued", user_id, len(target_ids))

    if dry_run:
        log.info("user %s: dry-run, no writes", user_id)
        return

    refs_total = 0
    skipped_total = 0
    async with SessionLocal() as db:
        for i in range(0, len(target_ids), CHUNK_SIZE):
            chunk_ids = target_ids[i : i + CHUNK_SIZE]
            r, s = await _backfill_chunk(
                db,
                chunk_ids,
                force=force,
                file_store=file_store,
            )
            refs_total += r
            skipped_total += s
            await db.commit()
            log.info(
                "user %s: progress %d/%d (refs=%d skip=%d)",
                user_id,
                min(i + CHUNK_SIZE, len(target_ids)),
                len(target_ids),
                refs_total,
                skipped_total,
            )

    log.info(
        "user %s done: refs_updated=%d skipped=%d",
        user_id,
        refs_total,
        skipped_total,
    )


async def backfill_all(
    *,
    force: bool,
    dry_run: bool,
) -> None:
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
    async with SessionLocal() as db:
        user_ids = (
            await db.execute(
                select(Session.user_id).where(Session.file_key.is_not(None)).distinct()
            )
        ).scalars().all()
    log.info("backfilling %d users", len(user_ids))
    for uid in user_ids:
        await backfill_user(uid, force=force, dry_run=dry_run)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    target = ap.add_mutually_exclusive_group(required=True)
    target.add_argument("--user-id", type=str, help="Backfill one user (UUID).")
    target.add_argument("--all", action="store_true", help="Backfill every user.")

    ap.add_argument(
        "--force",
        action="store_true",
        help="Re-process rows that already have data (regex fix).",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Count what would be done; write nothing.",
    )
    args = ap.parse_args()

    coro = (
        backfill_all(force=args.force, dry_run=args.dry_run)
        if args.all
        else backfill_user(
            uuid.UUID(args.user_id),
            force=args.force,
            dry_run=args.dry_run,
        )
    )
    asyncio.run(coro)


if __name__ == "__main__":
    main()
