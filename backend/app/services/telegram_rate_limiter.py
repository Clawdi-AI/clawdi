from __future__ import annotations

import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class TelegramRateLimitDecision:
    allowed: bool
    retry_after_seconds: int | None = None
    scope: str | None = None


@dataclass
class _Bucket:
    tokens: float
    updated_at: float


class TelegramRateLimiter:
    def __init__(
        self,
        *,
        bot_capacity: int = 30,
        bot_refill_per_second: float = 30.0,
        chat_capacity: int = 5,
        chat_refill_per_second: float = 1.0,
        max_buckets: int = 4096,
        idle_ttl_seconds: float = 10 * 60,
        now: Callable[[], float] | None = None,
    ) -> None:
        if bot_capacity <= 0 or chat_capacity <= 0:
            raise ValueError("capacities must be positive")
        if bot_refill_per_second <= 0 or chat_refill_per_second <= 0:
            raise ValueError("refill rates must be positive")
        if max_buckets < 2 or idle_ttl_seconds <= 0:
            raise ValueError("rate limiter bounds must be positive")
        self.bot_capacity = float(bot_capacity)
        self.bot_refill_per_second = bot_refill_per_second
        self.chat_capacity = float(chat_capacity)
        self.chat_refill_per_second = chat_refill_per_second
        self._max_buckets = max_buckets
        # Never expire a bucket before it has naturally refilled to capacity.
        self._idle_ttl_seconds = max(
            idle_ttl_seconds,
            self.bot_capacity / self.bot_refill_per_second,
            self.chat_capacity / self.chat_refill_per_second,
        )
        self._now = now or time.monotonic
        self._buckets: OrderedDict[tuple[str, str, str | None], _Bucket] = OrderedDict()
        self._lock = threading.Lock()

    def check_and_consume(
        self,
        *,
        account_id: str,
        method: str,
        chat_id: str,
    ) -> TelegramRateLimitDecision:
        if not _telegram_send_method_is_limited(method):
            return TelegramRateLimitDecision(allowed=True)

        with self._lock:
            now = self._now()
            self._prune(now)
            bot_decision = self._consume(
                ("bot", account_id, None),
                capacity=self.bot_capacity,
                refill_per_second=self.bot_refill_per_second,
                scope="bot",
                now=now,
            )
            if not bot_decision.allowed:
                return bot_decision
            chat_decision = self._consume(
                ("chat", account_id, chat_id),
                capacity=self.chat_capacity,
                refill_per_second=self.chat_refill_per_second,
                scope="chat",
                now=now,
            )
            if not chat_decision.allowed:
                self._refund(("bot", account_id, None), capacity=self.bot_capacity)
            return chat_decision

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()

    def _consume(
        self,
        key: tuple[str, str, str | None],
        *,
        capacity: float,
        refill_per_second: float,
        scope: str,
        now: float,
    ) -> TelegramRateLimitDecision:
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = _Bucket(tokens=capacity, updated_at=now)
            self._buckets[key] = bucket
        elapsed = max(0.0, now - bucket.updated_at)
        bucket.tokens = min(capacity, bucket.tokens + elapsed * refill_per_second)
        bucket.updated_at = now
        self._buckets.move_to_end(key)
        while len(self._buckets) > self._max_buckets:
            self._buckets.popitem(last=False)
        if bucket.tokens >= 1.0:
            bucket.tokens -= 1.0
            return TelegramRateLimitDecision(allowed=True)
        retry_after = max(1, int((1.0 - bucket.tokens) / refill_per_second) + 1)
        return TelegramRateLimitDecision(
            allowed=False,
            retry_after_seconds=retry_after,
            scope=scope,
        )

    def _refund(self, key: tuple[str, str, str | None], *, capacity: float) -> None:
        bucket = self._buckets.get(key)
        if bucket is not None:
            bucket.tokens = min(capacity, bucket.tokens + 1.0)
            self._buckets.move_to_end(key)

    def _prune(self, now: float) -> None:
        expired = [
            key
            for key, bucket in self._buckets.items()
            if bucket.updated_at + self._idle_ttl_seconds <= now
        ]
        for key in expired:
            self._buckets.pop(key, None)


def _telegram_send_method_is_limited(method: str) -> bool:
    normalized = method.lower()
    return normalized.startswith("send") and normalized != "sendchataction"


telegram_rate_limiter = TelegramRateLimiter()
