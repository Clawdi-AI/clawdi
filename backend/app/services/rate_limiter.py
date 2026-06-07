from __future__ import annotations

import math
import time
from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class RateLimitResult:
    allowed: bool
    retry_after_ms: int = 0


class TokenBucket:
    def __init__(
        self,
        capacity: int,
        refill_rate: float,
        *,
        now: Callable[[], float] | None = None,
    ) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        if refill_rate <= 0:
            raise ValueError("refill_rate must be positive")
        self._capacity = float(capacity)
        self._refill_rate = float(refill_rate)
        self._tokens = float(capacity)
        self._now = now or time.monotonic
        self._last_refill = self._now()

    def try_consume(self, count: int = 1) -> RateLimitResult:
        if count <= 0:
            raise ValueError("count must be positive")
        self._refill()
        if self._tokens >= count:
            self._tokens -= count
            return RateLimitResult(allowed=True)
        deficit = count - self._tokens
        retry_after_ms = math.ceil((deficit / self._refill_rate) * 1000)
        return RateLimitResult(allowed=False, retry_after_ms=retry_after_ms)

    def _refill(self) -> None:
        now = self._now()
        elapsed = max(0.0, now - self._last_refill)
        self._tokens = min(self._capacity, self._tokens + elapsed * self._refill_rate)
        self._last_refill = now


class RateLimiter:
    def __init__(
        self,
        capacity: int,
        refill_rate: float,
        *,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._capacity = capacity
        self._refill_rate = refill_rate
        self._now = now or time.monotonic
        self._buckets: dict[str, TokenBucket] = {}

    def try_consume(self, key: str, count: int = 1) -> RateLimitResult:
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = TokenBucket(self._capacity, self._refill_rate, now=self._now)
            self._buckets[key] = bucket
        return bucket.try_consume(count)
