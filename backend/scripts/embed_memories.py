"""Backfill memory embeddings using the deployment's configured embedder.

Usage:
    # One user:
    pdm run python -m scripts.embed_memories --user-id <uuid>

    # All users:
    pdm run python -m scripts.embed_memories --all

    # Re-embed even rows that already have an embedding (after switching model):
    pdm run python -m scripts.embed_memories --all --force

The embedder is chosen by env vars (MEMORY_EMBEDDING_MODE and friends);
see app/core/config.py. If the embedder fails to initialize, the script
aborts rather than skipping users silently.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.database import engine
from app.models.memory import Memory
from app.services.embedding import resolve_embedder

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("embed-memories")


async def embed_for_user(user_id: uuid.UUID, force: bool, batch_size: int, embedder) -> None:
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
    async with SessionLocal() as db:
        # Snapshot target IDs up-front; see routes/memories.py
        # embed_backfill for why offset-walking the live query is incorrect.
        id_query = select(Memory.id).where(Memory.user_id == user_id)
        if not force:
            id_query = id_query.where(Memory.embedding.is_(None))
        id_query = id_query.order_by(Memory.created_at.asc())
        target_ids = (await db.execute(id_query)).scalars().all()

        processed = 0
        failed = 0
        for i in range(0, len(target_ids), batch_size):
            chunk_ids = target_ids[i : i + batch_size]
            chunk = (
                (await db.execute(select(Memory).where(Memory.id.in_(chunk_ids)))).scalars().all()
            )
            for mem in chunk:
                try:
                    vec = await embedder.embed(mem.content)
                    mem.embedding = vec
                    processed += 1
                except Exception as e:
                    log.warning("embed failed for %s: %s", mem.id, e)
                    failed += 1
            await db.commit()
        log.info("user %s: processed=%d failed=%d", user_id, processed, failed)


async def embed_all(force: bool, batch_size: int, embedder) -> None:
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
    async with SessionLocal() as db:
        # Iterate every distinct user who has memories. (Users without
        # a UserSetting row but with memories would otherwise be skipped.)
        user_ids = (await db.execute(select(Memory.user_id).distinct())).scalars().all()
    for uid in user_ids:
        await embed_for_user(uid, force=force, batch_size=batch_size, embedder=embedder)


def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--user-id", type=str, help="Backfill a single user by UUID.")
    g.add_argument("--all", action="store_true", help="Backfill every user that has memories.")
    ap.add_argument(
        "--force", action="store_true", help="Re-embed rows that already have embeddings."
    )
    ap.add_argument("--batch-size", type=int, default=32)
    args = ap.parse_args()

    embedder = resolve_embedder()
    if embedder is None:
        log.error("No embedder available. Check MEMORY_EMBEDDING_MODE and related env vars.")
        sys.exit(1)

    if args.all:
        asyncio.run(embed_all(force=args.force, batch_size=args.batch_size, embedder=embedder))
    else:
        asyncio.run(
            embed_for_user(
                uuid.UUID(args.user_id),
                force=args.force,
                batch_size=args.batch_size,
                embedder=embedder,
            )
        )


if __name__ == "__main__":
    main()
