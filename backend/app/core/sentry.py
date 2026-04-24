"""Sentry initialization — strictly opt-in.

If ``SENTRY_DSN`` is unset, this is a no-op: nothing imports Sentry, nothing
runs. That keeps the minimum-viable self-hosted deployment free of
telemetry dependencies.

When the DSN *is* set, we install the FastAPI + Starlette integrations and
scrub a conservative set of sensitive keys before events are sent.
"""

from __future__ import annotations

import logging
from typing import Any

from app.core.config import settings

logger = logging.getLogger(__name__)

_SENSITIVE_KEYS = {
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-clawdi-token",
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "session_token",
    "password",
    "secret",
    "api_key",
    "apikey",
    "private_key",
    "encryption_key",
    "vault_encryption_key",
}
_SENSITIVE_SUFFIXES = ("_token", "_secret", "_password", "_api_key", "_key")


def init_sentry() -> None:
    if not settings.sentry_dsn:
        return

    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
    except ImportError:
        logger.warning("SENTRY_DSN is set but sentry-sdk is not installed — skipping init.")
        return

    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.sentry_environment or settings.environment,
        traces_sample_rate=settings.sentry_traces_sample_rate,
        send_default_pii=False,
        integrations=[
            FastApiIntegration(),
            StarletteIntegration(),
        ],
        before_send=_scrub_event,
    )


def _scrub_event(event: dict[str, Any], _hint: dict[str, Any]) -> dict[str, Any]:
    """Walk the event and redact anything that looks like a credential."""
    _scrub(event)
    return event


def _scrub(obj: Any) -> None:
    if isinstance(obj, dict):
        for key, value in list(obj.items()):
            if _is_sensitive_key(key):
                obj[key] = "[redacted]"
            else:
                _scrub(value)
    elif isinstance(obj, list):
        for item in obj:
            _scrub(item)


def _is_sensitive_key(key: Any) -> bool:
    if not isinstance(key, str):
        return False
    lowered = key.lower()
    if lowered in _SENSITIVE_KEYS:
        return True
    return any(lowered.endswith(suffix) for suffix in _SENSITIVE_SUFFIXES)
