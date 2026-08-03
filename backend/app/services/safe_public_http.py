"""Bounded HTTP delivery to DNS-validated public endpoints."""

from __future__ import annotations

import asyncio
import ipaddress
import math
import socket
import ssl
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Literal

import httpx
from pydantic import JsonValue

from app.services.private_ip import is_private_hostname

_DNS_TIMEOUT_SECONDS = 3.0
_MAX_PUBLIC_ADDRESSES = 4
_MAX_RESPONSE_BYTES = 64 * 1024
_REQUEST_TIMEOUT = httpx.Timeout(connect=4.0, read=8.0, write=4.0, pool=2.0)
_TOTAL_REQUEST_TIMEOUT_SECONDS = 10.0
_HTTPS_SCHEMES = frozenset({"https"})

UnsafeUrlReason = Literal["invalid", "private_host", "private_address"]


class SafePublicHttpError(Exception):
    """A redacted failure from a safe public HTTP request."""


class UnsafePublicHttpUrlError(SafePublicHttpError, ValueError):
    def __init__(self, reason: UnsafeUrlReason) -> None:
        self.reason = reason
        messages = {
            "invalid": "Public HTTP URL is invalid.",
            "private_host": "Public HTTP URL targets a non-public host.",
            "private_address": "Public HTTP hostname resolves to a non-public address.",
        }
        super().__init__(messages[reason])


class SafePublicHttpDnsTimeout(SafePublicHttpError, TimeoutError):
    def __init__(self) -> None:
        super().__init__("Public HTTP hostname lookup timed out.")


class SafePublicHttpDnsError(SafePublicHttpError):
    def __init__(self) -> None:
        super().__init__("Public HTTP hostname could not be resolved.")


class SafePublicHttpTimeout(SafePublicHttpError, TimeoutError):
    def __init__(self) -> None:
        super().__init__("Public HTTP request timed out.")


class SafePublicHttpTlsError(SafePublicHttpError):
    def __init__(self) -> None:
        super().__init__("Public HTTP TLS verification failed.")


class SafePublicHttpConnectError(SafePublicHttpError):
    def __init__(self) -> None:
        super().__init__("Public HTTP endpoint could not be reached.")


class SafePublicHttpRequestError(SafePublicHttpError):
    def __init__(self) -> None:
        super().__init__("Public HTTP request failed.")


class SafePublicHttpResponseTooLarge(SafePublicHttpError):
    def __init__(self) -> None:
        super().__init__("Public HTTP response exceeded the size limit.")


@dataclass(frozen=True, slots=True)
class ResolvedPublicHttpTarget:
    url: httpx.URL
    addresses: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SafePublicHttpResponse:
    status_code: int
    headers: httpx.Headers
    body: bytes

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300


def parse_public_http_url(
    url: str | httpx.URL,
    *,
    allowed_schemes: Iterable[str] = _HTTPS_SCHEMES,
) -> httpx.URL:
    schemes = frozenset(scheme.lower() for scheme in allowed_schemes)
    try:
        candidate = url if isinstance(url, httpx.URL) else httpx.URL(url.strip())
    except (TypeError, ValueError, httpx.InvalidURL):
        raise UnsafePublicHttpUrlError("invalid") from None
    port = candidate.port
    if (
        candidate.scheme.lower() not in schemes
        or not candidate.raw_host
        or candidate.userinfo
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise UnsafePublicHttpUrlError("invalid")
    if is_private_hostname(candidate.raw_host.decode("ascii")):
        raise UnsafePublicHttpUrlError("private_host")
    return candidate


async def resolve_public_http_target(
    url: str | httpx.URL,
    *,
    allowed_schemes: Iterable[str] = _HTTPS_SCHEMES,
    dns_timeout_seconds: float = _DNS_TIMEOUT_SECONDS,
) -> ResolvedPublicHttpTarget:
    candidate = parse_public_http_url(url, allowed_schemes=allowed_schemes)
    hostname = candidate.raw_host.decode("ascii")
    default_port = 443 if candidate.scheme in {"https", "wss"} else 80
    port = candidate.port if candidate.port is not None else default_port
    addresses = await _resolve_public_addresses(
        hostname,
        port,
        timeout_seconds=dns_timeout_seconds,
    )
    ordered = sorted(addresses, key=lambda address: ipaddress.ip_address(address).version)
    return ResolvedPublicHttpTarget(url=candidate, addresses=tuple(ordered[:_MAX_PUBLIC_ADDRESSES]))


async def _resolve_public_addresses(
    hostname: str,
    port: int,
    *,
    timeout_seconds: float,
) -> tuple[str, ...]:
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        try:
            infos = await asyncio.wait_for(
                asyncio.to_thread(
                    socket.getaddrinfo,
                    hostname,
                    port,
                    socket.AF_UNSPEC,
                    socket.SOCK_STREAM,
                ),
                timeout=timeout_seconds,
            )
        except TimeoutError:
            raise SafePublicHttpDnsTimeout() from None
        except OSError:
            raise SafePublicHttpDnsError() from None
        raw_addresses = tuple(info[4][0] for info in infos)
    else:
        raw_addresses = (str(literal),)

    if not raw_addresses:
        raise SafePublicHttpDnsError()

    addresses: list[str] = []
    for raw_address in raw_addresses:
        if not isinstance(raw_address, str):
            raise UnsafePublicHttpUrlError("private_address")
        try:
            address = ipaddress.ip_address(raw_address)
        except ValueError:
            raise UnsafePublicHttpUrlError("private_address") from None
        mapped = getattr(address, "ipv4_mapped", None)
        public_address = mapped if mapped is not None else address
        if (
            not public_address.is_global
            or public_address.is_multicast
            or public_address.is_reserved
        ):
            # Validate every answer before applying the dial cap so a private
            # address cannot hide after otherwise valid A/AAAA records.
            raise UnsafePublicHttpUrlError("private_address")
        normalized = str(address)
        if normalized not in addresses:
            addresses.append(normalized)
    if not addresses:
        raise SafePublicHttpDnsError()
    return tuple(addresses)


class SafePublicHttpClient:
    """POST to validated public numeric IPs with bounded time and response size."""

    def __init__(
        self,
        *,
        timeout: httpx.Timeout | float = _REQUEST_TIMEOUT,
        total_timeout_seconds: float = _TOTAL_REQUEST_TIMEOUT_SECONDS,
        dns_timeout_seconds: float = _DNS_TIMEOUT_SECONDS,
        max_response_bytes: int = _MAX_RESPONSE_BYTES,
        verify: ssl.SSLContext | str | bool = True,
    ) -> None:
        if (
            not math.isfinite(total_timeout_seconds)
            or total_timeout_seconds <= 0
            or not math.isfinite(dns_timeout_seconds)
            or dns_timeout_seconds <= 0
            or max_response_bytes < 0
        ):
            raise ValueError("Safe public HTTP timeouts must be positive and limits non-negative")
        self._timeout = timeout
        self._total_timeout_seconds = total_timeout_seconds
        self._dns_timeout_seconds = dns_timeout_seconds
        self._max_response_bytes = max_response_bytes
        self._verify = verify

    async def post(
        self,
        url: str | httpx.URL,
        *,
        headers: Mapping[str, str] | None = None,
        json: JsonValue = None,
    ) -> SafePublicHttpResponse:
        try:
            async with asyncio.timeout(self._total_timeout_seconds):
                target = await resolve_public_http_target(
                    url,
                    dns_timeout_seconds=self._dns_timeout_seconds,
                )
                return await self._send_to_addresses(
                    target=target,
                    headers=headers,
                    json=json,
                )
        except SafePublicHttpError:
            raise
        except TimeoutError:
            raise SafePublicHttpTimeout() from None
        except httpx.TimeoutException:
            raise SafePublicHttpTimeout() from None
        except httpx.HTTPError:
            raise SafePublicHttpRequestError() from None
        except (TypeError, ValueError):
            raise SafePublicHttpRequestError() from None

    async def _send_to_addresses(
        self,
        *,
        target: ResolvedPublicHttpTarget,
        headers: Mapping[str, str] | None,
        json: JsonValue,
    ) -> SafePublicHttpResponse:
        last_connect_error: httpx.ConnectError | httpx.ConnectTimeout | None = None
        for address in target.addresses:
            try:
                return await self._send_pinned_request(
                    url=target.url,
                    address=address,
                    headers=headers,
                    json=json,
                )
            except httpx.ConnectTimeout as exc:
                last_connect_error = exc
            except httpx.ConnectError as exc:
                if _caused_by_tls(exc):
                    raise SafePublicHttpTlsError() from None
                last_connect_error = exc
        if isinstance(last_connect_error, httpx.ConnectTimeout):
            raise SafePublicHttpTimeout() from None
        if last_connect_error is not None:
            raise SafePublicHttpConnectError() from None
        raise SafePublicHttpConnectError()

    async def _send_pinned_request(
        self,
        *,
        url: httpx.URL,
        address: str,
        headers: Mapping[str, str] | None,
        json: JsonValue,
    ) -> SafePublicHttpResponse:
        original_host = url.raw_host.decode("ascii")
        host_header = f"[{original_host}]" if ":" in original_host else original_host
        if url.port is not None:
            host_header = f"{host_header}:{url.port}"

        request_headers = httpx.Headers(headers)
        request_headers["host"] = host_header
        request_headers.setdefault("accept-encoding", "identity")
        pinned_url = url.copy_with(host=address)

        transport = httpx.AsyncHTTPTransport(
            verify=self._verify,
            trust_env=False,
            retries=0,
        )
        async with httpx.AsyncClient(
            transport=transport,
            timeout=self._timeout,
            follow_redirects=False,
            trust_env=False,
        ) as client:
            # HTTPX 0.28.1 forwards request extensions unchanged to HTTPCore:
            # https://github.com/encode/httpx/blob/26d48e0634e6ee9cdc0533996db289ce4b430177/httpx/_transports/default.py#L381-L394
            # HTTPCore 1.0.9 connects to the URL host but uses sni_hostname for TLS:
            # https://github.com/encode/httpcore/blob/98209758cc14e1a5f966fe1dfdc1064b94055d8c/httpcore/_async/connection.py#L105-L156
            async with client.stream(
                "POST",
                pinned_url,
                headers=request_headers,
                json=json,
                extensions={"sni_hostname": original_host},
            ) as response:
                body = bytearray()
                if response.is_success:
                    async for chunk in response.aiter_raw():
                        if len(body) + len(chunk) > self._max_response_bytes:
                            raise SafePublicHttpResponseTooLarge()
                        body.extend(chunk)
                return SafePublicHttpResponse(
                    status_code=response.status_code,
                    headers=httpx.Headers(response.headers),
                    body=bytes(body),
                )


def _caused_by_tls(error: BaseException) -> bool:
    current: BaseException | None = error
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        if isinstance(current, ssl.SSLError):
            return True
        seen.add(id(current))
        current = current.__cause__ or current.__context__
    return False


__all__ = [
    "ResolvedPublicHttpTarget",
    "SafePublicHttpClient",
    "SafePublicHttpConnectError",
    "SafePublicHttpDnsError",
    "SafePublicHttpDnsTimeout",
    "SafePublicHttpError",
    "SafePublicHttpRequestError",
    "SafePublicHttpResponse",
    "SafePublicHttpResponseTooLarge",
    "SafePublicHttpTimeout",
    "SafePublicHttpTlsError",
    "UnsafePublicHttpUrlError",
    "parse_public_http_url",
    "resolve_public_http_target",
]
