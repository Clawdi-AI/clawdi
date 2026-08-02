from __future__ import annotations

import base64
import binascii
import hashlib
import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal, Protocol, cast
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from pydantic import JsonValue, TypeAdapter, ValidationError

from app.services.whatsapp_baileys import BinaryNode, relay_outbound_extra_attrs
from app.services.whatsapp_runtime_types import WhatsAppOutboundMessage

_BYTES_SENTINEL = "base64-bytes"
_HEALTH_PATH = "/v1/health"
_RELAY_MESSAGE_PATH = "/v1/relay-message"
_RAW_NODE_PATH = "/v1/raw-node"
_QUERY_IQ_PATH = "/v1/query-iq"
_PROVIDER_EVENTS_PATH = "/v1/provider-events"
_PROVIDER_EVENTS_ACK_PATH = "/v1/provider-events/ack"
_JSON_VALUE_ADAPTER: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)

type _NativeNodeValue = (
    bytes
    | str
    | int
    | float
    | bool
    | None
    | Mapping[str, _NativeNodeValue]
    | list[_NativeNodeValue]
    | tuple[_NativeNodeValue, ...]
)
_CAPABILITIES_PATH = "/v1/capabilities"
_PAIRING_STATUS_PATH = "/v1/pairing/status"
_PAIRING_QR_PATH = "/v1/pairing/qr"
_PAIRING_CODE_PATH = "/v1/pairing/code"
_PAIRING_CANCEL_PATH = "/v1/pairing/cancel"
_PAIRING_LOGOUT_PATH = "/v1/pairing/logout"
_PAIRING_RETRY_PATH = "/v1/pairing/retry"
_MAX_PAIRING_JSON_BYTES = 128 * 1024
_PAIRING_ACTIONS = frozenset({"qr", "code", "cancel", "logout", "retry"})
_EXPECTED_BAILEYS_RELEASE = {
    "packageName": "@whiskeysockets/baileys",
    "packageVersion": "7.0.0-rc13",
    "sourceCommit": "8053b086ecc97ec3f78299561de11959bab05d39",
    "version": [2, 3000, 1035194821],
}

WhatsAppSidecarRuntimeStatus = Literal[
    "starting",
    "connecting",
    "pairing_qr",
    "pairing_code",
    "connected",
    "disconnected",
    "stopped",
]


class WhatsAppSidecarError(Exception):
    """Redacted physical-sidecar failure safe for lifecycle handling."""


class WhatsAppSidecarUnavailableError(WhatsAppSidecarError):
    pass


class WhatsAppSidecarRejectedError(WhatsAppSidecarError):
    pass


class WhatsAppSidecarProtocolError(WhatsAppSidecarError):
    pass


@dataclass(frozen=True)
class WhatsAppSidecarHealth:
    status: WhatsAppSidecarRuntimeStatus
    connected: bool
    registered: bool


@dataclass(frozen=True)
class WhatsAppSidecarCapabilities:
    pairing: frozenset[str]


@dataclass(frozen=True)
class WhatsAppSidecarPairingStatus:
    status: WhatsAppSidecarRuntimeStatus
    registered: bool
    method: Literal["qr", "code"] | None = None
    qr: str | None = field(default=None, repr=False)
    qr_expires_at: datetime | None = field(default=None, repr=False)
    code: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class WhatsAppNativeRelayRequest:
    jid: str
    message_id: str
    message_proto: bytes
    additional_attributes: Mapping[str, str]


@dataclass(frozen=True)
class WhatsAppProviderMessageEvent:
    sequence: int
    message_id: str
    remote_jid: str
    remote_jid_alt: str | None
    participant: str | None
    participant_alt: str | None
    push_name: str | None
    message_timestamp: int | None
    message_proto: bytes


@dataclass(frozen=True)
class WhatsAppBaileysSidecarConfig:
    base_url: str
    api_token: str = field(repr=False)
    timeout_seconds: float = 10.0
    account_id: UUID | None = None

    def __post_init__(self) -> None:
        validate_whatsapp_sidecar_base_url(self.base_url)
        validate_whatsapp_sidecar_api_token(self.api_token)
        if not math.isfinite(self.timeout_seconds) or self.timeout_seconds <= 0:
            raise ValueError("baileys sidecar timeout_seconds must be positive and finite")

    @property
    def binding_revision(self) -> str:
        """Stable, non-secret identity for one configured physical slot revision."""

        if self.account_id is None:
            raise ValueError("baileys sidecar account_id is required for slot ownership")
        material = f"clawdi-whatsapp-slot-v1\0{self.account_id}\0{self.base_url}"
        return hashlib.sha256(material.encode("utf-8")).hexdigest()


class WhatsAppNativeUpstreamClient(Protocol):
    @property
    def connected(self) -> bool: ...

    async def relay_message(self, request: WhatsAppNativeRelayRequest) -> str | None: ...

    async def send_node(self, node: BinaryNode) -> None: ...

    async def query(self, node: BinaryNode, timeout_ms: int) -> BinaryNode | None: ...


class WhatsAppProviderTransportAdapter:
    """Map authorized provider operations to the physical Baileys transport.

    The wrapped client can be in-process or a narrow HTTP client. It never owns
    Agent synthetic auth state and exposes no application-level channel adapter.
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

    async def relay_outbound_message(self, message: WhatsAppOutboundMessage) -> str | None:
        return await self._client.relay_message(
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
        base_url = validate_whatsapp_sidecar_base_url(config.base_url)
        api_token = validate_whatsapp_sidecar_api_token(config.api_token)
        self._config = config
        self._api_token = api_token
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
        if self._config.account_id is not None:
            health = await self.health()
            self._connected = health.connected
            return self._connected
        response = await self._request("GET", _HEALTH_PATH)
        data = _response_json(response)
        self._connected = _sidecar_health_connected(data)
        return self._connected

    async def health(self) -> WhatsAppSidecarHealth:
        payload = await self._request_json("GET", _HEALTH_PATH)
        expected_account_id = self._config.account_id
        raw_account_id = payload.get("accountId")
        try:
            account_matches = (
                expected_account_id is not None
                and isinstance(raw_account_id, str)
                and UUID(raw_account_id) == expected_account_id
            )
        except ValueError:
            account_matches = False
        if not account_matches or payload.get("advertisedRelease") != _EXPECTED_BAILEYS_RELEASE:
            raise WhatsAppSidecarProtocolError("unexpected Baileys sidecar identity")
        connected = _required_bool(payload, "connected")
        self._connected = connected
        return WhatsAppSidecarHealth(
            status=_runtime_status(payload.get("status")),
            connected=connected,
            registered=_required_bool(payload, "registered"),
        )

    async def capabilities(self) -> WhatsAppSidecarCapabilities:
        payload = await self._request_json("GET", _CAPABILITIES_PATH)
        pairing = payload.get("pairing")
        if (
            payload.get("schemaVersion") != "clawdi.whatsapp.sidecar-capabilities.v1"
            or not isinstance(pairing, list)
            or not all(isinstance(item, str) for item in pairing)
            or len(pairing) != len(set(pairing))
            or set(pairing) != _PAIRING_ACTIONS
            or payload.get("rawProviderAccess") is not False
        ):
            raise WhatsAppSidecarProtocolError("unsafe Baileys sidecar capabilities")
        return WhatsAppSidecarCapabilities(pairing=frozenset(pairing))

    async def pairing_status(self) -> WhatsAppSidecarPairingStatus:
        return self._remember_pairing_status(
            _pairing_status(await self._request_json("GET", _PAIRING_STATUS_PATH))
        )

    async def pairing_qr(self) -> WhatsAppSidecarPairingStatus:
        return self._remember_pairing_status(
            _pairing_status(await self._request_json("POST", _PAIRING_QR_PATH))
        )

    async def pairing_code(self, phone_number: str) -> WhatsAppSidecarPairingStatus:
        return self._remember_pairing_status(
            _pairing_status(
                await self._request_json(
                    "POST",
                    _PAIRING_CODE_PATH,
                    json_body={"phoneNumber": phone_number},
                )
            )
        )

    async def pairing_cancel(self) -> WhatsAppSidecarPairingStatus:
        return self._remember_pairing_status(
            _pairing_status(await self._request_json("POST", _PAIRING_CANCEL_PATH))
        )

    async def pairing_logout(self) -> WhatsAppSidecarPairingStatus:
        return self._remember_pairing_status(
            _pairing_status(await self._request_json("POST", _PAIRING_LOGOUT_PATH))
        )

    async def pairing_retry(self) -> WhatsAppSidecarPairingStatus:
        return self._remember_pairing_status(
            _pairing_status(await self._request_json("POST", _PAIRING_RETRY_PATH))
        )

    def _remember_pairing_status(
        self,
        pairing: WhatsAppSidecarPairingStatus,
    ) -> WhatsAppSidecarPairingStatus:
        self._connected = pairing.status == "connected" and pairing.registered
        return pairing

    async def relay_message(self, request: WhatsAppNativeRelayRequest) -> str | None:
        response = await self._request(
            "POST",
            _RELAY_MESSAGE_PATH,
            json_body={
                "jid": request.jid,
                "messageId": request.message_id,
                "messageProtoBase64": base64.b64encode(request.message_proto).decode("ascii"),
                "additionalAttributes": dict(request.additional_attributes),
            },
        )
        self._connected = True
        data = _response_json(response)
        if not isinstance(data, dict):
            raise ValueError("baileys provider relay response must be an object")
        message_id = data.get("messageId")
        return str(message_id) if isinstance(message_id, str) and message_id else None

    async def send_node(self, node: BinaryNode) -> None:
        await self._request(
            "POST",
            _RAW_NODE_PATH,
            json_body={"node": _encode_json_value(node)},
        )
        self._connected = True

    async def query(self, node: BinaryNode, timeout_ms: int) -> BinaryNode | None:
        response = await self._request(
            "POST",
            _QUERY_IQ_PATH,
            json_body={"node": _encode_json_value(node), "timeoutMs": timeout_ms},
        )
        self._connected = True
        data = _response_json(response)
        if data is None:
            return None
        if isinstance(data, dict) and data.get("node") is None and "node" in data:
            return None
        raw_node = data.get("node", data) if isinstance(data, dict) else data
        decoded = _decode_json_value(raw_node)
        if not isinstance(decoded, dict):
            raise ValueError("baileys sidecar query response must be a node object or null")
        return decoded

    async def provider_events(self, *, limit: int = 100) -> list[WhatsAppProviderMessageEvent]:
        response = await self._request("GET", _PROVIDER_EVENTS_PATH, params={"limit": limit})
        data = _response_json(response)
        if not isinstance(data, dict):
            raise ValueError("baileys provider events response must contain an event list")
        events = data.get("events")
        if not isinstance(events, list):
            raise ValueError("baileys provider events response must contain an event list")
        return [_provider_message_event(item) for item in events]

    async def acknowledge_provider_events(self, *, through_sequence: int) -> None:
        await self._request(
            "POST",
            _PROVIDER_EVENTS_ACK_PATH,
            json_body={"throughSequence": through_sequence},
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: JsonValue = None,
        params: Mapping[str, str | int] | None = None,
    ) -> httpx.Response:
        headers = {"Authorization": f"Bearer {self._api_token}"}
        try:
            if json_body is None:
                response = await self._client.request(
                    method,
                    path,
                    headers=headers,
                    params=params,
                )
            else:
                response = await self._client.request(
                    method,
                    path,
                    headers=headers,
                    json=json_body,
                    params=params,
                )
        except httpx.HTTPError:
            self._connected = False
            raise WhatsAppSidecarUnavailableError("Baileys sidecar unavailable") from None
        if response.status_code >= 500:
            self._connected = False
            raise WhatsAppSidecarUnavailableError("Baileys sidecar unavailable")
        if response.status_code >= 400:
            raise WhatsAppSidecarRejectedError("Baileys sidecar rejected request")
        return response

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: JsonValue = None,
    ) -> Mapping[str, JsonValue]:
        response = await self._request(method, path, json_body=json_body)
        if len(response.content) > _MAX_PAIRING_JSON_BYTES:
            raise WhatsAppSidecarProtocolError("Baileys sidecar response too large")
        try:
            value = _response_json(response)
        except ValueError:
            raise WhatsAppSidecarProtocolError("invalid Baileys sidecar response") from None
        if not isinstance(value, dict):
            raise WhatsAppSidecarProtocolError("invalid Baileys sidecar response")
        return value


def validate_whatsapp_sidecar_base_url(value: str) -> str:
    """Return a canonical internal sidecar origin or fail closed."""

    candidate = value.strip()
    try:
        parsed = urlsplit(candidate)
        parsed.port
    except ValueError as exc:
        raise ValueError("baileys sidecar base_url must be a valid HTTP(S) origin") from exc
    hostname = parsed.hostname
    if (
        not candidate
        or candidate != value
        or parsed.scheme.lower() not in {"http", "https"}
        or not parsed.netloc
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or "?" in candidate
        or "#" in candidate
        or any(character.isspace() for character in candidate)
        or "\\" in candidate
        or ";" in parsed.netloc
        or "%" in parsed.netloc
        or parsed.netloc.endswith(":")
    ):
        raise ValueError("baileys sidecar base_url must be an HTTP(S) origin without userinfo")
    if parsed.scheme.lower() == "http" and hostname.lower() not in {
        "localhost",
        "127.0.0.1",
        "::1",
    }:
        raise ValueError("baileys sidecar base_url requires HTTPS except for exact loopback hosts")
    return candidate.rstrip("/")


def validate_whatsapp_sidecar_api_token(value: str) -> str:
    token = value.strip()
    if (
        not token
        or token != value
        or len(token) > 4096
        or any(ord(character) < 0x21 or ord(character) > 0x7E for character in token)
    ):
        raise ValueError(
            "baileys sidecar api_token must be a non-empty printable ASCII bearer value"
        )
    return token


def _response_json(response: httpx.Response) -> JsonValue:
    try:
        return _JSON_VALUE_ADAPTER.validate_json(response.content)
    except ValidationError as exc:
        raise ValueError("baileys sidecar response must be valid JSON") from exc


def _sidecar_health_connected(data: JsonValue) -> bool:
    if not isinstance(data, dict):
        return False
    connected = data.get("connected")
    if isinstance(connected, bool):
        return connected
    return str(data.get("status") or "").lower() == "connected"


def _runtime_status(value: object) -> WhatsAppSidecarRuntimeStatus:
    allowed = {
        "starting",
        "connecting",
        "pairing_qr",
        "pairing_code",
        "connected",
        "disconnected",
        "stopped",
    }
    if not isinstance(value, str) or value not in allowed:
        raise WhatsAppSidecarProtocolError("invalid Baileys sidecar status")
    return cast(WhatsAppSidecarRuntimeStatus, value)


def _required_bool(value: Mapping[str, JsonValue], key: str) -> bool:
    raw = value.get(key)
    if not isinstance(raw, bool):
        raise WhatsAppSidecarProtocolError("invalid Baileys sidecar response")
    return raw


def _optional_secret(value: JsonValue, *, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise WhatsAppSidecarProtocolError("invalid Baileys sidecar pairing response")
    return value


def _optional_expiry(value: JsonValue) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 64:
        raise WhatsAppSidecarProtocolError("invalid Baileys sidecar pairing response")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise WhatsAppSidecarProtocolError("invalid Baileys sidecar pairing response") from None
    if parsed.tzinfo is None:
        raise WhatsAppSidecarProtocolError("invalid Baileys sidecar pairing response")
    return parsed.astimezone(UTC)


def _pairing_status(value: Mapping[str, JsonValue]) -> WhatsAppSidecarPairingStatus:
    runtime_status = _runtime_status(value.get("status"))
    if runtime_status == "connecting":
        raise WhatsAppSidecarProtocolError("invalid Baileys sidecar pairing response")
    registered = _required_bool(value, "registered")
    raw_method = value.get("method")
    if raw_method is not None and raw_method not in {"qr", "code"}:
        raise WhatsAppSidecarProtocolError("invalid Baileys sidecar pairing response")
    method = cast(Literal["qr", "code"] | None, raw_method)
    qr = _optional_secret(value.get("qr"), maximum=65_536)
    qr_expires_at = _optional_expiry(value.get("qrExpiresAt"))
    code = _optional_secret(value.get("code"), maximum=200)
    if (qr is not None or qr_expires_at is not None) and method != "qr":
        raise WhatsAppSidecarProtocolError("invalid Baileys sidecar pairing response")
    if code is not None and method != "code":
        raise WhatsAppSidecarProtocolError("invalid Baileys sidecar pairing response")
    if runtime_status == "pairing_qr" and (qr is None or qr_expires_at is None):
        raise WhatsAppSidecarProtocolError("invalid Baileys sidecar pairing response")
    if runtime_status == "pairing_code" and code is None:
        raise WhatsAppSidecarProtocolError("invalid Baileys sidecar pairing response")
    if registered and (qr is not None or code is not None):
        raise WhatsAppSidecarProtocolError("registered Baileys sidecar exposed pairing material")
    return WhatsAppSidecarPairingStatus(
        status=runtime_status,
        registered=registered,
        method=method,
        qr=qr,
        qr_expires_at=qr_expires_at,
        code=code,
    )


def _provider_message_event(value: JsonValue) -> WhatsAppProviderMessageEvent:
    if not isinstance(value, dict):
        raise ValueError("baileys provider event must be an object")
    sequence = value.get("sequence")
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1:
        raise ValueError("baileys provider event sequence must be positive")
    if value.get("eventType") != "messages.upsert" or value.get("fromMe") is not False:
        raise ValueError("unsupported baileys provider event")
    message_id = _required_event_str(value, "messageId")
    remote_jid = _required_event_str(value, "remoteJid")
    raw_proto = _required_event_str(value, "messageProtoBase64")
    try:
        message_proto = base64.b64decode(raw_proto, validate=True)
    except ValueError as exc:
        raise ValueError("baileys provider event proto must be base64") from exc
    if not message_proto:
        raise ValueError("baileys provider event proto must not be empty")
    timestamp = value.get("messageTimestamp")
    if timestamp is not None and (
        isinstance(timestamp, bool) or not isinstance(timestamp, int) or timestamp < 1
    ):
        raise ValueError("baileys provider event timestamp must be positive")
    return WhatsAppProviderMessageEvent(
        sequence=sequence,
        message_id=message_id,
        remote_jid=remote_jid,
        remote_jid_alt=_optional_event_str(value, "remoteJidAlt"),
        participant=_optional_event_str(value, "participant"),
        participant_alt=_optional_event_str(value, "participantAlt"),
        push_name=_optional_event_str(value, "pushName"),
        message_timestamp=timestamp,
        message_proto=message_proto,
    )


def _required_event_str(value: Mapping[str, JsonValue], key: str) -> str:
    item = _optional_event_str(value, key)
    if item is None:
        raise ValueError(f"baileys provider event {key} is required")
    return item


def _optional_event_str(value: Mapping[str, JsonValue], key: str) -> str | None:
    item = value.get(key)
    return item if isinstance(item, str) and item else None


def _encode_json_value(value: _NativeNodeValue) -> JsonValue:
    if isinstance(value, bytes):
        return {
            "$type": _BYTES_SENTINEL,
            "base64": base64.b64encode(value).decode("ascii"),
        }
    if isinstance(value, Mapping):
        return {str(key): _encode_json_value(inner) for key, inner in value.items()}
    if isinstance(value, (list, tuple)):
        return [_encode_json_value(inner) for inner in value]
    return _encode_scalar(value)


def _encode_scalar(value: object) -> JsonValue:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _decode_json_value(value: JsonValue) -> _NativeNodeValue:
    if isinstance(value, dict):
        if value.get("$type") == _BYTES_SENTINEL:
            raw = value.get("base64")
            if not isinstance(raw, str):
                raise ValueError("encoded bytes require a base64 string")
            try:
                return base64.b64decode(raw, validate=True)
            except binascii.Error as exc:
                raise ValueError("encoded bytes require valid base64") from exc
        buffer_data = value.get("data")
        if value.get("type") == "Buffer" and isinstance(buffer_data, list):
            return bytes(_buffer_byte(part) for part in buffer_data)
        return {key: _decode_json_value(inner) for key, inner in value.items()}
    if isinstance(value, list):
        return [_decode_json_value(inner) for inner in value]
    return value


def _buffer_byte(value: JsonValue) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 255:
        raise ValueError("encoded Buffer bytes must be integers between 0 and 255")
    return value
