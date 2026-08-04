from __future__ import annotations

import ipaddress

_PRIVATE_HOST_ALIASES = {
    "localhost",
    "ip6-localhost",
    "metadata",
    "metadata.google.internal",
}
_PRIVATE_HOST_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa", ".svc")


def is_private_hostname(hostname: str | None) -> bool:
    host = _normalize_hostname(hostname)
    if not host:
        return True
    if host in _PRIVATE_HOST_ALIASES:
        return True
    if any(host == suffix[1:] or host.endswith(suffix) for suffix in _PRIVATE_HOST_SUFFIXES):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    return not ip.is_global or ip.is_multicast or ip.is_reserved


def _normalize_hostname(hostname: str | None) -> str:
    host = (hostname or "").strip().lower().rstrip(".")
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    return host
