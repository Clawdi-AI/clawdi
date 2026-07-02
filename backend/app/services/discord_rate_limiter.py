from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol


class HeaderReader(Protocol):
    def get(self, key: str, default: str | None = None) -> str | None: ...


@dataclass
class DiscordRateLimitDecision:
    allowed: bool
    retry_after_seconds: float | None = None
    global_limit: bool = False


@dataclass
class DiscordBucketState:
    remaining: int
    reset_at: float
    limit: int | None = None
    bucket_id: str | None = None


class DiscordRateLimiter:
    def __init__(
        self,
        *,
        global_per_second: int = 50,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._global_per_second = global_per_second
        self._global_window_started_at = 0.0
        self._global_count = 0
        self._buckets: dict[str, DiscordBucketState] = {}
        self._now = now or time.monotonic

    def check(self, method: str, path: str) -> DiscordRateLimitDecision:
        now = self._now()
        if now - self._global_window_started_at >= 1:
            self._global_window_started_at = now
            self._global_count = 0
        if self._global_count >= self._global_per_second:
            retry_after = max(0.1, self._global_window_started_at + 1 - now)
            return DiscordRateLimitDecision(
                allowed=False,
                retry_after_seconds=retry_after,
                global_limit=True,
            )

        key = self.route_key(method, path)
        bucket = self._buckets.get(key)
        if bucket is None:
            return DiscordRateLimitDecision(allowed=True)
        if bucket.reset_at <= now:
            self._buckets.pop(key, None)
            return DiscordRateLimitDecision(allowed=True)
        if bucket.remaining > 0:
            return DiscordRateLimitDecision(allowed=True)
        return DiscordRateLimitDecision(
            allowed=False,
            retry_after_seconds=max(0.1, bucket.reset_at - now),
        )

    def consume(self, method: str, path: str) -> None:
        now = self._now()
        if now - self._global_window_started_at >= 1:
            self._global_window_started_at = now
            self._global_count = 0
        self._global_count += 1

        bucket = self._buckets.get(self.route_key(method, path))
        if bucket and bucket.reset_at > now and bucket.remaining > 0:
            bucket.remaining -= 1

    def observe(self, method: str, path: str, headers: HeaderReader, status_code: int) -> None:
        now = self._now()
        reset_after = _float_header(headers, "x-ratelimit-reset-after")
        retry_after = _float_header(headers, "retry-after")
        remaining = _int_header(headers, "x-ratelimit-remaining")
        limit = _int_header(headers, "x-ratelimit-limit")
        bucket_id = headers.get("x-ratelimit-bucket")
        global_header = (headers.get("x-ratelimit-global") or "").lower() == "true"

        if status_code == 429 and global_header:
            self._global_window_started_at = now
            self._global_count = self._global_per_second
            return

        if status_code == 429:
            self._buckets[self.route_key(method, path)] = DiscordBucketState(
                remaining=0,
                reset_at=now + (retry_after or reset_after or 1.0),
                limit=limit,
                bucket_id=bucket_id,
            )
            return

        if remaining is None or reset_after is None:
            return
        self._buckets[self.route_key(method, path)] = DiscordBucketState(
            remaining=remaining,
            reset_at=now + reset_after,
            limit=limit,
            bucket_id=bucket_id,
        )

    def route_key(self, method: str, path: str) -> str:
        normalized = path.split("?", 1)[0]
        normalized = normalized.removeprefix("/v1/channels/discord/v10")
        normalized = normalized.removeprefix("/api/channels/discord/v10")
        normalized = normalized.removeprefix("/api/v10")
        segments = [segment for segment in normalized.split("/") if segment]
        major = "-"
        parts: list[str] = []
        for segment in segments:
            if segment.isdigit() and len(segment) >= 10:
                if major == "-":
                    major = segment
                    parts.append(":major")
                else:
                    parts.append(":id")
            elif len(segment) >= 20 and all(ch.isalnum() or ch in "_-" for ch in segment):
                parts.append(":token")
            else:
                parts.append(segment)
        return f"{method.upper()} /{'/'.join(parts)}|{major}"

    def inspect(self, method: str, path: str) -> DiscordBucketState | None:
        return self._buckets.get(self.route_key(method, path))


def _float_header(headers: HeaderReader, key: str) -> float | None:
    raw = headers.get(key)
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _int_header(headers: HeaderReader, key: str) -> int | None:
    raw = headers.get(key)
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


discord_rate_limiter = DiscordRateLimiter()
