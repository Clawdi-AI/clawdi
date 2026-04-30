"""arq worker process — runs LLM-heavy wiki tasks off the FastAPI request path.

Phase 1 of multi-tenant-scaling.md. The FastAPI workers stay snappy for
synchronous reads + cheap writes; this process owns extraction, synthesis,
embedding backfill, and bootstrap loops.

To run the worker:
    uv run arq app.workers.WorkerSettings

Set `redis_url` in settings (or `REDIS_URL` env var) to enable enqueueing
from FastAPI. Empty `redis_url` keeps the legacy inline / BackgroundTask
path so single-instance deploys still work without Redis.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from arq.connections import RedisSettings

from app.core.config import settings
from app.core.database import async_session_factory

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tasks — each takes a `ctx` dict from arq + the args it needs. Tasks open
# their own AsyncSession; do NOT pass DB sessions across the queue boundary
# (sessions don't pickle and are scoped to one event loop anyway).
# ---------------------------------------------------------------------------


async def wiki_extract_user(ctx: dict[str, Any], user_id: str) -> dict:
    """Run llm_extract_for_user on one user. Returns the extractor's summary."""
    from app.services.wiki_llm_extraction import llm_extract_for_user

    uid = uuid.UUID(user_id)
    log.info("worker: wiki_extract_user start user_id=%s", uid)
    async with async_session_factory() as db:
        result = await llm_extract_for_user(db, uid)
        await db.commit()
        log.info("worker: wiki_extract_user done user_id=%s result=%s", uid, result)
        return result


async def wiki_synthesize_user(ctx: dict[str, Any], user_id: str) -> dict:
    """Run synthesize_for_user on one user."""
    from app.services.wiki_synthesis import synthesize_for_user

    uid = uuid.UUID(user_id)
    log.info("worker: wiki_synthesize_user start user_id=%s", uid)
    async with async_session_factory() as db:
        result = await synthesize_for_user(db, uid)
        await db.commit()
        log.info("worker: wiki_synthesize_user done user_id=%s result=%s", uid, result)
        return result


async def wiki_extract_session(ctx: dict[str, Any], user_id: str, session_id: str) -> dict:
    """Live-wiki webhook task: extract entities from one freshly-uploaded session."""
    from app.services.wiki_llm_extraction import llm_extract_for_session

    uid = uuid.UUID(user_id)
    sid = uuid.UUID(session_id)
    log.info("worker: wiki_extract_session start user_id=%s session_id=%s", uid, sid)
    async with async_session_factory() as db:
        result = await llm_extract_for_session(db, uid, sid)
        await db.commit()
        log.info("worker: wiki_extract_session done user_id=%s result=%s", uid, result)
        return result


async def wiki_create_mem_source(ctx: dict[str, Any], user_id: str, memory_id: str) -> dict:
    """Live-wiki webhook task: create the kind=source `mem-<id>` page for one
    newly-written memory atom. Cheap (no LLM); two DB inserts.
    """
    from datetime import datetime

    from sqlalchemy import select

    from app.models.memory import Memory
    from app.models.wiki import WikiLink, WikiPage

    uid = uuid.UUID(user_id)
    mid = uuid.UUID(memory_id)
    async with async_session_factory() as db:
        mem = await db.scalar(select(Memory).where(Memory.id == mid, Memory.user_id == uid))
        if mem is None:
            return {"status": "not_found"}
        slug = f"mem-{str(mem.id)[:8]}"
        existing = await db.scalar(
            select(WikiPage).where(WikiPage.user_id == uid, WikiPage.slug == slug)
        )
        if existing is not None:
            return {"status": "exists"}
        content = mem.content or ""
        first_line = content.split("\n", 1)[0].strip().lstrip("# ").strip()
        title = (first_line or f"Memory {str(mem.id)[:8]}")[:80]
        page = WikiPage(
            user_id=uid,
            slug=slug,
            title=title,
            kind="source",
            compiled_truth=content,
            frontmatter={
                "source_type": "memory",
                "source_ref": str(mem.id),
                "category": mem.category,
                "tags": mem.tags or [],
            },
            last_synthesis_at=datetime.now(),
            source_count=1,
        )
        db.add(page)
        await db.flush()
        db.add(
            WikiLink(
                user_id=uid,
                from_page_id=page.id,
                to_page_id=None,
                source_type="memory",
                source_ref=str(mem.id),
                link_type="defines",
                confidence=1.0,
                created_at=datetime.now(),
            )
        )
        await db.commit()
        return {"status": "created", "slug": slug}


async def wiki_bootstrap_users(ctx: dict[str, Any], user_ids: list[str]) -> dict:
    """Bootstrap many users in one task. arq workers use a process pool so
    this CAN run in parallel with other tasks; it iterates internally to
    bound per-user concurrency without coordinating across worker procs.
    """
    summary: dict[str, dict] = {}
    for uid_str in user_ids:
        uid = uuid.UUID(uid_str)
        log.info("worker: bootstrap user=%s start", uid)
        try:
            ext = await wiki_extract_user(ctx, uid_str)
            synth = await wiki_synthesize_user(ctx, uid_str)
            summary[uid_str] = {"extraction": ext, "synthesis": synth, "status": "ok"}
        except Exception as e:  # noqa: BLE001
            log.warning("worker: bootstrap user=%s failed: %s", uid, e)
            summary[uid_str] = {"status": "error", "error": str(e)[:300]}
    return {"users_processed": len(summary), "by_user": summary}


# ---------------------------------------------------------------------------
# arq WorkerSettings — entrypoint for `arq app.workers.WorkerSettings`
# ---------------------------------------------------------------------------


def _build_redis_settings() -> RedisSettings:
    """Eagerly build at module import. Worker container is started with
    REDIS_URL in env, so this succeeds. If it doesn't, arq won't load and
    the worker boot script's `import arq, app.workers` probe surfaces the
    error in container logs immediately.
    """
    if not settings.redis_url:
        raise RuntimeError(
            "REDIS_URL is empty — set it to run the worker pool, "
            "or run the API in legacy inline-task mode without it."
        )
    return RedisSettings.from_dsn(settings.redis_url)


class WorkerSettings:
    """arq's expected entry-point. Lists the tasks the worker pool can run
    plus its Redis connection settings.

    `max_jobs` is per-worker-process. With Coolify running 1 worker, this
    is the cap on concurrent tasks across the deployment. 4 = comfortable
    headroom for OpenAI tier-1 limits without saturating the worker's
    memory (each task holds an asyncpg connection + ~30k chars of LLM
    context).
    """

    functions = [
        wiki_extract_user,
        wiki_synthesize_user,
        wiki_extract_session,
        wiki_create_mem_source,
        wiki_bootstrap_users,
    ]
    # arq accepts either a RedisSettings instance or a `redis_pool` callable.
    # Instance is simpler — module import already gates on REDIS_URL.
    redis_settings = _build_redis_settings()
    max_jobs = 4
    job_timeout = 1_800  # 30min — extraction + synthesis can be long
    keep_result = 3_600  # keep job results for 1h so /api/jobs/{id} can read


__all__ = [
    "WorkerSettings",
    "wiki_extract_user",
    "wiki_synthesize_user",
    "wiki_extract_session",
    "wiki_create_mem_source",
    "wiki_bootstrap_users",
]
