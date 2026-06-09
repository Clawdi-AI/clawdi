from __future__ import annotations

import threading
import time
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
    ) -> None:
        self.bot_capacity = float(bot_capacity)
        self.bot_refill_per_second = bot_refill_per_second
        self.chat_capacity = float(chat_capacity)
        self.chat_refill_per_second = chat_refill_per_second
        self._buckets: dict[tuple[str, str, str | None], _Bucket] = {}
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
            bot_decision = self._consume(
                ("bot", account_id, None),
                capacity=self.bot_capacity,
                refill_per_second=self.bot_refill_per_second,
                scope="bot",
            )
            if not bot_decision.allowed:
                return bot_decision
            chat_decision = self._consume(
                ("chat", account_id, chat_id),
                capacity=self.chat_capacity,
                refill_per_second=self.chat_refill_per_second,
                scope="chat",
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
    ) -> TelegramRateLimitDecision:
        now = time.monotonic()
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = _Bucket(tokens=capacity, updated_at=now)
            self._buckets[key] = bucket
        elapsed = max(0.0, now - bucket.updated_at)
        bucket.tokens = min(capacity, bucket.tokens + elapsed * refill_per_second)
        bucket.updated_at = now
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


def _telegram_send_method_is_limited(method: str) -> bool:
    normalized = method.lower()
    return normalized.startswith("send") and normalized != "sendchataction"


telegram_rate_limiter = TelegramRateLimiter()
