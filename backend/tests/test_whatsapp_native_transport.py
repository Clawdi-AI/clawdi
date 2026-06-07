from __future__ import annotations

import base64
from typing import Any
from uuid import UUID

import httpx
import pytest

from app.services.whatsapp_native_transport import (
    WhatsAppBaileysSidecarClient,
    WhatsAppBaileysSidecarConfig,
    WhatsAppNativeRelayRequest,
    WhatsAppNativeTransportAdapter,
)
from app.services.whatsapp_runtime_types import WhatsAppOutboundMessage
from app.services.whatsapp_shared_runtime import (
    register_whatsapp_shared_bot_transport,
    unregister_whatsapp_shared_bot_transport,
    whatsapp_shared_bot_transport_status,
)


class _FakeNativeUpstreamClient:
    def __init__(self, *, connected: bool = True) -> None:
        self.connected = connected
        self.relay_requests: list[WhatsAppNativeRelayRequest] = []
        self.raw_nodes: list[dict[str, Any]] = []
        self.queries: list[tuple[dict[str, Any], int]] = []

    async def relay_message(self, request: WhatsAppNativeRelayRequest) -> None:
        self.relay_requests.append(request)

    async def send_node(self, node: dict[str, Any]) -> None:
        self.raw_nodes.append(node)

    async def query(self, node: dict[str, Any], timeout_ms: int) -> dict[str, Any] | None:
        self.queries.append((node, timeout_ms))
        return {"tag": "iq", "attrs": {"id": "response", "type": "result"}}


@pytest.mark.asyncio
async def test_whatsapp_native_transport_adapter_relays_message_attrs():
    client = _FakeNativeUpstreamClient()
    transport = WhatsAppNativeTransportAdapter(client)

    await transport.relay_outbound_message(
        WhatsAppOutboundMessage(
            to_jid="15551114444@s.whatsapp.net",
            message_id="agent-edit-1",
            message_proto=b"\x0a\x04edit",
            enc_type="msg",
            attrs={
                "id": "agent-edit-1",
                "to": "15551114444@s.whatsapp.net",
                "from": "agent@s.whatsapp.net",
                "edit": "8",
                "addressing_mode": "lid",
                "category": "peer",
            },
            conversation=None,
        )
    )

    assert client.relay_requests == [
        WhatsAppNativeRelayRequest(
            jid="15551114444@s.whatsapp.net",
            message_id="agent-edit-1",
            message_proto=b"\x0a\x04edit",
            additional_attributes={
                "edit": "8",
                "addressing_mode": "lid",
                "category": "peer",
            },
        )
    ]


@pytest.mark.asyncio
async def test_whatsapp_native_transport_adapter_relays_raw_and_iq_nodes():
    client = _FakeNativeUpstreamClient()
    transport = WhatsAppNativeTransportAdapter(client)
    raw = {"tag": "chatstate", "attrs": {"to": "15551114444@s.whatsapp.net"}}
    iq = {"tag": "iq", "attrs": {"id": "q", "type": "get"}}

    await transport.relay_raw_node(raw)
    response = await transport.query_iq(iq, 15_000)

    assert client.raw_nodes == [raw]
    assert client.queries == [(iq, 15_000)]
    assert response == {"tag": "iq", "attrs": {"id": "response", "type": "result"}}


def test_whatsapp_native_transport_health_reports_disconnected_adapter():
    account_id = UUID("00000000-0000-0000-0000-000000000123")
    transport = WhatsAppNativeTransportAdapter(_FakeNativeUpstreamClient(connected=False))
    register_whatsapp_shared_bot_transport(account_id, transport)
    try:
        status = whatsapp_shared_bot_transport_status(account_id)
    finally:
        unregister_whatsapp_shared_bot_transport(account_id)

    assert status.available is False
    assert status.reason == "shared-bot-transport-disconnected"
    assert status.supports_outbound_messages is True
    assert status.supports_raw_relay is True
    assert status.supports_iq_queries is True


@pytest.mark.asyncio
async def test_whatsapp_baileys_sidecar_client_uses_internal_contract():
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["authorization"] == "Bearer sidecar-secret"
        if request.url.path == "/v1/health":
            return httpx.Response(200, json={"status": "connected"})
        if request.url.path == "/v1/relay-message":
            body = _json_body(request)
            assert body == {
                "jid": "15551114444@s.whatsapp.net",
                "messageId": "agent-native-1",
                "messageProtoBase64": base64.b64encode(b"\x0a\x06native").decode("ascii"),
                "additionalAttributes": {"edit": "8"},
            }
            return httpx.Response(200, json={"ok": True})
        if request.url.path == "/v1/raw-node":
            body = _json_body(request)
            assert body["node"]["content"][0]["content"] == {
                "$type": "base64-bytes",
                "base64": base64.b64encode(b"payload").decode("ascii"),
            }
            return httpx.Response(200, json={"ok": True})
        if request.url.path == "/v1/query-iq":
            body = _json_body(request)
            assert body["timeoutMs"] == 15_000
            return httpx.Response(
                200,
                json={
                    "node": {
                        "tag": "iq",
                        "attrs": {"id": "response", "type": "result"},
                        "content": {"$type": "base64-bytes", "base64": "AQI="},
                    }
                },
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    http_client = httpx.AsyncClient(
        base_url="http://baileys-sidecar.internal",
        transport=httpx.MockTransport(handler),
    )
    client = WhatsAppBaileysSidecarClient(
        WhatsAppBaileysSidecarConfig(
            base_url="http://baileys-sidecar.internal",
            api_token="sidecar-secret",
        ),
        http_client=http_client,
    )
    transport = WhatsAppNativeTransportAdapter(client)

    assert await client.refresh_health() is True
    assert client.connected is True

    await transport.relay_outbound_message(
        WhatsAppOutboundMessage(
            to_jid="15551114444@s.whatsapp.net",
            message_id="agent-native-1",
            message_proto=b"\x0a\x06native",
            enc_type="msg",
            attrs={
                "id": "agent-native-1",
                "to": "15551114444@s.whatsapp.net",
                "edit": "8",
            },
            conversation=None,
        )
    )
    raw = {
        "tag": "message",
        "attrs": {"to": "15551114444@s.whatsapp.net"},
        "content": [{"tag": "enc", "attrs": {}, "content": b"payload"}],
    }
    await transport.relay_raw_node(raw)
    response = await transport.query_iq(
        {"tag": "iq", "attrs": {"id": "query", "type": "get"}},
        15_000,
    )

    await http_client.aclose()

    assert [request.url.path for request in requests] == [
        "/v1/health",
        "/v1/relay-message",
        "/v1/raw-node",
        "/v1/query-iq",
    ]
    assert response == {
        "tag": "iq",
        "attrs": {"id": "response", "type": "result"},
        "content": b"\x01\x02",
    }


@pytest.mark.asyncio
async def test_whatsapp_native_transport_health_reports_sidecar_mode():
    account_id = UUID("00000000-0000-0000-0000-000000000456")
    client = WhatsAppBaileysSidecarClient(
        WhatsAppBaileysSidecarConfig(base_url="http://baileys-sidecar.internal")
    )
    client._connected = True
    transport = WhatsAppNativeTransportAdapter(client)
    register_whatsapp_shared_bot_transport(account_id, transport)
    try:
        status = whatsapp_shared_bot_transport_status(account_id)
    finally:
        unregister_whatsapp_shared_bot_transport(account_id)
        await client.aclose()

    assert status.available is True
    assert status.mode == "sidecar"
    assert status.supports_outbound_messages is True
    assert status.supports_raw_relay is True
    assert status.supports_iq_queries is True


def _json_body(request: httpx.Request) -> dict[str, Any]:
    import json

    body = json.loads(request.content.decode("utf-8"))
    assert isinstance(body, dict)
    return body
