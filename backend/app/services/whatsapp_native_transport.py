from __future__ import annotations

import base64
import binascii
import hashlib
import math
import os
import re
import stat
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Literal, Protocol, TypeGuard, cast
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from pydantic import JsonValue, TypeAdapter, ValidationError

from app.services.whatsapp_baileys import (
    BinaryNode,
    parse_whatsapp_jid,
    relay_outbound_extra_attrs,
    validate_relay_outbound_additional_nodes,
)
from app.services.whatsapp_runtime_types import WhatsAppOutboundMessage

_BYTES_SENTINEL = "base64-bytes"
_HEALTH_PATH = "/v1/health"
_RELAY_MESSAGE_PATH = "/v1/relay-message"
_RAW_NODE_PATH = "/v1/raw-node"
_QUERY_IQ_PATH = "/v1/query-iq"
_PROVIDER_EVENTS_PATH = "/v1/provider-events"
_PROVIDER_EVENTS_ACK_PATH = "/v1/provider-events/ack"
_PROVIDER_EVENTS_MAX_WAIT_MS = 8_000
_PROVIDER_EVENTS_READ_TIMEOUT_SECONDS = 10.0
_MAX_PROVIDER_EVENTS_JSON_BYTES = 8 * 1024 * 1024
_MAX_PROVIDER_EVENT_ID_LENGTH = 300
_MAX_PROVIDER_EVENT_NAME_LENGTH = 4096
_MAX_PROVIDER_EVENT_PROTO_BASE64_LENGTH = 4 * 1024 * 1024
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
_PAIRING_RECOVER_PATH = "/v1/pairing/recover"
_MAX_PAIRING_JSON_BYTES = 128 * 1024
_PAIRING_ACTIONS = frozenset({"qr", "code", "cancel", "logout", "retry", "recover"})
_EXPECTED_BAILEYS_RELEASE = {
    "packageName": "@whiskeysockets/baileys",
    "packageVersion": "7.0.0-rc14",
    "sourceCommit": "7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a",
    "version": [2, 3000, 1043857760],
}
_WHATSAPP_PN_JID = re.compile(r"^([1-9][0-9]{6,14})(?::([1-9][0-9]{0,2}))?@s\.whatsapp\.net$")

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
    account_jid: str | None = field(default=None, repr=False)
    account_lid: str | None = field(default=None, repr=False)
    last_disconnect_reason: str | None = None


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
    additional_nodes: tuple[BinaryNode, ...] = ()


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
class WhatsAppRejectedProviderEvent:
    sequence: int
    reason: Literal["invalid_schema", "identity_too_long", "payload_too_large"]


type WhatsAppProviderEvent = WhatsAppProviderMessageEvent | WhatsAppRejectedProviderEvent


@dataclass(frozen=True)
class WhatsAppBaileysSidecarConfig:
    api_token: str = field(repr=False)
    base_url: str | None = None
    unix_socket_path: str | None = None
    timeout_seconds: float = 10.0
    account_id: UUID | None = None

    def __post_init__(self) -> None:
        if (self.base_url is None) == (self.unix_socket_path is None):
            raise ValueError("baileys sidecar requires exactly one transport endpoint")
        if self.base_url is not None:
            validate_whatsapp_sidecar_base_url(self.base_url)
        if self.unix_socket_path is not None:
            validate_whatsapp_sidecar_unix_socket_path(self.unix_socket_path)
        validate_whatsapp_sidecar_api_token(self.api_token)
        if not math.isfinite(self.timeout_seconds) or self.timeout_seconds <= 0:
            raise ValueError("baileys sidecar timeout_seconds must be positive and finite")

    @property
    def binding_revision(self) -> str:
        """Stable, non-secret identity for one provider session revision."""

        if self.account_id is None:
            raise ValueError("baileys sidecar account_id is required for session ownership")
        # Preserve the deployed v1 domain separator so existing durable
        # revisions remain valid; "slot" is not a current architecture concept.
        material = f"clawdi-whatsapp-slot-v1\0{self.account_id}\0{self.endpoint_identity}"
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    @property
    def endpoint_identity(self) -> str:
        if self.unix_socket_path is not None:
            return f"unix:{self.unix_socket_path}"
        if self.base_url is None:  # pragma: no cover - guarded by __post_init__
            raise ValueError("baileys sidecar transport endpoint unavailable")
        return self.base_url


class WhatsAppNativeUpstreamClient(Protocol):
    @property
    def connected(self) -> bool: ...

    async def relay_message(self, request: WhatsAppNativeRelayRequest) -> str | None: ...

    async def send_node(self, node: BinaryNode) -> None: ...

    async def query(self, node: BinaryNode, timeout_ms: int) -> BinaryNode | None: ...


class WhatsAppProviderTransportAdapter:
    """Map authorized provider operations to the physical Baileys transport.

    The wrapped client never owns Agent synthetic auth state and exposes no
    application-level channel adapter.
    """

    def __init__(self, client: WhatsAppNativeUpstreamClient) -> None:
        self._client = client

    @property
    def connected(self) -> bool:
        return self._client.connected

    async def relay_outbound_message(self, message: WhatsAppOutboundMessage) -> str | None:
        return await self._client.relay_message(
            WhatsAppNativeRelayRequest(
                jid=message.to_jid,
                message_id=message.message_id,
                message_proto=message.message_proto,
                additional_attributes=relay_outbound_extra_attrs(message.attrs),
                additional_nodes=validate_relay_outbound_additional_nodes(message.additional_nodes),
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

    def __init__(
        self,
        config: WhatsAppBaileysSidecarConfig,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        api_token = validate_whatsapp_sidecar_api_token(config.api_token)
        self._config = config
        self._api_token = api_token
        self._connected = False
        self._owns_client = http_client is None
        if http_client is not None:
            self._client = http_client
        else:
            self._client = _build_whatsapp_sidecar_http_client(config)

    @property
    def connected(self) -> bool:
        return self._connected

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def refresh_health(self) -> bool:
        health = await self.health()
        self._connected = health.connected
        return self._connected

    async def service_ready(self) -> bool:
        payload = await self._request_json("GET", _HEALTH_PATH, session_scoped=False)
        active_sessions = payload.get("activeSessions")
        if (
            payload.get("schemaVersion") != "clawdi.whatsapp.sidecar-health.v1"
            or payload.get("ready") is not True
            or not isinstance(active_sessions, int)
            or isinstance(active_sessions, bool)
            or active_sessions < 0
            or payload.get("advertisedRelease") != _EXPECTED_BAILEYS_RELEASE
        ):
            raise WhatsAppSidecarProtocolError("unexpected Baileys sidecar service identity")
        return True

    async def health(self) -> WhatsAppSidecarHealth:
        payload = await self._request_json("GET", _HEALTH_PATH)
        expected_account_id = self._config.account_id
        raw_session_id = payload.get("sessionId")
        try:
            session_matches = (
                expected_account_id is not None
                and isinstance(raw_session_id, str)
                and UUID(raw_session_id) == expected_account_id
            )
        except ValueError:
            session_matches = False
        if not session_matches or payload.get("advertisedRelease") != _EXPECTED_BAILEYS_RELEASE:
            raise WhatsAppSidecarProtocolError("unexpected Baileys sidecar identity")
        connected = _required_bool(payload, "connected")
        self._connected = connected
        return WhatsAppSidecarHealth(
            status=_runtime_status(payload.get("status")),
            connected=connected,
            registered=_required_bool(payload, "registered"),
            account_jid=_sidecar_account_jid(payload.get("user")),
            account_lid=_sidecar_account_lid(payload.get("user")),
            last_disconnect_reason=_sidecar_disconnect_reason(payload.get("lastDisconnectReason")),
        )

    async def capabilities(self) -> WhatsAppSidecarCapabilities:
        payload = await self._request_json("GET", _CAPABILITIES_PATH, session_scoped=False)
        pairing = payload.get("pairing")
        pairing_strings = (
            [item for item in pairing if isinstance(item, str)] if isinstance(pairing, list) else []
        )
        if (
            payload.get("schemaVersion") != "clawdi.whatsapp.sidecar-capabilities.v1"
            or not isinstance(pairing, list)
            or len(pairing_strings) != len(pairing)
            or len(pairing_strings) != len(set(pairing_strings))
            or frozenset(pairing_strings) != _PAIRING_ACTIONS
            or payload.get("rawProviderAccess") is not False
        ):
            raise WhatsAppSidecarProtocolError("unsafe Baileys sidecar capabilities")
        return WhatsAppSidecarCapabilities(pairing=frozenset(pairing_strings))

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

    async def pairing_recover(self) -> WhatsAppSidecarPairingStatus:
        return self._remember_pairing_status(
            _pairing_status(await self._request_json("POST", _PAIRING_RECOVER_PATH))
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
                "additionalNodes": _encode_json_value(request.additional_nodes),
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
        decoded_node: BinaryNode = {}
        for key, value in decoded.items():
            decoded_node[key] = value
        return decoded_node

    async def provider_events(
        self,
        *,
        limit: int = 100,
        wait_ms: int = 0,
    ) -> list[WhatsAppProviderEvent]:
        if not 0 <= wait_ms <= _PROVIDER_EVENTS_MAX_WAIT_MS:
            raise ValueError("baileys provider events wait must be between 0 and 8000 milliseconds")
        response = await self._request(
            "GET",
            _PROVIDER_EVENTS_PATH,
            params={"limit": limit, "waitMs": wait_ms},
            timeout=httpx.Timeout(_PROVIDER_EVENTS_READ_TIMEOUT_SECONDS),
        )
        if len(response.content) > _MAX_PROVIDER_EVENTS_JSON_BYTES:
            raise WhatsAppSidecarProtocolError("Baileys provider events response too large")
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
        session_scoped: bool = True,
        timeout: httpx.Timeout | float | None = None,
    ) -> httpx.Response:
        headers = {"Authorization": f"Bearer {self._api_token}"}
        request_path = self._session_path(path) if session_scoped else path
        try:
            if self._config.unix_socket_path is not None:
                _assert_whatsapp_sidecar_unix_socket_ready(self._config.unix_socket_path)
            request_timeout = self._client.timeout if timeout is None else timeout
            if json_body is None:
                response = await self._client.request(
                    method,
                    request_path,
                    headers=headers,
                    params=params,
                    timeout=request_timeout,
                )
            else:
                response = await self._client.request(
                    method,
                    request_path,
                    headers=headers,
                    json=json_body,
                    params=params,
                    timeout=request_timeout,
                )
        except WhatsAppSidecarUnavailableError:
            self._connected = False
            raise
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
        session_scoped: bool = True,
    ) -> Mapping[str, JsonValue]:
        response = await self._request(
            method,
            path,
            json_body=json_body,
            session_scoped=session_scoped,
        )
        if len(response.content) > _MAX_PAIRING_JSON_BYTES:
            raise WhatsAppSidecarProtocolError("Baileys sidecar response too large")
        try:
            value = _response_json(response)
        except ValueError:
            raise WhatsAppSidecarProtocolError("invalid Baileys sidecar response") from None
        if not isinstance(value, dict):
            raise WhatsAppSidecarProtocolError("invalid Baileys sidecar response")
        return value

    def _session_path(self, path: str) -> str:
        account_id = self._config.account_id
        if account_id is None:  # pragma: no cover - guarded by config
            raise WhatsAppSidecarProtocolError("Baileys sidecar session identity unavailable")
        if not path.startswith("/v1/"):
            raise WhatsAppSidecarProtocolError("invalid Baileys sidecar request path")
        return f"/v1/sessions/{account_id}/{path.removeprefix('/v1/')}"


class WhatsAppBaileysSidecarService:
    """Own one reusable HTTP pool and create lightweight session-scoped views."""

    def __init__(
        self,
        config: WhatsAppBaileysSidecarConfig,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        if config.account_id is not None:
            raise ValueError("baileys sidecar service config must not contain a session identity")
        self._config = config
        self._owns_client = http_client is None
        self._http_client = http_client or _build_whatsapp_sidecar_http_client(config)
        self._probe = WhatsAppBaileysSidecarClient(config, http_client=self._http_client)

    def session_client(self, session_id: UUID) -> WhatsAppBaileysSidecarClient:
        return WhatsAppBaileysSidecarClient(
            replace(self._config, account_id=session_id),
            http_client=self._http_client,
        )

    async def service_ready(self) -> bool:
        return await self._probe.service_ready()

    async def capabilities(self) -> WhatsAppSidecarCapabilities:
        return await self._probe.capabilities()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._http_client.aclose()


def _build_whatsapp_sidecar_http_client(
    config: WhatsAppBaileysSidecarConfig,
) -> httpx.AsyncClient:
    limits = httpx.Limits(
        max_connections=256,
        max_keepalive_connections=64,
        keepalive_expiry=30.0,
    )
    if config.unix_socket_path is not None:
        return httpx.AsyncClient(
            base_url="http://localhost",
            transport=httpx.AsyncHTTPTransport(
                uds=validate_whatsapp_sidecar_unix_socket_path(config.unix_socket_path),
                trust_env=False,
                limits=limits,
            ),
            timeout=httpx.Timeout(config.timeout_seconds),
        )
    if config.base_url is None:  # pragma: no cover - guarded by config
        raise ValueError("baileys sidecar transport endpoint unavailable")
    return httpx.AsyncClient(
        base_url=validate_whatsapp_sidecar_base_url(config.base_url),
        timeout=httpx.Timeout(config.timeout_seconds),
        limits=limits,
        trust_env=False,
    )


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


def validate_whatsapp_sidecar_unix_socket_path(value: str) -> str:
    """Return a canonical service UDS path without relaxing TCP origin policy."""

    if (
        not value
        or value != value.strip()
        or "\x00" in value
        or not os.path.isabs(value)
        or os.path.normpath(value) != value
        or len(os.fsencode(value)) > 103
        or os.path.basename(value) != "sidecar.sock"
    ):
        raise ValueError(
            "baileys sidecar unix_socket_path must be a bounded absolute "
            "normalized sidecar.sock path"
        )
    return value


def _assert_whatsapp_sidecar_unix_socket_ready(value: str) -> None:
    path = validate_whatsapp_sidecar_unix_socket_path(value)
    parent = os.path.dirname(path)
    try:
        parent_stat = os.lstat(parent)
        socket_stat = os.lstat(path)
        expected_uid = os.getuid()
        expected_gid = os.getgid()
        if (
            stat.S_ISLNK(parent_stat.st_mode)
            or not stat.S_ISDIR(parent_stat.st_mode)
            or os.path.realpath(parent) != parent
            or stat.S_IMODE(parent_stat.st_mode) != 0o770
            or parent_stat.st_uid != expected_uid
            or parent_stat.st_gid != expected_gid
            or stat.S_ISLNK(socket_stat.st_mode)
            or not stat.S_ISSOCK(socket_stat.st_mode)
            or stat.S_IMODE(socket_stat.st_mode) != 0o660
            or socket_stat.st_uid != expected_uid
            or socket_stat.st_gid != expected_gid
        ):
            raise OSError("unsafe sidecar Unix socket")
    except OSError:
        raise WhatsAppSidecarUnavailableError("Baileys sidecar unavailable") from None


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


def _sidecar_account_jid(value: JsonValue | None) -> str | None:
    if not isinstance(value, dict):
        return None
    account_jid = value.get("id")
    if not isinstance(account_jid, str) or not account_jid or len(account_jid) > 128:
        return None
    return account_jid


def _sidecar_account_lid(value: JsonValue | None) -> str | None:
    if not isinstance(value, dict):
        return None
    account_lid = value.get("lid")
    if not isinstance(account_lid, str) or len(account_lid) > 128:
        return None
    parsed = parse_whatsapp_jid(account_lid)
    if parsed is None or parsed.server != "lid":
        return None
    return account_lid


def _sidecar_disconnect_reason(value: JsonValue | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > 128:
        raise WhatsAppSidecarProtocolError("invalid Baileys sidecar disconnect reason")
    return value


def whatsapp_phone_number_from_pn_jid(account_jid: str | None) -> str | None:
    """Return click-to-chat digits only for a strict Baileys PN user JID."""

    if account_jid is None or len(account_jid) > 128:
        return None
    match = _WHATSAPP_PN_JID.fullmatch(account_jid)
    if match is None:
        return None
    raw_device = match.group(2)
    if raw_device is not None and int(raw_device) > 255:
        return None
    return match.group(1)


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


def _provider_message_event(value: JsonValue) -> WhatsAppProviderEvent:
    if not isinstance(value, dict):
        raise WhatsAppSidecarProtocolError("Baileys provider event has no sequence")
    sequence = value.get("sequence")
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1:
        raise WhatsAppSidecarProtocolError("Baileys provider event has no sequence")
    if value.get("eventType") != "messages.upsert" or value.get("fromMe") is not False:
        return WhatsAppRejectedProviderEvent(sequence=sequence, reason="invalid_schema")
    message_id = _event_str(value, "messageId")
    remote_jid = _event_str(value, "remoteJid")
    raw_proto = _event_str(value, "messageProtoBase64")
    if message_id is None or remote_jid is None or raw_proto is None:
        return WhatsAppRejectedProviderEvent(sequence=sequence, reason="invalid_schema")
    if any(len(item) > _MAX_PROVIDER_EVENT_ID_LENGTH for item in (message_id, remote_jid)):
        return WhatsAppRejectedProviderEvent(sequence=sequence, reason="identity_too_long")
    if len(raw_proto) > _MAX_PROVIDER_EVENT_PROTO_BASE64_LENGTH:
        return WhatsAppRejectedProviderEvent(sequence=sequence, reason="payload_too_large")
    try:
        message_proto = base64.b64decode(raw_proto, validate=True)
    except ValueError:
        return WhatsAppRejectedProviderEvent(sequence=sequence, reason="invalid_schema")
    if not message_proto:
        return WhatsAppRejectedProviderEvent(sequence=sequence, reason="invalid_schema")
    timestamp = value.get("messageTimestamp")
    if timestamp is not None and (
        isinstance(timestamp, bool) or not isinstance(timestamp, int) or timestamp < 1
    ):
        return WhatsAppRejectedProviderEvent(sequence=sequence, reason="invalid_schema")
    optional_identity_keys = ("remoteJidAlt", "participant", "participantAlt")
    optional_identities = tuple(_event_str(value, key) for key in optional_identity_keys)
    if any(
        value.get(key) is not None and item is None
        for key, item in zip(optional_identity_keys, optional_identities, strict=True)
    ):
        return WhatsAppRejectedProviderEvent(sequence=sequence, reason="invalid_schema")
    if any(
        item is not None and len(item) > _MAX_PROVIDER_EVENT_ID_LENGTH
        for item in optional_identities
    ):
        return WhatsAppRejectedProviderEvent(sequence=sequence, reason="identity_too_long")
    push_name = _event_str(value, "pushName")
    if value.get("pushName") is not None and push_name is None:
        return WhatsAppRejectedProviderEvent(sequence=sequence, reason="invalid_schema")
    if push_name is not None and len(push_name) > _MAX_PROVIDER_EVENT_NAME_LENGTH:
        return WhatsAppRejectedProviderEvent(sequence=sequence, reason="identity_too_long")
    return WhatsAppProviderMessageEvent(
        sequence=sequence,
        message_id=message_id,
        remote_jid=remote_jid,
        remote_jid_alt=optional_identities[0],
        participant=optional_identities[1],
        participant_alt=optional_identities[2],
        push_name=push_name,
        message_timestamp=timestamp,
        message_proto=message_proto,
    )


def _event_str(value: Mapping[str, JsonValue], key: str) -> str | None:
    item = value.get(key)
    return item if isinstance(item, str) and item else None


def _encode_json_value(value: object) -> JsonValue:
    if isinstance(value, bytes):
        return {
            "$type": _BYTES_SENTINEL,
            "base64": base64.b64encode(value).decode("ascii"),
        }
    if _is_object_mapping(value):
        return {str(key): _encode_json_value(inner) for key, inner in value.items()}
    if _is_object_sequence(value):
        return [_encode_json_value(inner) for inner in value]
    return _encode_scalar(value)


def _encode_scalar(value: object) -> JsonValue:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _is_object_mapping(value: object) -> TypeGuard[Mapping[object, object]]:
    return isinstance(value, Mapping)


def _is_object_sequence(
    value: object,
) -> TypeGuard[list[object] | tuple[object, ...]]:
    return isinstance(value, (list, tuple))


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
