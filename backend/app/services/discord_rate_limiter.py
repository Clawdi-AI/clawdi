from __future__ import annotations

import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass


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


@dataclass
class _DiscordGlobalState:
    window_started_at: float
    count: int = 0
    blocked_until: float = 0.0
    updated_at: float = 0.0


class DiscordRateLimiter:
    """Process-local Discord REST limiter scoped to one authentication identity.

    Discord applies per-route and global limits to the authenticated bot or
    user. ``account_scope`` must therefore be a stable, non-secret account or
    application identifier, never a provider token.
    """

    def __init__(
        self,
        *,
        global_per_second: int = 50,
        max_buckets: int = 4096,
        max_scopes: int = 2048,
        scope_idle_ttl_seconds: float = 10 * 60,
        now: Callable[[], float] | None = None,
    ) -> None:
        if global_per_second <= 0:
            raise ValueError("global_per_second must be positive")
        if max_buckets <= 0 or max_scopes <= 0:
            raise ValueError("rate limiter bounds must be positive")
        if scope_idle_ttl_seconds <= 0:
            raise ValueError("scope_idle_ttl_seconds must be positive")
        self._global_per_second = global_per_second
        self._max_buckets = max_buckets
        self._max_scopes = max_scopes
        self._scope_idle_ttl_seconds = scope_idle_ttl_seconds
        self._global_states: OrderedDict[str, _DiscordGlobalState] = OrderedDict()
        self._buckets: OrderedDict[str, DiscordBucketState] = OrderedDict()
        self._now = now or time.monotonic
        self._lock = threading.Lock()

    def check(
        self,
        account_scope: str,
        method: str,
        path: str,
    ) -> DiscordRateLimitDecision:
        now = self._now()
        with self._lock:
            self._prune(now)
            global_state = self._global_states.get(account_scope)
            if global_state is not None:
                self._touch_global(account_scope, global_state, now)
                if global_state.blocked_until > now:
                    return DiscordRateLimitDecision(
                        allowed=False,
                        retry_after_seconds=global_state.blocked_until - now,
                        global_limit=True,
                    )
                global_state.blocked_until = 0.0
                if now - global_state.window_started_at >= 1:
                    global_state.window_started_at = now
                    global_state.count = 0
                if global_state.count >= self._global_per_second:
                    retry_after = max(0.1, global_state.window_started_at + 1 - now)
                    return DiscordRateLimitDecision(
                        allowed=False,
                        retry_after_seconds=retry_after,
                        global_limit=True,
                    )

            key = self.route_key(account_scope, method, path)
            bucket = self._buckets.get(key)
            if bucket is None:
                return DiscordRateLimitDecision(allowed=True)
            self._buckets.move_to_end(key)
            if bucket.remaining > 0:
                return DiscordRateLimitDecision(allowed=True)
            return DiscordRateLimitDecision(
                allowed=False,
                retry_after_seconds=max(0.1, bucket.reset_at - now),
            )

    def consume(self, account_scope: str, method: str, path: str) -> None:
        now = self._now()
        with self._lock:
            self._prune(now)
            global_state = self._global_states.get(account_scope)
            if global_state is None:
                global_state = _DiscordGlobalState(
                    window_started_at=now,
                    updated_at=now,
                )
                self._global_states[account_scope] = global_state
            elif now - global_state.window_started_at >= 1:
                global_state.window_started_at = now
                global_state.count = 0
            global_state.count += 1
            self._touch_global(account_scope, global_state, now)
            self._enforce_scope_bound()

            key = self.route_key(account_scope, method, path)
            bucket = self._buckets.get(key)
            if bucket is not None and bucket.remaining > 0:
                bucket.remaining -= 1
                self._buckets.move_to_end(key)

    def observe(
        self,
        account_scope: str,
        method: str,
        path: str,
        headers: Mapping[str, str],
        status_code: int,
    ) -> None:
        now = self._now()
        reset_after = _float_header(headers, "x-ratelimit-reset-after")
        retry_after = _float_header(headers, "retry-after")
        remaining = _int_header(headers, "x-ratelimit-remaining")
        limit = _int_header(headers, "x-ratelimit-limit")
        bucket_id = headers.get("x-ratelimit-bucket")
        global_header = (headers.get("x-ratelimit-global") or "").lower() == "true"

        with self._lock:
            self._prune(now)
            if status_code == 429 and global_header:
                delay = retry_after if retry_after is not None else reset_after
                if delay is not None:
                    global_state = self._global_states.get(account_scope)
                    if global_state is None:
                        global_state = _DiscordGlobalState(
                            window_started_at=now,
                            updated_at=now,
                        )
                        self._global_states[account_scope] = global_state
                    global_state.blocked_until = max(
                        global_state.blocked_until,
                        now + max(0.0, delay),
                    )
                    self._touch_global(account_scope, global_state, now)
                    self._enforce_scope_bound()
                return

            key = self.route_key(account_scope, method, path)
            if status_code == 429:
                delay = retry_after if retry_after is not None else reset_after
                if delay is None:
                    return
                self._store_bucket(
                    key,
                    DiscordBucketState(
                        remaining=0,
                        reset_at=now + max(0.0, delay),
                        limit=limit,
                        bucket_id=bucket_id,
                    ),
                )
                return

            if remaining is None or reset_after is None:
                return
            self._store_bucket(
                key,
                DiscordBucketState(
                    remaining=remaining,
                    reset_at=now + max(0.0, reset_after),
                    limit=limit,
                    bucket_id=bucket_id,
                ),
            )

    def route_key(self, account_scope: str, method: str, path: str) -> str:
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
        return f"{account_scope}|{method.upper()} /{'/'.join(parts)}|{major}"

    def inspect(
        self,
        account_scope: str,
        method: str,
        path: str,
    ) -> DiscordBucketState | None:
        now = self._now()
        with self._lock:
            self._prune(now)
            key = self.route_key(account_scope, method, path)
            bucket = self._buckets.get(key)
            if bucket is not None:
                self._buckets.move_to_end(key)
            return bucket

    def reset(self) -> None:
        with self._lock:
            self._global_states.clear()
            self._buckets.clear()

    def _store_bucket(self, key: str, bucket: DiscordBucketState) -> None:
        if bucket.reset_at <= self._now():
            self._buckets.pop(key, None)
            return
        self._buckets[key] = bucket
        self._buckets.move_to_end(key)
        while len(self._buckets) > self._max_buckets:
            self._buckets.popitem(last=False)

    def _touch_global(
        self,
        account_scope: str,
        state: _DiscordGlobalState,
        now: float,
    ) -> None:
        state.updated_at = now
        self._global_states.move_to_end(account_scope)

    def _enforce_scope_bound(self) -> None:
        while len(self._global_states) > self._max_scopes:
            self._global_states.popitem(last=False)

    def _prune(self, now: float) -> None:
        expired_bucket_keys = [
            key for key, bucket in self._buckets.items() if bucket.reset_at <= now
        ]
        for key in expired_bucket_keys:
            self._buckets.pop(key, None)

        expired_scope_keys = [
            key
            for key, state in self._global_states.items()
            if state.blocked_until <= now
            and state.window_started_at + 1 <= now
            and state.updated_at + self._scope_idle_ttl_seconds <= now
        ]
        for key in expired_scope_keys:
            self._global_states.pop(key, None)


def _float_header(headers: Mapping[str, str], key: str) -> float | None:
    raw = headers.get(key)
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _int_header(headers: Mapping[str, str], key: str) -> int | None:
    raw = headers.get(key)
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


discord_rate_limiter = DiscordRateLimiter()
