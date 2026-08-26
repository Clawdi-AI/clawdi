from __future__ import annotations

from typing import Any

import pytest

from app.services import channels


@pytest.mark.asyncio
async def test_channel_provider_http_client_is_reused_and_closed(monkeypatch):
    clients: list[Any] = []

    class FakeClient:
        def __init__(self, *, timeout: float):
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
