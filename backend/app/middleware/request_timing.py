"""Request timing middleware.

Adds a cheap per-request process-time response header and logs only slow
requests or server errors. Logs intentionally include method/path/status/time
and request id only; query strings, headers, bodies, and user identity stay out
of application logs.
"""

from __future__ import annotations

import logging
import re
import time

from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)
_PROCESS_TIME_HEADER = b"x-process-time-ms"
_SYNC_EVENTS_PATH = "/api/sync/events"
_TELEGRAM_BOT_API_PATH_RE = re.compile(
    r"^(?P<prefix>/(?:api|v1)/channels/telegram/(?:file/)?bot/?)[^/]+(?P<suffix>/.*)?$",
    re.IGNORECASE,
)


class RequestTimingMiddleware:
    def __init__(self, app: ASGIApp, *, slow_ms: float) -> None:
        self.app = app
        self.slow_ms = slow_ms

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        started = time.perf_counter()
        raw_method: object = scope.get("method", "GET")
        method = raw_method if isinstance(raw_method, str) else "GET"
        raw_path_value: object = scope.get("path", "")
        raw_path = raw_path_value if isinstance(raw_path_value, str) else ""
        path = _log_safe_path(raw_path)
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
                "request_failed method=%s path=%s status=500 duration_ms=%.1f request_id=%s",
                method,
                path,
                duration_ms,
                _request_id(scope),
            )
            raise

        duration_ms = _elapsed_ms(started)
        if status_code >= 500:
            logger.warning(
                "request_error method=%s path=%s status=%d duration_ms=%.1f request_id=%s",
                method,
                path,
                status_code,
                duration_ms,
                _request_id(scope),
            )
        elif not _is_expected_long_request(raw_path) and _is_slow(
            duration_ms=duration_ms,
            slow_ms=self.slow_ms,
        ):
            logger.warning(
                "request_slow method=%s path=%s status=%d duration_ms=%.1f request_id=%s",
                method,
                path,
                status_code,
                duration_ms,
                _request_id(scope),
            )


def _elapsed_ms(started: float) -> float:
    return (time.perf_counter() - started) * 1000


def _is_slow(*, duration_ms: float, slow_ms: float) -> bool:
    return slow_ms > 0 and duration_ms >= slow_ms


def _log_safe_path(path: str) -> str:
    match = _TELEGRAM_BOT_API_PATH_RE.match(path)
    if match is None:
        return path
    return f"{match.group('prefix')}[redacted]{match.group('suffix') or ''}"


def _is_expected_long_request(path: str) -> bool:
    if path == _SYNC_EVENTS_PATH:
        return True
    match = _TELEGRAM_BOT_API_PATH_RE.match(path)
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
