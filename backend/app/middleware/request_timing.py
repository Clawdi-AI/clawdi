"""Request timing middleware.

Adds a cheap per-request process-time response header and logs only slow
requests or server errors. Logs intentionally include method/path/status/time
and request id, plus fixed channel stage timings; query strings, headers, bodies,
and user identity stay out of application logs.
"""

from __future__ import annotations

import logging
import math
import time
from collections.abc import Generator
from contextlib import contextmanager
from typing import Literal, cast

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.logging_config import TELEGRAM_BOT_API_PATH_RE, redact_request_path

logger = logging.getLogger(__name__)
_PROCESS_TIME_HEADER = b"x-process-time-ms"
_SYNC_EVENTS_PATHS = frozenset(("/v1/sync/events", "/api/sync/events"))


# Wall-clock stages include event-loop waits. Initially instrumented only on the
# Telegram Bot API proxy. Provider time includes pool waits, TCP/TLS and RTT,
# not just provider processing. Request body arrival/parsing, response parsing
# and result reference writes remain unattributed: the stage sum is not the
# whole request duration.
type ChannelStage = Literal["channel_auth_ms", "channel_url_validation_ms", "channel_provider_ms"]
_CHANNEL_STAGES: tuple[ChannelStage, ...] = (
    "channel_auth_ms",
    "channel_url_validation_ms",
    "channel_provider_ms",
)
_CHANNEL_TIMING_STATE = "_channel_stage_timings"


@contextmanager
def channel_stage(scope: Scope, stage: ChannelStage) -> Generator[None]:
    started = time.perf_counter()
    try:
        yield
    finally:
        scope.setdefault("state", {}).setdefault(_CHANNEL_TIMING_STATE, {})[stage] = _elapsed_ms(
            started
        )


def _channel_stage_log_fields(scope: Scope) -> str:
    timings: object = scope.get("state", {}).get(_CHANNEL_TIMING_STATE)
    if not isinstance(timings, dict):
        return ""
    values = cast(dict[object, object], timings)
    fields: list[str] = []
    for stage in _CHANNEL_STAGES:
        value = values.get(stage)
        if isinstance(value, float) and math.isfinite(value) and value >= 0:
            fields.append(f" {stage}={value:.1f}")
    return "".join(fields)


class RequestTimingMiddleware:
    def __init__(self, app: ASGIApp, *, slow_ms: float) -> None:
        self.app = app
        self.slow_ms = slow_ms

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # ASGI lifespan state is shallow-copied; replace the nested dict per request.
        scope.setdefault("state", {})[_CHANNEL_TIMING_STATE] = {}
        started = time.perf_counter()
        raw_method: object = scope.get("method", "GET")
        method = raw_method if isinstance(raw_method, str) else "GET"
        raw_path_value: object = scope.get("path", "")
        raw_path = raw_path_value if isinstance(raw_path_value, str) else ""
        path = redact_request_path(raw_path)
        status_code = 500

        async def timed_send(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = int(message["status"])
                duration_ms = _elapsed_ms(started)
                headers = list(message.get("headers", []))
                if not any(name.lower() == _PROCESS_TIME_HEADER for name, _ in headers):
                    headers.append((_PROCESS_TIME_HEADER, f"{duration_ms:.1f}".encode("ascii")))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, timed_send)
        except Exception:
            duration_ms = _elapsed_ms(started)
            logger.exception(
                "request_failed method=%s path=%s status=500 duration_ms=%.1f request_id=%s%s",
                method,
                path,
                duration_ms,
                _request_id(scope),
                _channel_stage_log_fields(scope),
            )
            raise

        duration_ms = _elapsed_ms(started)
        if status_code >= 500:
            logger.warning(
                "request_error method=%s path=%s status=%d duration_ms=%.1f request_id=%s%s",
                method,
                path,
                status_code,
                duration_ms,
                _request_id(scope),
                _channel_stage_log_fields(scope),
            )
        elif not _is_expected_long_request(raw_path) and _is_slow(
            duration_ms=duration_ms,
            slow_ms=self.slow_ms,
        ):
            logger.warning(
                "request_slow method=%s path=%s status=%d duration_ms=%.1f request_id=%s%s",
                method,
                path,
                status_code,
                duration_ms,
                _request_id(scope),
                _channel_stage_log_fields(scope),
            )


def _elapsed_ms(started: float) -> float:
    return (time.perf_counter() - started) * 1000


def _is_slow(*, duration_ms: float, slow_ms: float) -> bool:
    return slow_ms > 0 and duration_ms >= slow_ms


def _is_expected_long_request(path: str) -> bool:
    if path in _SYNC_EVENTS_PATHS:
        return True
    match = TELEGRAM_BOT_API_PATH_RE.match(path)
    if match is None or "/file/" in match.group("prefix").lower():
        return False
    return (match.group("suffix") or "").lower() == "/getupdates"


def _request_id(scope: Scope) -> str:
    state: object = scope.get("state")
    match state:
        case {"request_id": str(value)} if value:
            return value
        case _:
            pass
    return "-"
