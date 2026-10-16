from __future__ import annotations

import socket
from typing import Any
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException, Request

from app.core.config import settings
from app.models.channel import ChannelAccount
from app.routes.channel_routers import shared, telegram
from app.services import channels


@pytest.mark.asyncio
async def test_channel_provider_http_client_is_reused_and_closed(monkeypatch):
    clients: list[Any] = []

    class FakeClient:
        def __init__(self, *, timeout: float, limits):
            self.timeout = timeout
            self.closed = False
            clients.append(self)

        async def aclose(self) -> None:
            self.closed = True

    monkeypatch.setattr(channels.httpx, "AsyncClient", FakeClient)
    try:
        first = channels.get_channel_provider_http_client()
        second = channels.get_channel_provider_http_client()

        assert first is second
        assert len(clients) == 1
        assert clients[0].timeout == 30.0

        await channels.close_channel_provider_http_client()
        assert clients[0].closed is True
        assert channels.get_channel_provider_http_client() is not first
        assert len(clients) == 2
    finally:
        await channels.close_channel_provider_http_client()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation",
    [
        "discord_proxy",
        "telegram_proxy",
        "discord_commands",
        "telegram_commands",
        "telegram_identity",
    ],
)
async def test_operator_provider_urls_do_not_resolve_dns(
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    requests: list[httpx.Request] = []

    def unexpected_dns(*_args: object) -> None:
        pytest.fail("Operator provider URLs must not perform DNS pre-validation")

    def provider_handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/commands"):
            return httpx.Response(200, json=[])
        if request.url.path.endswith("/getMe"):
            return httpx.Response(200, json={"ok": True, "result": {"username": "ExampleBot"}})
        return httpx.Response(200, json={"ok": True, "result": True})

    monkeypatch.setattr(socket, "getaddrinfo", unexpected_dns)
    monkeypatch.setattr(
        settings, "channel_discord_api_base_url", "https://discord-provider.example"
    )
    monkeypatch.setattr(
        settings, "channel_telegram_api_base_url", "https://telegram-provider.example"
    )
    ciphertext, nonce = channels.encrypt_optional_token("provider-token")
    account = ChannelAccount(
        id=uuid4(),
        provider="discord" if operation.startswith("discord") else "telegram",
        encrypted_provider_token=ciphertext,
        provider_token_nonce=nonce,
        config={"application_id": "123456789012345678"},
    )
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(provider_handler)
    ) as provider_client:
        monkeypatch.setattr(channels, "_channel_provider_http_client", provider_client)
        for _ in range(2):
            if operation == "discord_proxy":
                result = await shared.request_discord_provider(
                    account=account, method="GET", path="/users/@me"
                )
                assert result.status_code == 200
            elif operation == "telegram_proxy":
                response = await telegram._telegram_provider_response(
                    provider_token="provider-token",
                    method="getMe",
                    request=Request({"type": "http", "method": "POST", "headers": []}),
                    raw_body=b"{}",
                )
                assert response.status_code == 200
            elif operation == "discord_commands":
                assert (
                    await channels.sync_discord_commands(
                        account=account,
                        commands=[],
                        guild_id=None,
                        reconcile_reserved_commands=True,
                    )
                    == []
                )
            elif operation == "telegram_commands":
                assert await channels.sync_telegram_commands(account=account, commands=[]) == []
            else:
                assert await channels.get_telegram_bot_username("provider-token") == "ExampleBot"
    assert len(requests) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [TimeoutError, socket.gaierror])
async def test_account_provider_url_dns_failure_is_retryable(
    monkeypatch: pytest.MonkeyPatch,
    error: type[OSError],
) -> None:
    def failed_dns(*_args: object) -> None:
        raise error("internal-resolver-detail-must-not-escape")

    monkeypatch.setattr(socket, "getaddrinfo", failed_dns)
    ciphertext, nonce = channels.encrypt_optional_token("provider-token")
    account = ChannelAccount(
        provider="discord",
        encrypted_provider_token=ciphertext,
        provider_token_nonce=nonce,
        config={"api_base_url": "https://discord-provider.example"},
    )

    with pytest.raises(HTTPException) as caught:
        await channels.send_provider_outbound_payload(
            account=account, external_chat_id="123", text="hello"
        )

    assert caught.value.status_code == 503
    assert caught.value.headers == {"Retry-After": "1"}

    assert "internal-resolver-detail-must-not-escape" not in str(caught.value.detail)
