import base64
import json

import httpx
import pytest

from app.services.ai_provider_oauth_attempt import _codex_auth_profile_payload
from app.services.codex_oauth import (
    CODEX_DEVICE_RESPONSE_LIMIT_BYTES,
    CODEX_DEVICE_TOKEN_URL,
    CODEX_DEVICE_USER_CODE_URL,
    CODEX_OAUTH_TOKEN_URL,
    CodexOAuthUpstreamError,
    exchange_device_code,
    poll_device_authorization,
    start_device_authorization,
)


def _jwt(account_id: str) -> str:
    claims = {"https://api.openai.com/auth": {"chatgpt_account_id": account_id}}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"header.{payload}.signature"


@pytest.mark.asyncio
async def test_device_authorization_preserves_retry_after() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == CODEX_DEVICE_USER_CODE_URL
        return httpx.Response(429, headers={"Retry-After": "12"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(CodexOAuthUpstreamError) as raised:
            await start_device_authorization(client, "client-id")

    assert raised.value.retry_after == 12
    assert "Too many" in str(raised.value)


@pytest.mark.asyncio
async def test_device_poll_treats_openai_pending_response_as_pending() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == CODEX_DEVICE_TOKEN_URL
        return httpx.Response(403, json={"error": "authorization_pending"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await poll_device_authorization(
            client,
            device_auth_id="device-id",
            user_code="ABCD-EFGH",
        )

    assert result.pending is True


@pytest.mark.asyncio
async def test_device_poll_rejects_oversized_success_response() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * (CODEX_DEVICE_RESPONSE_LIMIT_BYTES + 1))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(CodexOAuthUpstreamError, match="oversized"):
            await poll_device_authorization(
                client,
                device_auth_id="device-id",
                user_code="ABCD-EFGH",
            )


@pytest.mark.asyncio
async def test_device_token_exchange_preserves_rate_limit() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == CODEX_OAUTH_TOKEN_URL
        return httpx.Response(429, headers={"Retry-After": "9"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(CodexOAuthUpstreamError) as raised:
            await exchange_device_code(
                client,
                client_id="client-id",
                authorization_code="authorization-code",
                code_verifier="verifier",
            )

    assert raised.value.retry_after == 9
    assert raised.value.pending_retry is False


@pytest.mark.asyncio
async def test_codex_device_tokens_do_not_require_id_token() -> None:
    access_token = _jwt("account-from-access-token")
    response = httpx.Response(
        200,
        json={
            "access_token": access_token,
            "refresh_token": "refresh-token",
        },
    )

    async with httpx.AsyncClient() as client:
        envelope_text = await _codex_auth_profile_payload(client, {}, response, "default")

    envelope = json.loads(envelope_text)
    auth = json.loads(envelope["files"][0]["content"])
    assert auth["tokens"] == {
        "access_token": access_token,
        "refresh_token": "refresh-token",
        "account_id": "account-from-access-token",
    }
    assert "OPENAI_API_KEY" not in auth
