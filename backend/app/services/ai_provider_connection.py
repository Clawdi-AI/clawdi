"""Safe server-side AI Provider credential and inference verification."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
import ssl
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from app.schemas.ai_provider import ConnectionErrorCategory

_DNS_TIMEOUT_SECONDS = 3.0
_PROBE_TIMEOUT = httpx.Timeout(connect=4.0, read=8.0, write=4.0, pool=2.0)
_TOTAL_PROBE_TIMEOUT_SECONDS = 10.0
_MAX_PROBE_ADDRESSES = 4
_MAX_RESPONSE_BYTES = 64 * 1024


@dataclass(frozen=True, slots=True)
class ConnectionProbeError:
    category: ConnectionErrorCategory
    code: str
    message: str
    retryable: bool
    endpoint_reachable: bool


@dataclass(frozen=True, slots=True)
class ConnectionProbeResult:
    ok: bool
    error: ConnectionProbeError | None = None


@dataclass(frozen=True, slots=True)
class _ProbeRequest:
    url: httpx.URL
    headers: dict[str, str]
    body: dict[str, Any]


@dataclass(frozen=True, slots=True)
class _ProbeHttpResponse:
    status_code: int
    body: bytes


class _BlockedEndpoint(ValueError):
    pass


class _InvalidProbeResponse(ValueError):
    pass


async def test_ai_provider_connection(
    *,
    provider_type: str,
    base_url: str,
    api_mode: str,
    model: str,
    credential: str | None,
) -> ConnectionProbeResult:
    """Run one bounded inference request without following redirects.

    DNS is resolved and validated before the request. The request then connects
    to that validated IP while retaining the original Host header and TLS SNI,
    preventing a second DNS lookup from rebinding the target to an internal IP.
    """

    try:
        request = _build_probe_request(
            provider_type=provider_type,
            base_url=base_url,
            api_mode=api_mode,
            model=model,
            credential=credential,
        )
    except _BlockedEndpoint:
        return _failure(
            "ssrf",
            "blocked_endpoint",
            "Connection testing requires a public HTTPS provider endpoint.",
            retryable=False,
        )
    except (ValueError, httpx.InvalidURL):
        return _failure(
            "validation",
            "invalid_probe_contract",
            "Provider endpoint, protocol, or model is invalid.",
            retryable=False,
        )

    hostname = request.url.host
    if not hostname:
        return _failure(
            "validation",
            "invalid_endpoint",
            "Provider endpoint is invalid.",
            retryable=False,
        )
    try:
        addresses = await _resolve_public_addresses(hostname, request.url.port or 443)
    except TimeoutError:
        return _failure(
            "dns",
            "dns_timeout",
            "Provider hostname lookup timed out.",
            retryable=True,
        )
    except socket.gaierror:
        return _failure(
            "dns",
            "dns_failed",
            "Provider hostname could not be resolved.",
            retryable=True,
        )
    except ValueError:
        return _failure(
            "ssrf",
            "blocked_address",
            "Provider endpoint resolves to a non-public address.",
            retryable=False,
        )

    try:
        response = await asyncio.wait_for(
            _send_to_public_addresses(request, addresses),
            timeout=_TOTAL_PROBE_TIMEOUT_SECONDS,
        )
    except (TimeoutError, httpx.TimeoutException):
        return _failure(
            "timeout",
            "request_timeout",
            "Provider connection timed out.",
            retryable=True,
        )
    except httpx.ConnectError as error:
        if _caused_by_tls(error):
            return _failure(
                "tls",
                "tls_failed",
                "Provider TLS verification failed.",
                retryable=False,
            )
        return _failure(
            "network",
            "connection_failed",
            "Provider endpoint could not be reached.",
            retryable=True,
        )
    except _InvalidProbeResponse:
        return _failure(
            "protocol_model",
            "invalid_inference_response",
            "Provider returned an invalid inference response.",
            retryable=False,
            endpoint_reachable=True,
        )
    except httpx.HTTPError:
        return _failure(
            "network",
            "request_failed",
            "Provider request failed.",
            retryable=True,
        )

    status_code = response.status_code
    if 200 <= status_code < 300:
        if _is_valid_inference_response(api_mode, response.body):
            return ConnectionProbeResult(ok=True)
        return _failure(
            "protocol_model",
            "invalid_inference_response",
            "Provider returned an invalid inference response.",
            retryable=False,
            endpoint_reachable=True,
        )
    if 300 <= status_code < 400:
        return _failure(
            "redirect",
            "redirect_blocked",
            "Provider endpoint returned a redirect, which is not followed for security.",
            retryable=False,
            endpoint_reachable=True,
        )
    if status_code == 401:
        return _failure(
            "authentication",
            "credential_rejected",
            "Provider rejected the credential.",
            retryable=False,
            endpoint_reachable=True,
        )
    if status_code == 403:
        return _failure(
            "authorization",
            "credential_forbidden",
            "Provider credential is not authorized for this request.",
            retryable=False,
            endpoint_reachable=True,
        )
    if status_code == 429:
        return _failure(
            "rate_limit",
            "rate_limited",
            "Provider rate limited the verification request.",
            retryable=True,
            endpoint_reachable=True,
        )
    if status_code in {404, 405}:
        return _failure(
            "endpoint",
            "endpoint_not_supported",
            "Provider endpoint does not support the configured protocol path.",
            retryable=False,
            endpoint_reachable=True,
        )
    if status_code in {400, 409, 415, 422}:
        return _failure(
            "protocol_model",
            "protocol_or_model_rejected",
            "Provider rejected the configured protocol or model.",
            retryable=False,
            endpoint_reachable=True,
        )
    if status_code >= 500:
        return _failure(
            "upstream",
            "provider_unavailable",
            "Provider is temporarily unavailable.",
            retryable=True,
            endpoint_reachable=True,
        )
    return _failure(
        "protocol_model",
        "verification_rejected",
        "Provider rejected the verification request.",
        retryable=False,
        endpoint_reachable=True,
    )


def _build_probe_request(
    *,
    provider_type: str,
    base_url: str,
    api_mode: str,
    model: str,
    credential: str | None,
) -> _ProbeRequest:
    base = httpx.URL(base_url)
    if base.scheme != "https":
        raise _BlockedEndpoint("HTTPS is required")
    if not base.host or base.username or base.password or base.query or base.fragment:
        raise ValueError("invalid endpoint")
    clean_model = model.strip()
    if not clean_model:
        raise ValueError("missing model")
    headers = {
        "accept": "application/json",
        "accept-encoding": "identity",
        "content-type": "application/json",
    }
    if credential is not None:
        if not credential.strip():
            raise ValueError("blank credential")
        if provider_type == "anthropic":
            headers["x-api-key"] = credential
            headers["anthropic-version"] = "2023-06-01"
        elif provider_type == "gemini":
            headers["x-goog-api-key"] = credential
        else:
            headers["authorization"] = f"Bearer {credential}"

    if api_mode == "anthropic_messages":
        path = _append_api_path(base.path, "v1/messages", avoid_duplicate="v1")
        body = {
            "model": clean_model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "Reply with OK."}],
        }
    elif api_mode == "google_generate_content":
        model_path = clean_model if clean_model.startswith("models/") else f"models/{clean_model}"
        path = _append_path(base.path, f"{quote(model_path, safe='/')}:generateContent")
        body = {"contents": [{"parts": [{"text": "Reply with OK."}]}]}
    elif api_mode == "openai_chat":
        path = _append_path(base.path, "chat/completions")
        body = {
            "model": clean_model,
            "messages": [{"role": "user", "content": "Reply with OK."}],
            "max_tokens": 1,
            "stream": False,
        }
    elif api_mode == "openai_responses":
        path = _append_path(base.path, "responses")
        body = {
            "model": clean_model,
            "input": "Reply with OK.",
            "max_output_tokens": 16,
            "store": False,
            "stream": False,
        }
    else:
        raise ValueError("unsupported protocol")
    return _ProbeRequest(url=base.copy_with(path=path), headers=headers, body=body)


def _append_api_path(path: str, suffix: str, *, avoid_duplicate: str) -> str:
    normalized = path.rstrip("/")
    if normalized.endswith(f"/{avoid_duplicate}"):
        suffix = suffix.removeprefix(f"{avoid_duplicate}/")
    return _append_path(normalized, suffix)


def _append_path(path: str, suffix: str) -> str:
    prefix = path.rstrip("/")
    return f"{prefix}/{suffix.lstrip('/')}" or "/"


async def _resolve_public_addresses(hostname: str, port: int) -> tuple[str, ...]:
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        infos = await asyncio.wait_for(
            asyncio.to_thread(
                socket.getaddrinfo,
                hostname,
                port,
                socket.AF_UNSPEC,
                socket.SOCK_STREAM,
            ),
            timeout=_DNS_TIMEOUT_SECONDS,
        )
        addresses = tuple(dict.fromkeys(str(info[4][0]) for info in infos))
    else:
        addresses = (str(literal),)
    if not addresses:
        raise socket.gaierror("no addresses")
    if any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise ValueError("non-public address")
    return addresses


async def _send_to_public_addresses(
    request: _ProbeRequest,
    addresses: tuple[str, ...],
) -> _ProbeHttpResponse:
    ordered = sorted(addresses, key=lambda address: ipaddress.ip_address(address).version)
    last_connect_error: httpx.ConnectError | httpx.ConnectTimeout | None = None
    for address in ordered[:_MAX_PROBE_ADDRESSES]:
        try:
            return await _send_pinned_request(request, address)
        except httpx.ConnectTimeout as error:
            last_connect_error = error
        except httpx.ConnectError as error:
            if _caused_by_tls(error):
                raise
            last_connect_error = error
    if last_connect_error is not None:
        raise last_connect_error
    raise httpx.ConnectError("Provider endpoint has no usable public address")


async def _send_pinned_request(
    request: _ProbeRequest,
    address: str,
) -> _ProbeHttpResponse:
    original_host = request.url.host
    if not original_host:
        raise ValueError("missing host")
    default_port = 443 if request.url.scheme == "https" else 80
    host_header = original_host
    if ":" in host_header and not host_header.startswith("["):
        host_header = f"[{host_header}]"
    if request.url.port is not None and request.url.port != default_port:
        host_header = f"{host_header}:{request.url.port}"
    headers = {**request.headers, "host": host_header}
    pinned_url = request.url.copy_with(host=address)
    transport = httpx.AsyncHTTPTransport(verify=True, trust_env=False, retries=0)
    async with httpx.AsyncClient(
        transport=transport,
        timeout=_PROBE_TIMEOUT,
        follow_redirects=False,
        trust_env=False,
    ) as client:
        async with client.stream(
            "POST",
            pinned_url,
            headers=headers,
            json=request.body,
            extensions={"sni_hostname": original_host},
        ) as response:
            if not 200 <= response.status_code < 300:
                return _ProbeHttpResponse(status_code=response.status_code, body=b"")
            content_encoding = response.headers.get("content-encoding", "identity").lower()
            if content_encoding not in {"", "identity"}:
                raise _InvalidProbeResponse("compressed probe responses are not accepted")
            body = bytearray()
            async for chunk in response.aiter_raw():
                if len(body) + len(chunk) > _MAX_RESPONSE_BYTES:
                    raise _InvalidProbeResponse("probe response exceeds size limit")
                body.extend(chunk)
            return _ProbeHttpResponse(status_code=response.status_code, body=bytes(body))


def _is_valid_inference_response(api_mode: str, body: bytes) -> bool:
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    if not isinstance(payload, dict):
        return False
    if api_mode == "openai_responses":
        return (
            payload.get("object") == "response"
            and _is_non_empty_string(payload.get("id"))
            and _is_non_empty_string(payload.get("model"))
            and payload.get("status") in {"completed", "incomplete"}
            and isinstance(payload.get("output"), list)
        )
    if api_mode == "openai_chat":
        choices = payload.get("choices")
        return (
            _is_non_empty_string(payload.get("model"))
            and isinstance(choices, list)
            and len(choices) > 0
        )
    if api_mode == "anthropic_messages":
        return (
            payload.get("type") == "message"
            and _is_non_empty_string(payload.get("model"))
            and isinstance(payload.get("content"), list)
        )
    if api_mode == "google_generate_content":
        candidates = payload.get("candidates")
        return isinstance(candidates, list) and len(candidates) > 0
    return False


def _is_non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _caused_by_tls(error: BaseException) -> bool:
    current: BaseException | None = error
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        if isinstance(current, ssl.SSLError):
            return True
        seen.add(id(current))
        current = current.__cause__ or current.__context__
    return False


def _failure(
    category: ConnectionErrorCategory,
    code: str,
    message: str,
    *,
    retryable: bool,
    endpoint_reachable: bool = False,
) -> ConnectionProbeResult:
    return ConnectionProbeResult(
        ok=False,
        error=ConnectionProbeError(
            category=category,
            code=code,
            message=message,
            retryable=retryable,
            endpoint_reachable=endpoint_reachable,
        ),
    )


__all__ = ["ConnectionProbeResult", "test_ai_provider_connection"]
