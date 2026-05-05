"""Backfill memory_chunks for memories that pre-date the chunking migration.

Reads each Memory's content, splits it via app.services.memory_chunker,
embeds each chunk with the deployment's configured embedder, and writes
the resulting MemoryChunk rows. Idempotent — skips memories that already
have chunks unless --force is passed.

Usage:
    # One user:
    uv run python -m scripts.chunk_existing_memories --user-id <uuid>

    # All users (deploy-time backfill):
    uv run python -m scripts.chunk_existing_memories --all

    # Re-chunk + re-embed everything (e.g. after embedding-model switch):
    uv run python -m scripts.chunk_existing_memories --all --force

Run AFTER `alembic upgrade head` so memory_chunks table exists. Search
falls back to the legacy whole-memory FTS+vector path until this script
populates chunks, so the deploy stays serviceable mid-backfill.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.database import engine
from app.models.memory import Memory
from app.models.memory_chunk import MemoryChunk
from app.services.embedding import resolve_embedder
from app.services.memory_chunker import chunk_memory_content

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("chunk-existing-memories")


async def chunk_for_user(
    user_id: uuid.UUID, force: bool, batch_size: int, embedder
) -> tuple[int, int, int]:
    """Returns (memories_processed, chunks_created, chunks_failed_embed)."""
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
    processed = 0
    chunks_created = 0
    chunks_failed = 0

    async with SessionLocal() as db:
        # Snapshot the memory IDs up front; iterating a live query while
        # writing to memory_chunks would skew offsets if a concurrent write
        # mutates the row count.
        id_query = (
            select(Memory.id, Memory.content)
            .where(Memory.user_id == user_id)
            .order_by(Memory.created_at.asc())
        )
        rows = (await db.execute(id_query)).all()

    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        async with SessionLocal() as db:
            for mem_id, content in batch:
                # Skip if chunks already exist (unless --force).
                existing = (
                    await db.execute(
                        select(MemoryChunk.id).where(MemoryChunk.memory_id == mem_id).limit(1)
                    )
                ).first()
                if existing and not force:
                    continue
                if existing and force:
                    await db.execute(delete(MemoryChunk).where(MemoryChunk.memory_id == mem_id))

                for chunk in chunk_memory_content(content):
                    vec: list[float] | None = None
                    try:
                        vec = await embedder.embed(chunk.content)
                    except Exception as e:
                        chunks_failed += 1
                        log.warning(
                            "embed failed for memory %s position %d: %s",
                            mem_id,
                            chunk.position,
                            e,
                        )
                    db.add(
                        MemoryChunk(
                            memory_id=mem_id,
                            position=chunk.position,
                            content=chunk.content,
                            embedding=vec,
                            created_at=datetime.now(UTC),
                        )
                    )
                    chunks_created += 1
                processed += 1
            await db.commit()
            log.info(
                "user %s: processed %d/%d (chunks=%d, failed_embed=%d)",
                user_id,
                min(i + batch_size, len(rows)),
                len(rows),
                chunks_created,
                chunks_failed,
            )

    return processed, chunks_created, chunks_failed


async def chunk_all(force: bool, batch_size: int, embedder) -> None:
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
    async with SessionLocal() as db:
        user_ids = (await db.execute(select(Memory.user_id).distinct())).scalars().all()
    log.info("chunking memories for %d users", len(user_ids))
    for uid in user_ids:
        processed, chunks, failed = await chunk_for_user(
            uid, force=force, batch_size=batch_size, embedder=embedder
        )
        log.info(
            "user %s done: memories=%d chunks=%d failed_embed=%d",
            uid,
            processed,
            chunks,
            failed,
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--user-id", type=str, help="Backfill a single user by UUID.")
    g.add_argument(
        "--all",
        action="store_true",
        help="Backfill every user that has memories.",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="Re-chunk + re-embed memories that already have chunks.",
    )
    ap.add_argument("--batch-size", type=int, default=32)
    args = ap.parse_args()

    embedder = resolve_embedder()
    if embedder is None:
        log.error("No embedder available. Check MEMORY_EMBEDDING_MODE and related env vars.")
        sys.exit(1)

    if args.all:
        asyncio.run(chunk_all(force=args.force, batch_size=args.batch_size, embedder=embedder))
    else:
        asyncio.run(
            chunk_for_user(
                uuid.UUID(args.user_id),
                force=args.force,
                batch_size=args.batch_size,
                embedder=embedder,
            )
        )


if __name__ == "__main__":
    main()
