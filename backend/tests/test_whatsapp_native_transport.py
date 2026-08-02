from __future__ import annotations

import asyncio
import base64
import json
import os
import tempfile
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
import pytest

from app.services.whatsapp_native_transport import (
    WhatsAppBaileysSidecarClient,
    WhatsAppBaileysSidecarConfig,
    WhatsAppNativeRelayRequest,
    WhatsAppProviderTransportAdapter,
    WhatsAppSidecarUnavailableError,
)
from app.services.whatsapp_provider_bridge import (
    register_whatsapp_provider_transport,
    unregister_whatsapp_provider_transport,
    whatsapp_provider_transport_status,
)
from app.services.whatsapp_runtime_types import WhatsAppOutboundMessage


class _FakeNativeUpstreamClient:
    def __init__(self, *, connected: bool = True) -> None:
        self.connected = connected
        self.relay_requests: list[WhatsAppNativeRelayRequest] = []
        self.raw_nodes: list[dict[str, Any]] = []
        self.queries: list[tuple[dict[str, Any], int]] = []

    async def relay_message(self, request: WhatsAppNativeRelayRequest) -> str | None:
        self.relay_requests.append(request)
        return request.message_id

    async def send_node(self, node: dict[str, Any]) -> None:
        self.raw_nodes.append(node)

    async def query(self, node: dict[str, Any], timeout_ms: int) -> dict[str, Any] | None:
        self.queries.append((node, timeout_ms))
        return {"tag": "iq", "attrs": {"id": "response", "type": "result"}}


@pytest.mark.asyncio
async def test_whatsapp_provider_transport_adapter_relays_message_attrs():
    client = _FakeNativeUpstreamClient()
    transport = WhatsAppProviderTransportAdapter(client)

    relayed_message_id = await transport.relay_outbound_message(
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
            additional_nodes=({"tag": "meta", "attrs": {"polltype": "creation"}},),
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
            additional_nodes=({"tag": "meta", "attrs": {"polltype": "creation"}},),
        )
    ]
    assert relayed_message_id == "agent-edit-1"


@pytest.mark.asyncio
async def test_whatsapp_provider_transport_adapter_relays_raw_and_iq_nodes():
    client = _FakeNativeUpstreamClient()
    transport = WhatsAppProviderTransportAdapter(client)
    raw = {"tag": "chatstate", "attrs": {"to": "15551114444@s.whatsapp.net"}}
    iq = {"tag": "iq", "attrs": {"id": "q", "type": "get"}}

    await transport.relay_raw_node(raw)
    response = await transport.query_iq(iq, 15_000)

    assert client.raw_nodes == [raw]
    assert client.queries == [(iq, 15_000)]
    assert response == {"tag": "iq", "attrs": {"id": "response", "type": "result"}}


def test_whatsapp_provider_transport_health_reports_disconnected_adapter():
    account_id = UUID("00000000-0000-0000-0000-000000000123")
    transport = WhatsAppProviderTransportAdapter(_FakeNativeUpstreamClient(connected=False))
    register_whatsapp_provider_transport(account_id, transport)
    try:
        status = whatsapp_provider_transport_status(account_id)
    finally:
        unregister_whatsapp_provider_transport(account_id)

    assert status.available is False
    assert status.reason == "provider-transport-disconnected"
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
                "additionalNodes": [],
            }
            return httpx.Response(200, json={"ok": True, "messageId": "provider-native-1"})
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
        if request.url.path == "/v1/provider-events":
            assert dict(request.url.params) == {"limit": "25"}
            return httpx.Response(
                200,
                json={
                    "events": [
                        {
                            "sequence": 7,
                            "eventType": "messages.upsert",
                            "fromMe": False,
                            "messageId": "provider-inbound-1",
                            "remoteJid": "15551112222@s.whatsapp.net",
                            "remoteJidAlt": "15551112222@lid",
                            "participant": None,
                            "participantAlt": None,
                            "pushName": "Alice",
                            "messageTimestamp": 1_722_000_000,
                            "messageProtoBase64": base64.b64encode(b"\x0a\x07inbound").decode(
                                "ascii"
                            ),
                        }
                    ]
                },
            )
        if request.url.path == "/v1/provider-events/ack":
            assert _json_body(request) == {"throughSequence": 7}
            return httpx.Response(200, json={"ok": True})
        raise AssertionError(f"unexpected path {request.url.path}")

    http_client = httpx.AsyncClient(
        base_url="https://baileys-sidecar.internal",
        transport=httpx.MockTransport(handler),
    )
    client = WhatsAppBaileysSidecarClient(
        WhatsAppBaileysSidecarConfig(
            base_url="https://baileys-sidecar.internal",
            api_token="sidecar-secret",
        ),
        http_client=http_client,
    )
    transport = WhatsAppProviderTransportAdapter(client)

    assert await client.refresh_health() is True
    assert client.connected is True

    relayed_message_id = await transport.relay_outbound_message(
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
    events = await client.provider_events(limit=25)
    await client.acknowledge_provider_events(through_sequence=events[0].sequence)

    await http_client.aclose()

    assert [request.url.path for request in requests] == [
        "/v1/health",
        "/v1/relay-message",
        "/v1/raw-node",
        "/v1/query-iq",
        "/v1/provider-events",
        "/v1/provider-events/ack",
    ]
    assert relayed_message_id == "provider-native-1"
    assert events[0].message_id == "provider-inbound-1"
    assert events[0].remote_jid_alt == "15551112222@lid"
    assert events[0].message_proto == b"\x0a\x07inbound"
    assert response == {
        "tag": "iq",
        "attrs": {"id": "response", "type": "result"},
        "content": b"\x01\x02",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response_body", "error"),
    [
        (b"not-json", "response must be valid JSON"),
        (
            b'{"node":{"content":{"$type":"base64-bytes","base64":"not-base64!"}}}',
            "encoded bytes require valid base64",
        ),
        (
            b'{"node":{"content":{"type":"Buffer","data":[256]}}}',
            "encoded Buffer bytes must be integers between 0 and 255",
        ),
    ],
)
async def test_whatsapp_baileys_sidecar_client_rejects_invalid_query_json(
    response_body: bytes,
    error: str,
):
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=response_body)

    async with httpx.AsyncClient(
        base_url="https://baileys-sidecar.internal",
        transport=httpx.MockTransport(handler),
    ) as http_client:
        client = WhatsAppBaileysSidecarClient(
            WhatsAppBaileysSidecarConfig(
                base_url="https://baileys-sidecar.internal",
                api_token="sidecar-secret",
            ),
            http_client=http_client,
        )
        with pytest.raises(ValueError, match=error):
            await client.query(
                {"tag": "iq", "attrs": {"id": "query", "type": "get"}},
                15_000,
            )


@pytest.mark.asyncio
async def test_whatsapp_provider_transport_health_reports_sidecar_mode():
    account_id = UUID("00000000-0000-0000-0000-000000000456")
    client = WhatsAppBaileysSidecarClient(
        WhatsAppBaileysSidecarConfig(
            base_url="https://baileys-sidecar.internal",
            api_token="sidecar-secret",
        )
    )
    client._connected = True
    transport = WhatsAppProviderTransportAdapter(client)
    register_whatsapp_provider_transport(account_id, transport)
    try:
        status = whatsapp_provider_transport_status(account_id)
    finally:
        unregister_whatsapp_provider_transport(account_id)
        await client.aclose()

    assert status.available is True
    assert status.mode == "sidecar"
    assert status.supports_outbound_messages is True
    assert status.supports_raw_relay is True
    assert status.supports_iq_queries is True


@pytest.mark.parametrize(
    "base_url",
    [
        "http://sidecar.internal",
        "ftp://127.0.0.1:8787",
        "https://user:pass@sidecar.internal",
        "https://sidecar.internal/path",
        "https://sidecar.internal?query=yes",
        "https://sidecar.internal#fragment",
        "https://sidecar.internal?",
        "https://sidecar.internal#",
        "https://sidecar.internal:",
        "https://sidecar%2Einternal",
        "https://sidecar.internal\\@127.0.0.1",
    ],
)
def test_whatsapp_sidecar_config_rejects_unsafe_base_url(base_url: str):
    with pytest.raises(ValueError):
        WhatsAppBaileysSidecarConfig(base_url=base_url, api_token="sidecar-secret")


@pytest.mark.parametrize(
    "base_url", ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]
)
def test_whatsapp_sidecar_config_allows_exact_loopback_http(base_url: str):
    config = WhatsAppBaileysSidecarConfig(base_url=base_url, api_token="sidecar-secret")

    assert config.base_url == base_url


def test_whatsapp_sidecar_config_requires_and_redacts_api_token():
    with pytest.raises(TypeError):
        WhatsAppBaileysSidecarConfig(**{"base_url": "https://sidecar.internal"})
    with pytest.raises(ValueError, match="non-empty printable ASCII bearer"):
        WhatsAppBaileysSidecarConfig(base_url="https://sidecar.internal", api_token="  ")

    config = WhatsAppBaileysSidecarConfig(
        base_url="https://sidecar.internal",
        api_token="must-not-appear",
    )
    assert "must-not-appear" not in repr(config)


def test_whatsapp_sidecar_config_selects_strict_unix_socket_without_weakening_https():
    socket_path = "/run/clawdi-whatsapp/11111111-1111-4111-8111-111111111111/sidecar.sock"
    config = WhatsAppBaileysSidecarConfig(
        account_id=UUID("11111111-1111-4111-8111-111111111111"),
        unix_socket_path=socket_path,
        api_token="must-not-appear",
    )

    assert config.base_url is None
    assert config.unix_socket_path == socket_path
    assert config.endpoint_identity == f"unix:{socket_path}"
    assert "must-not-appear" not in repr(config)
    with pytest.raises(ValueError, match="exactly one transport endpoint"):
        WhatsAppBaileysSidecarConfig(
            base_url="https://sidecar.internal",
            unix_socket_path=socket_path,
            api_token="secret",
        )
    with pytest.raises(ValueError, match="exactly one transport endpoint"):
        WhatsAppBaileysSidecarConfig(api_token="secret")
    with pytest.raises(ValueError, match="sidecar.sock path"):
        WhatsAppBaileysSidecarConfig(
            account_id=UUID("11111111-1111-4111-8111-111111111111"),
            unix_socket_path="/run/clawdi-whatsapp/provider.sock",
            api_token="secret",
        )
    with pytest.raises(ValueError, match="requires account_id"):
        WhatsAppBaileysSidecarConfig(unix_socket_path=socket_path, api_token="secret")
    with pytest.raises(ValueError, match="requires HTTPS"):
        WhatsAppBaileysSidecarConfig(base_url="http://sidecar.internal", api_token="secret")


@pytest.mark.asyncio
async def test_whatsapp_sidecar_client_uses_authenticated_strict_unix_socket() -> None:
    account_id = UUID("11111111-1111-4111-8111-111111111111")
    token = "uds-test-token"
    temporary_root = tempfile.TemporaryDirectory(prefix="w", dir="/tmp")
    socket_directory = Path(temporary_root.name) / str(account_id)
    socket_directory.mkdir(mode=0o770)
    os.chmod(socket_directory, 0o770)
    socket_path = socket_directory / "sidecar.sock"

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        request = await reader.readuntil(b"\r\n\r\n")
        assert b"GET /v1/health HTTP/1.1" in request
        assert f"authorization: bearer {token}\r\n".encode() in request.lower()
        body = json.dumps(
            {
                "accountId": str(account_id),
                "status": "connected",
                "connected": True,
                "registered": True,
                "advertisedRelease": {
                    "packageName": "@whiskeysockets/baileys",
                    "packageVersion": "7.0.0-rc14",
                    "sourceCommit": "7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a",
                    "version": [2, 3000, 1043857760],
                },
            }
        ).encode()
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            + f"Content-Length: {len(body)}\r\n".encode()
            + b"Content-Type: application/json\r\nConnection: close\r\n\r\n"
            + body
        )
        await writer.drain()
        writer.close()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    os.chmod(socket_path, 0o660)
    client = WhatsAppBaileysSidecarClient(
        WhatsAppBaileysSidecarConfig(
            account_id=account_id,
            unix_socket_path=str(socket_path),
            api_token=token,
        )
    )
    try:
        health = await client.health()
        assert health.connected is True
        assert health.registered is True
        os.chmod(socket_path, 0o666)
        with pytest.raises(WhatsAppSidecarUnavailableError, match="sidecar unavailable"):
            await client.health()
        assert client.connected is False
    finally:
        await client.aclose()
        server.close()
        await server.wait_closed()
        temporary_root.cleanup()


def _json_body(request: httpx.Request) -> dict[str, Any]:
    import json

    body = json.loads(request.content.decode("utf-8"))
    assert isinstance(body, dict)
    return body
