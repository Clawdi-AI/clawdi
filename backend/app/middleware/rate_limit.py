"""In-memory sliding-window rate limiting.

Intended for single-process deployments (supervisord + one uvicorn worker,
or a small fleet where per-node limits are good enough). No Redis.

Use as a FastAPI dependency::

    @router.post("/sensitive", dependencies=[Depends(rate_limit(max_calls=10, period_seconds=60))])
    async def sensitive(...): ...

The dependency picks a key in this order:
  1. authenticated user id (preferred — survives IP rotation)
  2. client IP from X-Forwarded-For or the socket
That way anonymous endpoints still get protection.
"""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from collections.abc import Awaitable, Callable

from fastapi import HTTPException, Request, status

from app.core.config import settings


def rate_limit(
    *,
    max_calls: int,
    period_seconds: int = 60,
) -> Callable[[Request], Awaitable[None]]:
    """Build a dependency enforcing max_calls over a rolling period_seconds window."""

    lock = asyncio.Lock()
    hits: dict[str, list[float]] = defaultdict(list)

    async def _check(request: Request) -> None:
        if settings.disable_rate_limits:
            return

        key = _resolve_key(request)
        now = time.monotonic()
        cutoff = now - period_seconds

        async with lock:
            bucket = hits[key]
            # Drop timestamps older than the window. Amortized O(1) since
            # we only ever append to the end of the list.
            while bucket and bucket[0] < cutoff:
                bucket.pop(0)

            if len(bucket) >= max_calls:
                retry_after = max(1, int(bucket[0] + period_seconds - now))
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=f"Rate limit exceeded. Retry in {retry_after}s.",
                    headers={"Retry-After": str(retry_after)},
                )
            bucket.append(now)

    return _check


def _resolve_key(request: Request) -> str:
    # Prefer the authenticated user id if the route already ran auth.
    auth = getattr(request.state, "auth", None)
    if auth is not None and getattr(auth, "user", None) is not None:
        return f"user:{auth.user.id}"

    # Otherwise fall back to client IP (trust the first X-Forwarded-For hop
    # only when explicitly enabled — prevents header spoofing behind an
    # untrusted proxy).
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return f"ip:{forwarded.split(',')[0].strip()}"

    client = request.client
    return f"ip:{client.host if client else 'unknown'}"
