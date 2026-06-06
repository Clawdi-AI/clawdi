"""Rebuild searchable skill chunks from stored skill archives.

Runs after deploying the skill_chunks migration so existing cloud skill files
become searchable by file content. New uploads and installs index themselves.

Usage:
    pdm run python -m scripts.reindex_skill_chunks --all
    pdm run python -m scripts.reindex_skill_chunks --user-id <uuid>
    pdm run python -m scripts.reindex_skill_chunks --all --force
    pdm run python -m scripts.reindex_skill_chunks --all --dry-run
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
from app.models.skill import Skill
from app.models.skill_chunk import SkillChunk
from app.services.file_store import get_file_store
from app.services.skill_index import index_skill_archive
from app.services.tar_utils import tar_from_content

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reindex-skill-chunks")


async def reindex(user_id: uuid.UUID | None, force: bool, dry_run: bool) -> None:
    file_store = get_file_store()
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

    current_chunk_exists = (
        select(SkillChunk.id)
        .where(
            SkillChunk.skill_id == Skill.id,
            SkillChunk.content_hash == Skill.content_hash,
        )
        .exists()
    )
    id_query = select(Skill.id).where(
        Skill.is_active,
        Skill.file_key.is_not(None),
    )
    if user_id is not None:
        id_query = id_query.where(Skill.user_id == user_id)
    if not force:
        id_query = id_query.where(~current_chunk_exists)
    id_query = id_query.order_by(Skill.created_at.asc())

    async with SessionLocal() as db:
        target_ids = (await db.execute(id_query)).scalars().all()

    log.info("found %d skill(s) needing chunk indexing", len(target_ids))
    if dry_run or not target_ids:
        if dry_run:
            log.info("dry-run: would reindex %d skill(s); no writes performed", len(target_ids))
        return

    processed = 0
    failed = 0
    for skill_id in target_ids:
        async with SessionLocal() as db:
            skill = (
                await db.execute(
                    select(Skill).where(
                        Skill.id == skill_id,
                        Skill.is_active,
                        Skill.file_key.is_not(None),
                    )
                )
            ).scalar_one_or_none()
            if skill is None or skill.file_key is None:
                continue

            try:
                data = await file_store.get(skill.file_key)
                if skill.file_key.endswith(".md"):
                    data, _ = tar_from_content(skill.skill_key, data.decode("utf-8"))
                chunks = await index_skill_archive(db, skill, data)
                await db.commit()
                processed += 1
                log.info("indexed skill=%s chunks=%d", skill.id, chunks)
            except Exception as exc:
                await db.rollback()
                failed += 1
                log.warning(
                    "failed to index skill=%s file_key=%s: %s",
                    skill.id,
                    skill.file_key,
                    exc,
                )

    log.info("done: processed=%d failed=%d", processed, failed)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--user-id", type=str, help="Reindex a single user's skills by UUID.")
    g.add_argument("--all", action="store_true", help="Reindex all active skills.")
    ap.add_argument(
        "--force",
        action="store_true",
        help="Rebuild chunks even when the current content hash is already indexed.",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be reindexed without writing.",
    )
    args = ap.parse_args()

    user_id: uuid.UUID | None = None
    if args.user_id:
        try:
            user_id = uuid.UUID(args.user_id)
        except ValueError:
            log.error("invalid --user-id; expected a UUID")
            sys.exit(2)

    asyncio.run(reindex(user_id=user_id, force=args.force, dry_run=args.dry_run))


if __name__ == "__main__":
    main()
