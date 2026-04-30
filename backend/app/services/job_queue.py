"""Tiny wrapper around arq's redis pool, used by FastAPI to enqueue worker jobs.

Lazy-initialized singleton. When `settings.redis_url` is empty, every helper
returns None — callers fall back to the legacy inline / BackgroundTasks path,
so single-instance preview deploys keep working.
"""

from __future__ import annotations

import logging
from typing import Any

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings

from app.core.config import settings

log = logging.getLogger(__name__)

_pool: ArqRedis | None = None


async def get_pool() -> ArqRedis | None:
    """Return the shared arq redis pool, or None if Redis isn't configured.

    First call creates the pool; subsequent calls return the cache. We don't
    eagerly connect at startup — the connection lazily comes up on first
    enqueue, which keeps the API healthy if Redis is briefly unavailable.
    """
    global _pool
    if not settings.redis_url:
        return None
    if _pool is None:
        try:
            _pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
        except Exception as e:  # noqa: BLE001 — fall back to inline path
            log.warning("redis pool unavailable, jobs will run inline: %s", e)
            _pool = None
            return None
    return _pool


async def enqueue(function: str, *args: Any, **kwargs: Any) -> str | None:
    """Enqueue an arq job. Returns the job_id, or None if Redis isn't
    available (caller must run the work inline).
    """
    pool = await get_pool()
    if pool is None:
        return None
    job = await pool.enqueue_job(function, *args, **kwargs)
    return job.job_id if job else None


async def get_job_status(job_id: str) -> dict[str, Any] | None:
    """Look up job state for `/api/jobs/{job_id}`. Returns None when the
    job has expired out of arq's keep_result window or never existed.
    """
    from arq.jobs import Job, JobStatus

    pool = await get_pool()
    if pool is None:
        return None
    job = Job(job_id, pool)
    status = await job.status()
    out: dict[str, Any] = {"job_id": job_id, "status": status.value}
    if status in {JobStatus.complete, JobStatus.in_progress}:
        info = await job.info()
        if info is not None:
            out["enqueue_time"] = info.enqueue_time.isoformat() if info.enqueue_time else None
    if status == JobStatus.complete:
        try:
            out["result"] = await job.result(timeout=0.1)
        except Exception as e:  # noqa: BLE001
            out["result_error"] = str(e)[:200]
    return out
