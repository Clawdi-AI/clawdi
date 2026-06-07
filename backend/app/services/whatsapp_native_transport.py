from __future__ import annotations

import base64
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import httpx

from app.services.whatsapp_baileys import BinaryNode, relay_outbound_extra_attrs
from app.services.whatsapp_runtime_types import WhatsAppOutboundMessage

_BYTES_SENTINEL = "base64-bytes"
_HEALTH_PATH = "/v1/health"
_RELAY_MESSAGE_PATH = "/v1/relay-message"
_RAW_NODE_PATH = "/v1/raw-node"
_QUERY_IQ_PATH = "/v1/query-iq"


@dataclass(frozen=True)
class WhatsAppNativeRelayRequest:
    jid: str
    message_id: str
    message_proto: bytes
    additional_attributes: Mapping[str, str]


@dataclass(frozen=True)
class WhatsAppBaileysSidecarConfig:
    base_url: str
    api_token: str | None = None
    timeout_seconds: float = 10.0


class WhatsAppNativeUpstreamClient(Protocol):
    @property
    def connected(self) -> bool:
        ...

    async def relay_message(self, request: WhatsAppNativeRelayRequest) -> None:
        ...

    async def send_node(self, node: BinaryNode) -> None:
        ...

    async def query(self, node: BinaryNode, timeout_ms: int) -> BinaryNode | None:
        ...


class WhatsAppNativeTransportAdapter:
    """Adapter from Clawdi's shared-bot seam to a native WhatsApp Web runtime.

    The wrapped client can be an in-process Python implementation or a narrow
    HTTP wrapper around a Baileys sidecar. Clawdi owns product state; this seam
    only relays Baileys-native protocol operations that Cloud API cannot express.
    """

    def __init__(self, client: WhatsAppNativeUpstreamClient) -> None:
        self._client = client

    @property
    def connected(self) -> bool:
        return self._client.connected

    @property
    def transport_mode(self) -> Literal["in_process", "sidecar"]:
        mode = getattr(self._client, "transport_mode", "in_process")
        return "sidecar" if mode == "sidecar" else "in_process"

    async def relay_outbound_message(self, message: WhatsAppOutboundMessage) -> None:
        await self._client.relay_message(
            WhatsAppNativeRelayRequest(
                jid=message.to_jid,
                message_id=message.message_id,
                message_proto=message.message_proto,
                additional_attributes=relay_outbound_extra_attrs(message.attrs),
            )
        )

    async def relay_raw_node(self, node: BinaryNode) -> None:
        await self._client.send_node(node)

    async def query_iq(self, node: BinaryNode, timeout_ms: int) -> BinaryNode | None:
        return await self._client.query(node, timeout_ms)


class WhatsAppBaileysSidecarClient:
    """HTTP client for the Clawdi-owned Baileys protocol sidecar.

    This is intentionally smaller than Hermes' bridge. It has no pairing policy,
    routing, chunking, allowlist, or product database knowledge. The sidecar owns
    only Baileys socket/session/protocol operations.
    """

    transport_mode: Literal["sidecar"] = "sidecar"

    def __init__(
        self,
        config: WhatsAppBaileysSidecarConfig,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        base_url = config.base_url.rstrip("/")
        if not base_url:
            raise ValueError("baileys sidecar base_url is required")
        self._config = config
        self._connected = False
        self._owns_client = http_client is None
        self._client = http_client or httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(config.timeout_seconds),
        )

    @property
    def connected(self) -> bool:
        return self._connected

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def refresh_health(self) -> bool:
        response = await self._request("GET", _HEALTH_PATH)
        data = response.json()
        self._connected = _sidecar_health_connected(data)
        return self._connected

    async def relay_message(self, request: WhatsAppNativeRelayRequest) -> None:
        await self._request(
            "POST",
            _RELAY_MESSAGE_PATH,
            json={
                "jid": request.jid,
                "messageId": request.message_id,
                "messageProtoBase64": base64.b64encode(request.message_proto).decode("ascii"),
                "additionalAttributes": dict(request.additional_attributes),
            },
        )
        self._connected = True

    async def send_node(self, node: BinaryNode) -> None:
        await self._request(
            "POST",
            _RAW_NODE_PATH,
            json={"node": _encode_json_value(node)},
        )
        self._connected = True

    async def query(self, node: BinaryNode, timeout_ms: int) -> BinaryNode | None:
        response = await self._request(
            "POST",
            _QUERY_IQ_PATH,
            json={"node": _encode_json_value(node), "timeoutMs": timeout_ms},
        )
        self._connected = True
        data = response.json()
        if data is None:
            return None
        if isinstance(data, Mapping) and data.get("node") is None and "node" in data:
            return None
        raw_node = data.get("node", data) if isinstance(data, Mapping) else data
        decoded = _decode_json_value(raw_node)
        if not isinstance(decoded, dict):
            raise ValueError("baileys sidecar query response must be a node object or null")
        return decoded

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers = dict(kwargs.pop("headers", {}) or {})
        if self._config.api_token:
            headers["Authorization"] = f"Bearer {self._config.api_token}"
        response = await self._client.request(method, path, headers=headers, **kwargs)
        response.raise_for_status()
        return response


def _sidecar_health_connected(data: Any) -> bool:
    if not isinstance(data, Mapping):
        return False
    if isinstance(data.get("connected"), bool):
        return bool(data["connected"])
    return str(data.get("status") or "").lower() == "connected"


def _encode_json_value(value: Any) -> Any:
    if isinstance(value, bytes):
        return {
            "$type": _BYTES_SENTINEL,
            "base64": base64.b64encode(value).decode("ascii"),
        }
    if isinstance(value, Mapping):
        return {str(key): _encode_json_value(inner) for key, inner in value.items()}
    if isinstance(value, (list, tuple)):
        return [_encode_json_value(inner) for inner in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _decode_json_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        if value.get("$type") == _BYTES_SENTINEL:
            raw = value.get("base64")
            if not isinstance(raw, str):
                raise ValueError("encoded bytes require a base64 string")
            return base64.b64decode(raw)
        if value.get("type") == "Buffer" and isinstance(value.get("data"), list):
            return bytes(int(part) for part in value["data"])
        return {str(key): _decode_json_value(inner) for key, inner in value.items()}
    if isinstance(value, list):
        return [_decode_json_value(inner) for inner in value]
    return value
