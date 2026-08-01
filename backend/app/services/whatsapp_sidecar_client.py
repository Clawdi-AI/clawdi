from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal, cast
from urllib.parse import quote
from uuid import UUID

import httpx

_SAFE_ERROR_CODE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,119}$")
_OPAQUE_MEDIA_ID = re.compile(r"^media_[A-Za-z0-9_-]{43}$")
_E164_DIGITS = re.compile(r"^[1-9][0-9]{6,14}$")
_RUNTIME_STATUSES = frozenset(
    {"starting", "pairing_qr", "pairing_code", "connected", "disconnected", "fatal", "stopped"}
)
_OPERATIONS = ("send", "edit", "delete", "reaction", "presence", "read")
_PAIRING_ACTIONS = ("qr", "code", "cancel", "logout", "recover")
_JID_KINDS = ("pn", "lid", "group")
WHATSAPP_CHAT_PRESENCE_VALUES = frozenset({"composing", "recording", "paused"})
WHATSAPP_OPERATION_MAX_MEDIA_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_MEDIA_DOWNLOAD_BYTES = 16 * 1024 * 1024
DEFAULT_MAX_JSON_BYTES = 1024 * 1024
EXPECTED_BAILEYS_RELEASE = {
    "packageName": "@whiskeysockets/baileys",
    "packageVersion": "7.0.0-rc13",
    "sourceCommit": "8053b086ecc97ec3f78299561de11959bab05d39",
    "version": [2, 3000, 1035194821],
}

WhatsAppRuntimeStatus = Literal[
    "starting",
    "pairing_qr",
    "pairing_code",
    "connected",
    "disconnected",
    "fatal",
    "stopped",
]
WhatsAppOperationStatus = Literal["completed", "failed", "ambiguous"]


class WhatsAppSidecarError(Exception):
    """Base class for redacted sidecar failures safe to map at API boundaries."""


class WhatsAppSidecarUnavailableError(WhatsAppSidecarError):
    pass


class WhatsAppSidecarRejectedError(WhatsAppSidecarError):
    def __init__(self, code: str = "request_rejected") -> None:
        super().__init__(code)
        self.code = code


class WhatsAppSidecarProtocolError(WhatsAppSidecarError):
    pass


@dataclass(frozen=True)
class WhatsAppSidecarConfig:
    account_id: UUID
    base_url: str
    api_token: str = field(repr=False)
    timeout_seconds: float = 10.0
    media_download_max_bytes: int = DEFAULT_MAX_MEDIA_DOWNLOAD_BYTES


@dataclass(frozen=True)
class WhatsAppSidecarHealth:
    status: WhatsAppRuntimeStatus
    connected: bool
    registered: bool
    uptime_seconds: int
    callback_enabled: bool
    pending_callback_events: int
    version_recovery_required: bool


@dataclass(frozen=True)
class WhatsAppSidecarCapabilities:
    operations: frozenset[str]
    pairing: frozenset[str]
    media_download: bool
    callback_delivery: bool
    jid_kinds: frozenset[str]
    raw_provider_access: bool


@dataclass(frozen=True)
class WhatsAppSidecarPairingStatus:
    status: WhatsAppRuntimeStatus
    registered: bool
    method: Literal["qr", "code"] | None = None
    qr: str | None = field(default=None, repr=False)
    code: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class WhatsAppSidecarOperationResult:
    operation_id: str
    status: WhatsAppOperationStatus
    message_id: str | None = None
    error_code: str | None = None

    def metadata(self) -> dict[str, str]:
        result = {
            "transport": "whatsapp_sidecar_v1",
            "operationId": self.operation_id,
            "status": self.status,
        }
        if self.message_id is not None:
            result["messageId"] = self.message_id
        if self.error_code is not None:
            result["error"] = self.error_code
        return result


@dataclass(frozen=True)
class WhatsAppSidecarMedia:
    content: bytes
    content_type: str
    file_name: str | None = None


class WhatsAppSidecarClient:
    def __init__(
        self,
        config: WhatsAppSidecarConfig,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.config = config
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            base_url=config.base_url.rstrip("/"),
            timeout=config.timeout_seconds,
            follow_redirects=False,
            headers={"Authorization": f"Bearer {config.api_token}"},
        )
        self._last_connected: bool | None = None

    @property
    def connected(self) -> bool | None:
        return self._last_connected

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def health(self) -> WhatsAppSidecarHealth:
        payload = await self._json_request("GET", "/v1/health")
        status_value = _runtime_status(payload.get("status"), "invalid health response")
        connected = _required_bool(payload, "connected", "invalid health response")
        account_id = payload.get("accountId")
        if not isinstance(account_id, str) or not _same_uuid(account_id, self.config.account_id):
            raise WhatsAppSidecarProtocolError("sidecar accountId mismatch")
        uptime_seconds = _bounded_int(
            payload.get("uptimeSeconds"),
            minimum=0,
            maximum=9_007_199_254_740_991,
            error="invalid health response",
        )
        registered = _required_bool(payload, "registered", "invalid health response")
        version_recovery_required = _required_bool(
            payload,
            "versionRecoveryRequired",
            "invalid health response",
        )
        callback = _required_mapping(payload.get("callback"), "invalid health response")
        callback_enabled = _required_bool(callback, "enabled", "invalid health response")
        pending_callback_events = _bounded_int(
            callback.get("pendingEvents"),
            minimum=0,
            maximum=1_000_000_000,
            error="invalid health response",
        )
        _validate_advertised_release(payload.get("advertisedRelease"))
        self._last_connected = connected
        return WhatsAppSidecarHealth(
            status=status_value,
            connected=connected,
            registered=registered,
            uptime_seconds=uptime_seconds,
            callback_enabled=callback_enabled,
            pending_callback_events=pending_callback_events,
            version_recovery_required=version_recovery_required,
        )

    async def capabilities(self) -> WhatsAppSidecarCapabilities:
        payload = await self._json_request("GET", "/v1/capabilities")
        if payload.get("schemaVersion") != "clawdi.whatsapp.sidecar-capabilities.v1":
            raise WhatsAppSidecarProtocolError("invalid capabilities response")
        operations = _exact_string_tuple(payload.get("operations"), _OPERATIONS)
        pairing = _exact_string_tuple(payload.get("pairing"), _PAIRING_ACTIONS)
        jid_kinds = _exact_string_tuple(payload.get("jidKinds"), _JID_KINDS)
        media_download = _required_bool(
            payload,
            "mediaDownload",
            "invalid capabilities response",
        )
        callback_delivery = _required_bool(
            payload,
            "callbackDelivery",
            "invalid capabilities response",
        )
        raw_provider_access = _required_bool(
            payload,
            "rawProviderAccess",
            "invalid capabilities response",
        )
        if not media_download or raw_provider_access:
            raise WhatsAppSidecarProtocolError("unsafe capabilities response")
        return WhatsAppSidecarCapabilities(
            operations=frozenset(operations),
            pairing=frozenset(pairing),
            media_download=media_download,
            callback_delivery=callback_delivery,
            jid_kinds=frozenset(jid_kinds),
            raw_provider_access=raw_provider_access,
        )

    async def execute_operation(
        self,
        payload: Mapping[str, object],
        *,
        expected_operation_id: str,
    ) -> WhatsAppSidecarOperationResult:
        response = await self._request(
            "POST",
            "/v1/operations",
            json=payload,
            allowed_error_statuses=frozenset({409, 422, 503}),
        )
        result_payload = _decode_json_mapping(response)
        if response.status_code == 503:
            self._last_connected = False
            raise WhatsAppSidecarUnavailableError("sidecar unavailable")
        if "operationId" not in result_payload or "status" not in result_payload:
            if response.status_code >= 400:
                raise WhatsAppSidecarRejectedError(_safe_error_code_from_payload(result_payload))
            raise WhatsAppSidecarProtocolError("invalid operation response")
        operation_id = result_payload.get("operationId")
        status_value = result_payload.get("status")
        message_id = result_payload.get("messageId")
        raw_error = result_payload.get("error")
        if not isinstance(operation_id, str) or operation_id != expected_operation_id:
            raise WhatsAppSidecarProtocolError("sidecar changed operationId")
        if status_value not in {"completed", "failed", "ambiguous"}:
            raise WhatsAppSidecarProtocolError("invalid operation response")
        if message_id is not None and (
            not isinstance(message_id, str) or not 0 < len(message_id) <= 300
        ):
            raise WhatsAppSidecarProtocolError("invalid operation response")
        error_code = _safe_optional_error_code(raw_error)
        if raw_error is not None and error_code is None:
            error_code = "operation_failed"
        self._last_connected = True
        return WhatsAppSidecarOperationResult(
            operation_id=operation_id,
            status=cast(WhatsAppOperationStatus, status_value),
            message_id=message_id,
            error_code=error_code,
        )

    async def fetch_media(
        self,
        media_id: str,
        *,
        max_bytes: int | None = None,
    ) -> WhatsAppSidecarMedia:
        if _OPAQUE_MEDIA_ID.fullmatch(media_id) is None:
            raise WhatsAppSidecarRejectedError("invalid_media_id")
        download_limit = self.config.media_download_max_bytes if max_bytes is None else max_bytes
        if download_limit <= 0 or download_limit > 100 * 1024 * 1024:
            raise WhatsAppSidecarRejectedError("invalid_media_limit")
        response = await self._request(
            "GET",
            f"/v1/media/{quote(media_id, safe='')}",
            max_bytes=download_limit,
            too_large_code="media_too_large",
        )
        content_type = response.headers.get("content-type", "application/octet-stream")
        if len(content_type) > 255:
            content_type = "application/octet-stream"
        return WhatsAppSidecarMedia(content=response.content, content_type=content_type)

    async def pairing_status(self) -> WhatsAppSidecarPairingStatus:
        return _validated_pairing_status(await self._json_request("GET", "/v1/pairing/status"))

    async def pairing_qr(self) -> WhatsAppSidecarPairingStatus:
        return _validated_pairing_status(await self._json_request("POST", "/v1/pairing/qr"))

    async def pairing_code(self, *, phone_number: str) -> WhatsAppSidecarPairingStatus:
        if _E164_DIGITS.fullmatch(phone_number) is None:
            raise WhatsAppSidecarRejectedError("phone_number_invalid")
        return _validated_pairing_status(
            await self._json_request(
                "POST",
                "/v1/pairing/code",
                json={"phoneNumber": phone_number},
            )
        )

    async def pairing_cancel(self) -> WhatsAppSidecarPairingStatus:
        return _validated_pairing_status(await self._json_request("POST", "/v1/pairing/cancel"))

    async def pairing_logout(self) -> WhatsAppSidecarPairingStatus:
        return _validated_pairing_status(await self._json_request("POST", "/v1/pairing/logout"))

    async def recover(self, *, accept_version_change: bool) -> None:
        payload = await self._json_request(
            "POST",
            "/v1/recover",
            json={"acceptVersionChange": accept_version_change},
        )
        if payload != {"ok": True}:
            raise WhatsAppSidecarProtocolError("invalid recovery response")

    async def _json_request(
        self,
        method: str,
        path: str,
        *,
        json: Mapping[str, object] | None = None,
    ) -> Mapping[str, object]:
        return _decode_json_mapping(await self._request(method, path, json=json))

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Mapping[str, object] | None = None,
        max_bytes: int = DEFAULT_MAX_JSON_BYTES,
        too_large_code: str | None = None,
        allowed_error_statuses: frozenset[int] = frozenset(),
    ) -> httpx.Response:
        try:
            async with self._client.stream(
                method,
                path,
                json=json,
                headers={"Authorization": f"Bearer {self.config.api_token}"},
            ) as response:
                if (
                    response.status_code >= 500
                    and response.status_code not in allowed_error_statuses
                ):
                    self._last_connected = False
                    raise WhatsAppSidecarUnavailableError("sidecar unavailable")
                if (
                    response.status_code >= 400
                    and response.status_code not in allowed_error_statuses
                ):
                    error_response = httpx.Response(
                        response.status_code,
                        headers=response.headers,
                        content=await _read_bounded_content(
                            response,
                            max_bytes=DEFAULT_MAX_JSON_BYTES,
                        ),
                        request=response.request,
                    )
                    raise WhatsAppSidecarRejectedError(_safe_error_code(error_response))
                return httpx.Response(
                    response.status_code,
                    headers=response.headers,
                    content=await _read_bounded_content(
                        response,
                        max_bytes=max_bytes,
                        too_large_code=too_large_code,
                    ),
                    request=response.request,
                )
        except WhatsAppSidecarError:
            raise
        except httpx.HTTPError as exc:
            self._last_connected = False
            raise WhatsAppSidecarUnavailableError("sidecar unavailable") from exc


def _decode_json_mapping(response: httpx.Response) -> Mapping[str, object]:
    try:
        payload = response.json()
    except ValueError as exc:
        raise WhatsAppSidecarProtocolError("invalid sidecar response") from exc
    return _required_mapping(payload, "invalid sidecar response")


def _safe_error_code(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return "request_rejected"
    if not isinstance(payload, Mapping):
        return "request_rejected"
    return _safe_error_code_from_payload(cast(Mapping[str, object], payload))


def _safe_error_code_from_payload(payload: Mapping[str, object]) -> str:
    value = payload.get("code", payload.get("error"))
    if isinstance(value, str) and _SAFE_ERROR_CODE.fullmatch(value):
        return value
    return "request_rejected"


def _safe_optional_error_code(value: object) -> str | None:
    return value if isinstance(value, str) and _SAFE_ERROR_CODE.fullmatch(value) else None


def _content_length(response: httpx.Response) -> int | None:
    value = response.headers.get("content-length")
    if value is None or not value.isdecimal():
        return None
    return int(value)


def _raise_too_large(code: str | None) -> None:
    if code is not None:
        raise WhatsAppSidecarRejectedError(code)
    raise WhatsAppSidecarProtocolError("sidecar response exceeds size limit")


async def _read_bounded_content(
    response: httpx.Response,
    *,
    max_bytes: int,
    too_large_code: str | None = None,
) -> bytes:
    declared_length = _content_length(response)
    if declared_length is not None and declared_length > max_bytes:
        _raise_too_large(too_large_code)
    chunks: list[bytes] = []
    received = 0
    async for chunk in response.aiter_bytes():
        received += len(chunk)
        if received > max_bytes:
            _raise_too_large(too_large_code)
        chunks.append(chunk)
    return b"".join(chunks)


def _validated_pairing_status(payload: Mapping[str, object]) -> WhatsAppSidecarPairingStatus:
    status_value = _runtime_status(payload.get("status"), "invalid pairing response")
    registered = _required_bool(payload, "registered", "invalid pairing response")
    method = payload.get("method")
    if method is not None and method not in {"qr", "code"}:
        raise WhatsAppSidecarProtocolError("invalid pairing response")
    qr = _optional_bounded_string(payload.get("qr"), 65_536, "invalid pairing response")
    code = _optional_bounded_string(payload.get("code"), 200, "invalid pairing response")
    if status_value == "pairing_qr" and (method != "qr" or qr is None):
        raise WhatsAppSidecarProtocolError("invalid pairing response")
    if status_value == "pairing_code" and (method != "code" or code is None):
        raise WhatsAppSidecarProtocolError("invalid pairing response")
    return WhatsAppSidecarPairingStatus(
        status=status_value,
        registered=registered,
        method=cast(Literal["qr", "code"] | None, method),
        qr=qr,
        code=code,
    )


def _runtime_status(value: object, error: str) -> WhatsAppRuntimeStatus:
    if not isinstance(value, str) or value not in _RUNTIME_STATUSES:
        raise WhatsAppSidecarProtocolError(error)
    return cast(WhatsAppRuntimeStatus, value)


def _required_mapping(value: object, error: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping) or not all(isinstance(key, str) for key in value):
        raise WhatsAppSidecarProtocolError(error)
    return cast(Mapping[str, object], value)


def _required_bool(payload: Mapping[str, object], key: str, error: str) -> bool:
    value = payload.get(key)
    if not isinstance(value, bool):
        raise WhatsAppSidecarProtocolError(error)
    return value


def _bounded_int(value: object, *, minimum: int, maximum: int, error: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise WhatsAppSidecarProtocolError(error)
    return value


def _optional_bounded_string(value: object, maximum: int, error: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise WhatsAppSidecarProtocolError(error)
    return value


def _exact_string_tuple(value: object, expected: tuple[str, ...]) -> tuple[str, ...]:
    if not isinstance(value, list) or tuple(value) != expected:
        raise WhatsAppSidecarProtocolError("invalid capabilities response")
    return expected


def _same_uuid(value: str, expected: UUID) -> bool:
    try:
        return UUID(value) == expected
    except ValueError:
        return False


def _validate_advertised_release(value: object) -> None:
    release = _required_mapping(value, "invalid health response")
    if dict(release) != EXPECTED_BAILEYS_RELEASE:
        raise WhatsAppSidecarProtocolError("unexpected sidecar Baileys release")
