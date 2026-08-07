"""Safe server-side AI Provider credential and inference verification."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote

import httpx
from pydantic import JsonValue, TypeAdapter, ValidationError

from app.schemas.ai_provider import ConnectionErrorCategory
from app.services.safe_public_http import (
    SafePublicHttpClient,
    SafePublicHttpConnectError,
    SafePublicHttpDnsError,
    SafePublicHttpDnsTimeout,
    SafePublicHttpRequestError,
    SafePublicHttpResponseTooLarge,
    SafePublicHttpTimeout,
    SafePublicHttpTlsError,
    UnsafePublicHttpUrlError,
)

_PROBE_TIMEOUT = httpx.Timeout(connect=4.0, read=8.0, write=4.0, pool=2.0)
_TOTAL_PROBE_TIMEOUT_SECONDS = 10.0
_MAX_RESPONSE_BYTES = 64 * 1024
_PROBE_RESPONSE_ADAPTER: TypeAdapter[dict[str, JsonValue]] = TypeAdapter(dict[str, JsonValue])


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
    body: dict[str, JsonValue]


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

    try:
        response = await _send_probe_request(request)
    except SafePublicHttpDnsTimeout:
        return _failure(
            "dns",
            "dns_timeout",
            "Provider hostname lookup timed out.",
            retryable=True,
        )
    except SafePublicHttpDnsError:
        return _failure(
            "dns",
            "dns_failed",
            "Provider hostname could not be resolved.",
            retryable=True,
        )
    except UnsafePublicHttpUrlError as exc:
        if exc.reason == "invalid":
            return _failure(
                "validation",
                "invalid_endpoint",
                "Provider endpoint is invalid.",
                retryable=False,
            )
        return _failure(
            "ssrf",
            "blocked_address",
            "Provider endpoint resolves to a non-public address.",
            retryable=False,
        )
    except SafePublicHttpTimeout:
        return _failure(
            "timeout",
            "request_timeout",
            "Provider connection timed out.",
            retryable=True,
        )
    except SafePublicHttpTlsError:
        return _failure(
            "tls",
            "tls_failed",
            "Provider TLS verification failed.",
            retryable=False,
        )
    except SafePublicHttpConnectError:
        return _failure(
            "network",
            "connection_failed",
            "Provider endpoint could not be reached.",
            retryable=True,
        )
    except (_InvalidProbeResponse, SafePublicHttpResponseTooLarge):
        return _failure(
            "protocol_model",
            "invalid_inference_response",
            "Provider returned an invalid inference response.",
            retryable=False,
            endpoint_reachable=True,
        )
    except SafePublicHttpRequestError:
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

    body: dict[str, JsonValue]
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
            "stream": False,
        }
        token_limit_field = "max_completion_tokens" if provider_type == "openai" else "max_tokens"
        body[token_limit_field] = 1
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


async def _send_probe_request(request: _ProbeRequest) -> _ProbeHttpResponse:
    client = SafePublicHttpClient(
        timeout=_PROBE_TIMEOUT,
        total_timeout_seconds=_TOTAL_PROBE_TIMEOUT_SECONDS,
        max_response_bytes=_MAX_RESPONSE_BYTES,
    )
    response = await client.post(
        request.url,
        headers=request.headers,
        json=request.body,
    )
    if response.is_success:
        content_encoding = response.headers.get("content-encoding", "identity").lower()
        if content_encoding not in {"", "identity"}:
            raise _InvalidProbeResponse("compressed probe responses are not accepted")
    return _ProbeHttpResponse(
        status_code=response.status_code,
        body=response.body if response.is_success else b"",
    )


def _is_valid_inference_response(api_mode: str, body: bytes) -> bool:
    try:
        payload = _PROBE_RESPONSE_ADAPTER.validate_json(body, strict=True)
    except ValidationError:
        return False
    if api_mode == "openai_responses":
        return (
            payload.get("object") == "response"
            and _is_non_empty_string(payload.get("id"))
            and _is_non_empty_string(payload.get("model"))
            and payload.get("status") in ("completed", "incomplete")
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


def _is_non_empty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


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
