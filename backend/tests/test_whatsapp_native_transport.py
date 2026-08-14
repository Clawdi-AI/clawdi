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
    WhatsAppBaileysSidecarService,
    WhatsAppNativeRelayRequest,
    WhatsAppProviderTransportAdapter,
    WhatsAppSidecarUnavailableError,
    _sidecar_account_lid,
    whatsapp_phone_number_from_pn_jid,
)
from app.services.whatsapp_provider_bridge import (
    register_whatsapp_provider_transport,
    unregister_whatsapp_provider_transport,
    whatsapp_provider_transport_status,
)
from app.services.whatsapp_runtime_types import WhatsAppOutboundMessage

TEST_ACCOUNT_ID = UUID("11111111-1111-4111-8111-111111111111")
SESSION_PREFIX = f"/v1/sessions/{TEST_ACCOUNT_ID}"
SECOND_TEST_ACCOUNT_ID = UUID("22222222-2222-4222-8222-222222222222")


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


@pytest.mark.asyncio
async def test_sidecar_service_reuses_one_http_pool_for_concurrent_session_views():
    seen_paths: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        session_id = request.url.path.split("/")[3]
        await asyncio.sleep(0)
        return httpx.Response(
            200,
            json={
                "status": "stopped",
                "connected": False,
                "registered": False,
                "sessionId": session_id,
                "advertisedRelease": {
                    "packageName": "@whiskeysockets/baileys",
                    "packageVersion": "7.0.0-rc14",
                    "sourceCommit": "7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a",
                    "version": [2, 3000, 1043857760],
                },
            },
        )

    config = WhatsAppBaileysSidecarConfig(
        base_url="http://127.0.0.1:43191",
        api_token="sidecar-secret",
    )
    async with httpx.AsyncClient(
        base_url=config.base_url,
        transport=httpx.MockTransport(handler),
    ) as http_client:
        service = WhatsAppBaileysSidecarService(config, http_client=http_client)
        first = service.session_client(TEST_ACCOUNT_ID)
        second = service.session_client(SECOND_TEST_ACCOUNT_ID)
        first_health, second_health = await asyncio.gather(first.health(), second.health())
        await first.aclose()
        await second.aclose()
        await service.aclose()

        assert first_health.registered is False
        assert second_health.registered is False
        assert http_client.is_closed is False

    assert set(seen_paths) == {
        f"/v1/sessions/{TEST_ACCOUNT_ID}/health",
        f"/v1/sessions/{SECOND_TEST_ACCOUNT_ID}/health",
    }


@pytest.mark.asyncio
async def test_whatsapp_baileys_sidecar_client_uses_internal_contract():
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["authorization"] == "Bearer sidecar-secret"
        if request.url.path == f"{SESSION_PREFIX}/health":
            return httpx.Response(
                200,
                json={
                    "sessionId": str(TEST_ACCOUNT_ID),
                    "status": "connected",
                    "connected": True,
                    "registered": True,
                    "advertisedRelease": {
                        "packageName": "@whiskeysockets/baileys",
                        "packageVersion": "7.0.0-rc14",
                        "sourceCommit": "7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a",
                        "version": [2, 3000, 1043857760],
                    },
                    "user": {
                        "id": "15551234567:17@s.whatsapp.net",
                        "lid": "900000000000001:17@lid",
                        "name": "Clawdi Public WhatsApp",
                    },
                },
            )
        if request.url.path == f"{SESSION_PREFIX}/relay-message":
            body = _json_body(request)
            assert body == {
                "jid": "15551114444@s.whatsapp.net",
                "messageId": "agent-native-1",
                "messageProtoBase64": base64.b64encode(b"\x0a\x06native").decode("ascii"),
                "additionalAttributes": {"edit": "8"},
                "additionalNodes": [],
            }
            return httpx.Response(200, json={"ok": True, "messageId": "provider-native-1"})
        if request.url.path == f"{SESSION_PREFIX}/raw-node":
            body = _json_body(request)
            assert body["node"]["content"][0]["content"] == {
                "$type": "base64-bytes",
                "base64": base64.b64encode(b"payload").decode("ascii"),
            }
            return httpx.Response(200, json={"ok": True})
        if request.url.path == f"{SESSION_PREFIX}/query-iq":
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
        if request.url.path == f"{SESSION_PREFIX}/provider-events":
            assert dict(request.url.params) == {"limit": "25", "waitMs": "8000"}
            assert request.extensions["timeout"]["read"] == 10.0
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
        if request.url.path == f"{SESSION_PREFIX}/provider-events/ack":
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
            account_id=TEST_ACCOUNT_ID,
        ),
        http_client=http_client,
    )
    transport = WhatsAppProviderTransportAdapter(client)

    health = await client.health()
    assert health.connected is True
    assert health.account_jid == "15551234567:17@s.whatsapp.net"
    assert health.account_lid == "900000000000001:17@lid"
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
    events = await client.provider_events(limit=25, wait_ms=8_000)
    await client.acknowledge_provider_events(through_sequence=events[0].sequence)

    await http_client.aclose()

    assert [request.url.path for request in requests] == [
        f"{SESSION_PREFIX}/health",
        f"{SESSION_PREFIX}/relay-message",
        f"{SESSION_PREFIX}/raw-node",
        f"{SESSION_PREFIX}/query-iq",
        f"{SESSION_PREFIX}/provider-events",
        f"{SESSION_PREFIX}/provider-events/ack",
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


@pytest.mark.parametrize(
    ("account_jid", "phone_number"),
    [
        ("15551234567@s.whatsapp.net", "15551234567"),
        ("15551234567:1@s.whatsapp.net", "15551234567"),
        ("1234567:255@s.whatsapp.net", "1234567"),
        (None, None),
        ("15551234567@lid", None),
        ("15551234567@hosted", None),
        ("15551234567@s.whatsapp.net.evil.example", None),
        ("+15551234567@s.whatsapp.net", None),
        ("05551234567@s.whatsapp.net", None),
        ("123456@s.whatsapp.net", None),
        ("1234567890123456@s.whatsapp.net", None),
        ("15551234567:0@s.whatsapp.net", None),
        ("15551234567:256@s.whatsapp.net", None),
        ("15551234567_1@s.whatsapp.net", None),
        ("15551234567@s.whatsapp.net ", None),
    ],
)
def test_whatsapp_phone_number_requires_strict_pn_jid(
    account_jid: str | None,
    phone_number: str | None,
) -> None:
    assert whatsapp_phone_number_from_pn_jid(account_jid) == phone_number


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ({"lid": "900000000000001:7@lid"}, "900000000000001:7@lid"),
        ({"lid": "15551234567@s.whatsapp.net"}, None),
        ({"lid": "900000000000001@lid.evil.example"}, None),
        ({"lid": ""}, None),
        ({}, None),
    ],
)
def test_sidecar_health_accepts_only_lid_domain(value, expected) -> None:
    assert _sidecar_account_lid(value) == expected


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
                account_id=TEST_ACCOUNT_ID,
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
            account_id=account_id,
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
    socket_path = "/run/clawdi-whatsapp/sidecar.sock"
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
    service_config = WhatsAppBaileysSidecarConfig(
        unix_socket_path=socket_path,
        api_token="secret",
    )
    assert service_config.account_id is None
    with pytest.raises(ValueError, match="requires HTTPS"):
        WhatsAppBaileysSidecarConfig(base_url="http://sidecar.internal", api_token="secret")


@pytest.mark.asyncio
async def test_whatsapp_sidecar_client_uses_authenticated_strict_unix_socket() -> None:
    account_id = UUID("11111111-1111-4111-8111-111111111111")
    token = "uds-test-token"
    temporary_root = tempfile.TemporaryDirectory(prefix="w", dir="/tmp")
    socket_directory = Path(temporary_root.name) / "run"
    socket_directory.mkdir(mode=0o770)
    os.chmod(socket_directory, 0o770)
    socket_path = socket_directory / "sidecar.sock"

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        request = await reader.readuntil(b"\r\n\r\n")
        assert f"GET /v1/sessions/{account_id}/health HTTP/1.1".encode() in request
        assert f"authorization: bearer {token}\r\n".encode() in request.lower()
        body = json.dumps(
            {
                "sessionId": str(account_id),
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
