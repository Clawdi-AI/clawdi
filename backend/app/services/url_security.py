from __future__ import annotations

from collections.abc import Iterable
from urllib.parse import urlparse

from app.services.private_ip import has_private_resolved_ip, is_private_hostname

_CHANNEL_HTTP_SCHEMES = frozenset({"https"})
_CHANNEL_WEBSOCKET_SCHEMES = frozenset({"wss"})


class UnsafeOutboundUrlError(ValueError):
    pass


async def validate_channel_http_url(url: str, *, label: str) -> None:
    await validate_outbound_url(
        url,
        allowed_schemes=_CHANNEL_HTTP_SCHEMES,
        label=label,
    )


async def validate_channel_websocket_url(url: str, *, label: str) -> None:
    await validate_outbound_url(
        url,
        allowed_schemes=_CHANNEL_WEBSOCKET_SCHEMES,
        label=label,
    )


async def validate_outbound_url(
    url: str,
    *,
    allowed_schemes: Iterable[str],
    label: str,
) -> None:
    schemes = {scheme.lower() for scheme in allowed_schemes}
    candidate = url.strip()
    try:
        parsed = urlparse(candidate)
        parsed.port
    except ValueError as exc:
        raise UnsafeOutboundUrlError(f"{label} must use {_scheme_list(schemes)}") from exc
    if parsed.scheme.lower() not in schemes or not parsed.netloc or not parsed.hostname:
        raise UnsafeOutboundUrlError(f"{label} must use {_scheme_list(schemes)}")
    if is_private_hostname(parsed.hostname):
        raise UnsafeOutboundUrlError(f"{label} targets a private host")
    if await has_private_resolved_ip(parsed.hostname):
        raise UnsafeOutboundUrlError(f"{label} resolves to a private host")


def _scheme_list(schemes: set[str]) -> str:
    return " or ".join(sorted(schemes))
