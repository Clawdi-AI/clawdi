from __future__ import annotations

import json
import socket

import pytest

from app.services import ai_provider_connection
from app.services.safe_public_http import SafePublicHttpTimeout


def _successful_inference_response(api_mode: str) -> ai_provider_connection._ProbeHttpResponse:
    if api_mode == "openai_responses":
        payload = {
            "id": "resp_test",
            "object": "response",
            "status": "completed",
            "model": "test-model",
            "output": [],
        }
    elif api_mode == "openai_chat":
        payload = {"model": "test-model", "choices": [{"message": {"content": "OK"}}]}
    elif api_mode == "anthropic_messages":
        payload = {"type": "message", "model": "test-model", "content": []}
    else:
        payload = {"candidates": [{"content": {"parts": [{"text": "OK"}]}}]}
    return ai_provider_connection._ProbeHttpResponse(
        status_code=200,
        body=json.dumps(payload).encode(),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider_type", "api_mode", "base_url", "expected_path", "header_name"),
    [
        pytest.param(
            "openai",
            "openai_responses",
            "https://api.openai.com/v1",
            "/v1/responses",
            "authorization",
            id="openai-responses",
        ),
        pytest.param(
            "custom_openai_compatible",
            "openai_chat",
            "https://provider.example.test/v1",
            "/v1/chat/completions",
            "authorization",
            id="openai-chat",
        ),
        pytest.param(
            "anthropic",
            "anthropic_messages",
            "https://api.anthropic.com",
            "/v1/messages",
            "x-api-key",
            id="anthropic",
        ),
        pytest.param(
            "gemini",
            "google_generate_content",
            "https://generativelanguage.googleapis.com/v1beta",
            "/v1beta/models/gemini-2.5-pro:generateContent",
            "x-goog-api-key",
            id="gemini",
        ),
    ],
)
async def test_connection_probe_verifies_protocol_model_and_credential_shape(
    monkeypatch: pytest.MonkeyPatch,
    provider_type: str,
    api_mode: str,
    base_url: str,
    expected_path: str,
    header_name: str,
) -> None:
    captured_request: ai_provider_connection._ProbeRequest | None = None

    async def fake_send(
        request: ai_provider_connection._ProbeRequest,
    ) -> ai_provider_connection._ProbeHttpResponse:
        nonlocal captured_request
        captured_request = request
        return _successful_inference_response(api_mode)

    monkeypatch.setattr(ai_provider_connection, "_send_probe_request", fake_send)
    result = await ai_provider_connection.test_ai_provider_connection(
        provider_type=provider_type,
        base_url=base_url,
        api_mode=api_mode,
        model="gemini-2.5-pro" if provider_type == "gemini" else "test-model",
        credential="credential-must-stay-secret",
    )

    assert result.ok is True
    assert result.error is None
    request = captured_request
    assert request is not None
    assert request.url.path == expected_path
    assert header_name in request.headers
    if api_mode == "openai_responses":
        assert request.body["max_output_tokens"] == 16
        assert request.body["store"] is False
    assert "credential-must-stay-secret" not in repr(result)


@pytest.mark.parametrize(
    ("provider_type", "expected_field", "unexpected_field"),
    [
        ("openai", "max_completion_tokens", "max_tokens"),
        ("custom_openai_compatible", "max_tokens", "max_completion_tokens"),
    ],
)
def test_openai_chat_probe_uses_provider_appropriate_token_limit(
    provider_type: str,
    expected_field: str,
    unexpected_field: str,
) -> None:
    request = ai_provider_connection._build_probe_request(
        provider_type=provider_type,
        base_url="https://api.example.test/v1",
        api_mode="openai_chat",
        model="test-model",
        credential="credential-must-stay-secret",
    )

    assert request.body[expected_field] == 1
    assert unexpected_field not in request.body


@pytest.mark.asyncio
async def test_connection_probe_rejects_non_public_dns_before_request(
    monkeypatch: pytest.MonkeyPatch,
):
    called = False

    def private_getaddrinfo(*args, **kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
        ]

    async def fail_if_sent(*args, **kwargs):
        nonlocal called
        called = True
        return _successful_inference_response("openai_chat")

    monkeypatch.setattr(socket, "getaddrinfo", private_getaddrinfo)
    monkeypatch.setattr(
        ai_provider_connection.SafePublicHttpClient,
        "_send_pinned_request",
        fail_if_sent,
    )
    result = await ai_provider_connection.test_ai_provider_connection(
        provider_type="custom_openai_compatible",
        base_url="https://rebind.example.test/v1",
        api_mode="openai_chat",
        model="test-model",
        credential="credential-must-stay-secret",
    )

    assert called is False
    assert result.ok is False
    assert result.error is not None
    assert result.error.category == "ssrf"
    assert result.error.code == "blocked_address"
    assert "credential-must-stay-secret" not in repr(result)


@pytest.mark.asyncio
async def test_connection_probe_rejects_http_and_loopback_endpoints():
    result = await ai_provider_connection.test_ai_provider_connection(
        provider_type="custom_openai_compatible",
        base_url="http://127.0.0.1:1234/v1",
        api_mode="openai_chat",
        model="local-model",
        credential=None,
    )

    assert result.ok is False
    assert result.error is not None
    assert result.error.category == "ssrf"
    assert result.error.code == "blocked_endpoint"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status_code", "category", "code", "retryable"),
    [
        (302, "redirect", "redirect_blocked", False),
        (401, "authentication", "credential_rejected", False),
        (403, "authorization", "credential_forbidden", False),
        (429, "rate_limit", "rate_limited", True),
        (404, "endpoint", "endpoint_not_supported", False),
        (400, "protocol_model", "protocol_or_model_rejected", False),
        (503, "upstream", "provider_unavailable", True),
    ],
)
async def test_connection_probe_returns_stable_classified_errors(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
    category: str,
    code: str,
    retryable: bool,
):
    async def fake_send(*args, **kwargs) -> ai_provider_connection._ProbeHttpResponse:
        return ai_provider_connection._ProbeHttpResponse(status_code=status_code, body=b"")

    monkeypatch.setattr(ai_provider_connection, "_send_probe_request", fake_send)
    result = await ai_provider_connection.test_ai_provider_connection(
        provider_type="openai",
        base_url="https://api.openai.com/v1",
        api_mode="openai_responses",
        model="gpt-test",
        credential="credential-must-stay-secret",
    )

    assert result.ok is False
    assert result.error is not None
    assert result.error.category == category
    assert result.error.code == code
    assert result.error.retryable is retryable
    assert result.error.endpoint_reachable is True
    assert "credential-must-stay-secret" not in repr(result)


@pytest.mark.asyncio
async def test_connection_probe_rejects_success_status_without_protocol_response(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_send(*args, **kwargs) -> ai_provider_connection._ProbeHttpResponse:
        return ai_provider_connection._ProbeHttpResponse(
            status_code=200,
            body=b'{"ok":true}',
        )

    monkeypatch.setattr(ai_provider_connection, "_send_probe_request", fake_send)
    result = await ai_provider_connection.test_ai_provider_connection(
        provider_type="openai",
        base_url="https://api.openai.com/v1",
        api_mode="openai_responses",
        model="gpt-test",
        credential="credential-must-stay-secret",
    )

    assert result.ok is False
    assert result.error is not None
    assert result.error.category == "protocol_model"
    assert result.error.code == "invalid_inference_response"
    assert result.error.endpoint_reachable is True
    assert "credential-must-stay-secret" not in repr(result)


@pytest.mark.parametrize(
    "body",
    [
        b"\xff",
        b"not-json",
        b"[]",
        (b'{"id":"resp_test","object":"response","status":[],"model":"test-model","output":[]}'),
    ],
)
def test_connection_probe_rejects_malformed_provider_json(body: bytes) -> None:
    assert not ai_provider_connection._is_valid_inference_response("openai_responses", body)


@pytest.mark.asyncio
async def test_connection_probe_redacts_network_failures(monkeypatch: pytest.MonkeyPatch):
    async def timeout(*args, **kwargs) -> int:
        raise SafePublicHttpTimeout()

    monkeypatch.setattr(ai_provider_connection, "_send_probe_request", timeout)
    result = await ai_provider_connection.test_ai_provider_connection(
        provider_type="openai",
        base_url="https://api.openai.com/v1",
        api_mode="openai_responses",
        model="gpt-test",
        credential="credential-must-stay-secret",
    )

    assert result.ok is False
    assert result.error is not None
    assert result.error.category == "timeout"
    assert result.error.code == "request_timeout"
    assert "credential-must-stay-secret" not in repr(result)
