from __future__ import annotations

import logging
import re

_HTTP_CLIENT_LOGGERS = ("httpx", "httpcore", "httpx2", "httpcore2")
TELEGRAM_BOT_API_PATH_RE = re.compile(
    r"^(?P<prefix>/(?:api|v1)/channels/telegram/(?:file/)?bot/?)[^/]+(?P<suffix>/.*)?$",
    re.IGNORECASE,
)
_DISCORD_TOKEN_PATH_RE = re.compile(
    r"^(?P<prefix>/(?:api|v1)/channels/discord/(?:api/)?v10/"
    r"(?:interactions|webhooks)/[^/]+/)[^/]+(?P<suffix>/.*)?$",
    re.IGNORECASE,
)
_DISCORD_GATEWAY_PATH_RE = re.compile(
    r"^(?P<prefix>/(?:api|v1)/channels/discord/gateway/)[^/]+(?P<suffix>/.*)?$",
    re.IGNORECASE,
)


def redact_request_path(path: str) -> str:
    """Keep route context without credentials embedded in channel URL paths."""
    for pattern in (
        TELEGRAM_BOT_API_PATH_RE,
        _DISCORD_TOKEN_PATH_RE,
        _DISCORD_GATEWAY_PATH_RE,
    ):
        match = pattern.match(path)
        if match is not None:
            return f"{match.group('prefix')}[redacted]{match.group('suffix') or ''}"
    return path


def configure_application_logging() -> None:
    logging.basicConfig(level=logging.INFO)
    # HTTP client INFO records include complete request URLs. Provider URLs can
    # carry routing credentials, so application code logs sanitized failures
    # explicitly instead of emitting the clients' request-level diagnostics.
    for logger_name in _HTTP_CLIENT_LOGGERS:
        logging.getLogger(logger_name).setLevel(logging.WARNING)
