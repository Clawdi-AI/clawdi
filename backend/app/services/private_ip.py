from __future__ import annotations

import asyncio
import ipaddress
import socket

_CGNAT = ipaddress.ip_network("100.64.0.0/10")
_PRIVATE_HOST_ALIASES = {
    "localhost",
    "ip6-localhost",
    "metadata",
    "metadata.google.internal",
}


def is_private_hostname(hostname: str | None) -> bool:
    host = _normalize_hostname(hostname)
    if not host:
        return True
    if host in _PRIVATE_HOST_ALIASES:
        return True
    if host.endswith(".local") or host.endswith(".localhost"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    return (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_unspecified
        or (ip.version == 4 and ip in _CGNAT)
    )


async def has_private_resolved_ip(hostname: str | None) -> bool:
    host = _normalize_hostname(hostname)
    if not host:
        return True
    if is_private_hostname(host):
        return True
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, None)
    except OSError:
        return True
    if not infos:
        return True
    for info in infos:
        address = info[4][0]
        if is_private_hostname(address):
            return True
    return False


def _normalize_hostname(hostname: str | None) -> str:
    host = (hostname or "").strip().lower().rstrip(".")
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    return host
