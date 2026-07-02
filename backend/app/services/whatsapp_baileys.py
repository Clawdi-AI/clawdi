from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import inspect
import json
import secrets
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import urlencode, urlparse, urlunparse
from uuid import UUID

from cryptography.hazmat.primitives import padding, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, x25519
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    CHANNEL_PROVIDER_WHATSAPP,
    ChannelAccount,
    ChannelAgentCredential,
    ChannelBinding,
    ChannelBindingAlias,
    ChannelWhatsAppAuthCert,
)
from app.services.vault_crypto import decrypt, encrypt

WA_MEDIA_HOST = "mmg.whatsapp.net"
MEDIA_PROXY_PREFIX = "/v1/channels/whatsapp/media"
# Proxy URLs minted before the /v1 migration are persisted inside message
# payloads; keep parsing them.
_LEGACY_MEDIA_PROXY_PREFIX = "/api/channels/whatsapp/media"

BinaryNode = dict[str, Any]
RelayDropReason = Literal[
    "tag-not-allowlisted",
    "no-to-attr",
    "unbound-jid",
    "receipt-id-unknown",
    "receipt-participant-mismatch",
    "receipt-malformed",
    "node-too-deep",
    "node-too-wide",
]

RELAY_TAG_ALLOWLIST = {"presence", "chatstate", "receipt"}
MAX_NODE_DEPTH = 32
MAX_NODE_COUNT = 1024
FORWARDABLE_GET_XMLNS = {"w", "w:profile:picture", "w:biz"}
FORWARDABLE_SET_XMLNS = {"w:m", "w:g2"}
RELAY_MANAGED_MESSAGE_ATTRS = {
    "id",
    "to",
    "from",
    "type",
    "recipient",
    "participant",
}


@dataclass(frozen=True)
class WhatsAppJid:
    user: str
    server: str
    device: int | None = None


@dataclass(frozen=True)
class AgentPreKey:
    id: int
    public_key: bytes


@dataclass(frozen=True)
class AgentSignedPreKey(AgentPreKey):
    signature: bytes


@dataclass(frozen=True)
class AgentBundle:
    registration_id: int
    identity_key: bytes
    signed_pre_key: AgentSignedPreKey
    pre_keys: list[AgentPreKey]


@dataclass(frozen=True)
class SignalSenderKeyPair:
    public_key: bytes
    private_key: bytes


@dataclass(frozen=True)
class EncryptedSignalEnvelope:
    type: Literal["pkmsg", "msg"]
    ciphertext: bytes


SignalSessionSnapshot = dict[str, Any]


@dataclass(frozen=True)
class SignalSenderSnapshot:
    version: int
    identity: SignalSenderKeyPair
    registration_id: int
    signed_pre_key_pair: SignalSenderKeyPair
    pre_key_pair: SignalSenderKeyPair
    signed_pre_key_signature: bytes
    records: dict[str, SignalSessionSnapshot]
    pre_keys: dict[int, SignalSenderKeyPair]
    signed_pre_keys: dict[int, SignalSenderKeyPair]


@dataclass(frozen=True)
class MintedWhatsAppCreds:
    creds: dict[str, Any]
    identity_pub_key: bytes
    jid: str


@dataclass(frozen=True)
class WhatsAppAuthCert:
    serial: int
    issuer: str
    root_public_key: bytes
    root_private_key: bytes
    intermediate_public_key: bytes
    intermediate_private_key: bytes


@dataclass(frozen=True)
class StoredWhatsAppCredential:
    credential: ChannelAgentCredential
    minted: MintedWhatsAppCreds


@dataclass(frozen=True)
class RelayDecision:
    action: Literal["relay", "drop"]
    node: BinaryNode | None = None
    reason: RelayDropReason | None = None


@dataclass(frozen=True)
class WhatsAppInboxPumpEvent:
    sequence: int
    external_chat_id: str
    payload: dict[str, Any]
    provider_message_id: str | None = None
    text: str | None = None


@dataclass(frozen=True)
class WhatsAppPreparedInboundDelivery:
    sequence: int
    message_id: str
    from_jid: str
    payload: dict[str, Any]
    text: str | None
    participant_jid: str | None = None
    sender_lid_jid: str | None = None
    sender_pn_jid: str | None = None
    participant_lid_jid: str | None = None
    participant_pn_jid: str | None = None
    push_name: str | None = None
    timestamp: int | None = None


@dataclass(frozen=True)
class WhatsAppSyntheticDeliveryResult:
    message_id: str
    signal_jid: str
    enc_type: Literal["pkmsg", "msg", "skmsg"]
    attrs: dict[str, str]


@dataclass(frozen=True)
class WhatsAppCloudOutboundPayload:
    outcome: Literal["sendable", "native_required", "unsupported"]
    kind: str
    text: str | None = None
    provider_payload: dict[str, Any] | None = None
    reason: str | None = None


@dataclass(frozen=True)
class WhatsAppMediaReuploadCandidate:
    kind: Literal["image", "audio"]
    source_url: str
    mimetype: str
    media_key: bytes
    file_sha256: bytes | None = None
    file_enc_sha256: bytes | None = None
    text: str | None = None


@dataclass(frozen=True)
class WhatsAppInboxPumpResult:
    delivered: int
    acked_through: int | None
    errors: int


@dataclass(frozen=True)
class WhatsAppGroupParticipantAddress:
    jid: str
    lid_jid: str | None = None
    pn_jid: str | None = None


SenderKeyRecordSnapshot = dict[str, Any]


class WhatsAppGroupSenderKeyStore:
    def load(self, sender_key_name: str) -> SenderKeyRecordSnapshot | None:
        raise NotImplementedError

    def save(self, sender_key_name: str, snapshot: SenderKeyRecordSnapshot) -> None:
        raise NotImplementedError


@dataclass(frozen=True)
class WhatsAppBindingLookup:
    binding: ChannelBinding | None
    conflict: bool = False


def relay_outbound_extra_attrs(stanza_attrs: Mapping[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in stanza_attrs.items():
        if key in RELAY_MANAGED_MESSAGE_ATTRS:
            continue
        if isinstance(value, str):
            out[key] = value
    return out


class WhatsAppInboxPump:
    def __init__(
        self,
        *,
        tenant_id: str,
        wait_for_events: Callable[[str, int, int], Awaitable[list[WhatsAppInboxPumpEvent]]],
        ack: Callable[[str, int], Awaitable[None]],
        deliver: Callable[
            [WhatsAppPreparedInboundDelivery],
            Awaitable[WhatsAppSyntheticDeliveryResult],
        ],
        debug_events: Any | None = None,
        on_error: Callable[[Exception], Any] | None = None,
        retry_delay_seconds: float = 0.25,
        retry_max_delay_seconds: float = 5.0,
    ) -> None:
        self.tenant_id = tenant_id
        self._wait_for_events = wait_for_events
        self._ack = ack
        self._deliver = deliver
        self._debug_events = debug_events
        self._on_error = on_error
        self._retry_delay_seconds = max(0.0, retry_delay_seconds)
        self._retry_max_delay_seconds = max(self._retry_delay_seconds, retry_max_delay_seconds)

    async def run_once(
        self,
        *,
        after_sequence: int = 0,
        limit: int = 100,
    ) -> WhatsAppInboxPumpResult:
        events = await self._wait_for_events(self.tenant_id, after_sequence, limit)
        delivered = 0
        errors = 0
        acked_through: int | None = None
        for event in events:
            try:
                prepared = prepare_whatsapp_inbound_delivery(event)
                await self._record_debug(
                    stage="inbox_delivery_prepare",
                    outcome="resolved",
                    event=event,
                    details={
                        "messageId": prepared.message_id,
                        "pushJid": prepared.from_jid,
                        "message": _whatsapp_inbox_message_debug(prepared.payload, prepared.text),
                    },
                )
                result = await self._deliver(prepared)
                await self._record_debug(
                    stage="inbox_delivery_push",
                    outcome="delivered",
                    event=event,
                    details={
                        "messageId": result.message_id,
                        "signalJid": result.signal_jid,
                        "encType": result.enc_type,
                        "stanzaAttrs": result.attrs,
                    },
                )
                delivered += 1
                acked_through = event.sequence
            except ValueError as exc:
                errors += 1
                acked_through = event.sequence
                await self._record_error(exc, event=event, stage="inbox_delivery_prepare")
            except Exception as exc:  # noqa: BLE001 - delivery failures must leave rows unacked.
                errors += 1
                await self._record_error(exc, event=event, stage="inbox_delivery_push")
                break
        if acked_through is not None:
            await self._ack(self.tenant_id, acked_through)
        return WhatsAppInboxPumpResult(
            delivered=delivered,
            acked_through=acked_through,
            errors=errors,
        )

    async def run(
        self,
        *,
        after_sequence: int = 0,
        limit: int = 100,
        max_iterations: int | None = None,
        stop_when_idle: bool = True,
    ) -> None:
        failures = 0
        iterations = 0
        cursor = after_sequence
        while max_iterations is None or iterations < max_iterations:
            iterations += 1
            result = await self.run_once(after_sequence=cursor, limit=limit)
            if result.acked_through is not None:
                cursor = result.acked_through
            if result.errors == 0:
                failures = 0
                if result.delivered == 0 and stop_when_idle:
                    return
                continue
            failures += 1
            delay = min(
                self._retry_delay_seconds * (2 ** max(0, failures - 1)),
                self._retry_max_delay_seconds,
            )
            if delay > 0:
                await asyncio.sleep(delay)

    async def _record_error(
        self,
        exc: Exception,
        *,
        event: WhatsAppInboxPumpEvent,
        stage: str,
    ) -> None:
        if self._on_error is not None:
            maybe_result = self._on_error(exc)
            if inspect.isawaitable(maybe_result):
                await maybe_result
        await self._record_debug(
            stage=stage,
            outcome="error",
            event=event,
            details={"error": exc.__class__.__name__},
        )

    async def _record_debug(
        self,
        *,
        stage: str,
        outcome: str,
        event: WhatsAppInboxPumpEvent,
        details: dict[str, Any],
    ) -> None:
        if self._debug_events is None:
            return
        payload = {
            "channel": "whatsapp",
            "tenantId": self.tenant_id,
            "chatId": event.external_chat_id,
            "direction": "agent",
            "stage": stage,
            "outcome": outcome,
            "details": {"seqNo": event.sequence, **details},
        }
        record = getattr(self._debug_events, "record", None)
        if not callable(record):
            return
        maybe_result = record(payload)
        if inspect.isawaitable(maybe_result):
            await maybe_result


def prepare_whatsapp_inbound_delivery(
    event: WhatsAppInboxPumpEvent,
) -> WhatsAppPreparedInboundDelivery:
    if event.sequence <= 0:
        raise ValueError("whatsapp inbox event sequence must be positive")
    payload = event.payload
    if not isinstance(payload, dict):
        raise ValueError("whatsapp inbox event payload must be an object")
    from_jid = _optional_payload_str(payload.get("fromJid")) or event.external_chat_id
    participant_jid: str | None = None
    key = payload.get("key")
    if isinstance(key, dict):
        from_jid = _optional_payload_str(key.get("remoteJid")) or from_jid
        participant_jid = _optional_payload_str(key.get("participant"))
    if not from_jid:
        raise ValueError("whatsapp inbox event missing source jid")
    message_id = event.provider_message_id or _optional_payload_str(payload.get("id"))
    if message_id is None and isinstance(key, dict):
        message_id = _optional_payload_str(key.get("id"))
    if not message_id:
        raise ValueError("whatsapp inbox event missing message id")
    sender_lid_jid = _optional_payload_str(payload.get("senderLidJid"))
    sender_pn_jid = _optional_payload_str(payload.get("senderPnJid"))
    participant_lid_jid = _optional_payload_str(payload.get("participantLidJid"))
    participant_pn_jid = (
        _optional_payload_str(payload.get("participantPnJid"))
        or _optional_payload_str(payload.get("participantPn"))
        or _optional_payload_str(payload.get("participantAltJid"))
    )
    push_name = (
        _optional_payload_str(payload.get("pushName"))
        or _optional_payload_str(payload.get("notify"))
        or _optional_payload_str(payload.get("notifyName"))
    )
    timestamp = (
        _optional_payload_int(payload.get("messageTimestamp"))
        or _optional_payload_int(payload.get("timestamp"))
        or _optional_payload_int(payload.get("t"))
    )
    signal_jid = participant_jid or from_jid
    if signal_jid.endswith("@lid"):
        if participant_jid is not None:
            participant_lid_jid = participant_lid_jid or signal_jid
            participant_pn_jid = participant_pn_jid or _optional_payload_str(payload.get("altJid"))
        else:
            sender_lid_jid = sender_lid_jid or signal_jid
            sender_pn_jid = (
                sender_pn_jid
                or _optional_payload_str(payload.get("participantPn"))
                or _optional_payload_str(payload.get("altJid"))
            )
    return WhatsAppPreparedInboundDelivery(
        sequence=event.sequence,
        message_id=message_id,
        from_jid=from_jid,
        payload=payload,
        text=event.text,
        participant_jid=participant_jid,
        sender_lid_jid=sender_lid_jid,
        sender_pn_jid=sender_pn_jid,
        participant_lid_jid=participant_lid_jid,
        participant_pn_jid=participant_pn_jid,
        push_name=push_name,
        timestamp=timestamp,
    )


def whatsapp_message_proto_bytes(payload: dict[str, Any], text: str | None) -> bytes:
    message = payload.get("message")
    message_dict = message if isinstance(message, dict) else {}
    encoded_message = _whatsapp_message_from_payload(message_dict)
    if encoded_message is not None:
        return encoded_message
    if text is not None:
        return _proto_bytes_field(1, text.encode("utf-8"))
    if message_dict:
        return json.dumps(message_dict, sort_keys=True, separators=(",", ":"), default=str).encode(
            "utf-8"
        )
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")


def whatsapp_cloud_outbound_payload_from_proto(
    message_proto: bytes,
    *,
    conversation: str | None = None,
) -> WhatsAppCloudOutboundPayload:
    if conversation is not None:
        return _whatsapp_text_cloud_payload(
            conversation,
            kind="conversation",
            context_message_id=None,
        )

    try:
        fields = _decode_protobuf_fields(message_proto)
    except ValueError:
        return WhatsAppCloudOutboundPayload(
            outcome="unsupported",
            kind="unknown",
            reason="proto-decode-failed",
        )

    conversation_text = _optional_proto_string(fields, 1)
    if conversation_text is not None:
        return _whatsapp_text_cloud_payload(
            conversation_text,
            kind="conversation",
            context_message_id=None,
        )

    extended_text = fields.get(6)
    if isinstance(extended_text, bytes):
        return _extended_text_cloud_payload(extended_text)

    image = fields.get(3)
    if isinstance(image, bytes):
        return _image_cloud_payload(image)

    audio = fields.get(8)
    if isinstance(audio, bytes):
        return _audio_cloud_payload(audio)

    return WhatsAppCloudOutboundPayload(
        outcome="native_required",
        kind="unknown",
        reason="baileys-native-proto-required",
    )


def whatsapp_media_reupload_candidate_from_proto(
    message_proto: bytes,
) -> WhatsAppMediaReuploadCandidate | None:
    try:
        fields = _decode_protobuf_fields(message_proto)
    except ValueError:
        return None

    image = fields.get(3)
    if isinstance(image, bytes):
        return _image_media_reupload_candidate(image)

    audio = fields.get(8)
    if isinstance(audio, bytes):
        return _audio_media_reupload_candidate(audio)

    return None


def _extended_text_cloud_payload(data: bytes) -> WhatsAppCloudOutboundPayload:
    try:
        fields = _decode_protobuf_fields(data)
    except ValueError:
        return WhatsAppCloudOutboundPayload(
            outcome="unsupported",
            kind="extended_text",
            reason="proto-decode-failed",
        )
    text = _optional_proto_string(fields, 1)
    if text is None:
        return WhatsAppCloudOutboundPayload(
            outcome="unsupported",
            kind="extended_text",
            reason="text-missing",
        )
    context_message_id: str | None = None
    context_info = fields.get(17)
    if isinstance(context_info, bytes):
        try:
            context_fields = _decode_protobuf_fields(context_info)
        except ValueError:
            context_fields = {}
        context_message_id = _optional_proto_string(context_fields, 1)
    return _whatsapp_text_cloud_payload(
        text,
        kind="extended_text",
        context_message_id=context_message_id,
    )


def _image_cloud_payload(data: bytes) -> WhatsAppCloudOutboundPayload:
    try:
        fields = _decode_protobuf_fields(data)
    except ValueError:
        return WhatsAppCloudOutboundPayload(
            outcome="unsupported",
            kind="image",
            reason="proto-decode-failed",
        )
    url = _optional_proto_string(fields, 1)
    caption = _optional_proto_string(fields, 3)
    media_key = fields.get(8)
    direct_path = _optional_proto_string(fields, 11)
    if media_key is not None or direct_path is not None:
        return WhatsAppCloudOutboundPayload(
            outcome="native_required",
            kind="image",
            text=caption,
            reason="media-reupload-required",
        )
    if url is None:
        return WhatsAppCloudOutboundPayload(
            outcome="unsupported",
            kind="image",
            text=caption,
            reason="image-media-reference-missing",
        )
    payload: dict[str, Any] = {
        "type": "image",
        "image": {"link": url},
    }
    if caption:
        payload["image"]["caption"] = caption
    return WhatsAppCloudOutboundPayload(
        outcome="sendable",
        kind="image",
        text=caption,
        provider_payload=payload,
    )


def _audio_cloud_payload(data: bytes) -> WhatsAppCloudOutboundPayload:
    try:
        fields = _decode_protobuf_fields(data)
    except ValueError:
        return WhatsAppCloudOutboundPayload(
            outcome="unsupported",
            kind="audio",
            reason="proto-decode-failed",
        )
    url = _optional_proto_string(fields, 1)
    ptt = fields.get(6)
    media_key = fields.get(7)
    direct_path = _optional_proto_string(fields, 9)
    if ptt:
        return WhatsAppCloudOutboundPayload(
            outcome="native_required",
            kind="audio",
            reason="audio-ptt-native-required",
        )
    if media_key is not None or direct_path is not None:
        return WhatsAppCloudOutboundPayload(
            outcome="native_required",
            kind="audio",
            reason="media-reupload-required",
        )
    if url is None:
        return WhatsAppCloudOutboundPayload(
            outcome="unsupported",
            kind="audio",
            reason="audio-media-reference-missing",
        )
    return WhatsAppCloudOutboundPayload(
        outcome="sendable",
        kind="audio",
        provider_payload={
            "type": "audio",
            "audio": {"link": url},
        },
    )


def _image_media_reupload_candidate(data: bytes) -> WhatsAppMediaReuploadCandidate | None:
    try:
        fields = _decode_protobuf_fields(data)
    except ValueError:
        return None
    media_key = fields.get(8)
    if not isinstance(media_key, bytes):
        return None
    source_url = _media_reupload_source_url(
        _optional_proto_string(fields, 1),
        _optional_proto_string(fields, 11),
    )
    if source_url is None:
        return None
    return WhatsAppMediaReuploadCandidate(
        kind="image",
        source_url=source_url,
        mimetype=_optional_proto_string(fields, 2) or "image/jpeg",
        media_key=media_key,
        file_sha256=_optional_proto_bytes(fields, 4),
        file_enc_sha256=_optional_proto_bytes(fields, 9),
        text=_optional_proto_string(fields, 3),
    )


def _audio_media_reupload_candidate(data: bytes) -> WhatsAppMediaReuploadCandidate | None:
    try:
        fields = _decode_protobuf_fields(data)
    except ValueError:
        return None
    if fields.get(6):
        return None
    media_key = fields.get(7)
    if not isinstance(media_key, bytes):
        return None
    source_url = _media_reupload_source_url(
        _optional_proto_string(fields, 1),
        _optional_proto_string(fields, 9),
    )
    if source_url is None:
        return None
    return WhatsAppMediaReuploadCandidate(
        kind="audio",
        source_url=source_url,
        mimetype=_optional_proto_string(fields, 2) or "audio/ogg",
        media_key=media_key,
        file_sha256=_optional_proto_bytes(fields, 3),
        file_enc_sha256=_optional_proto_bytes(fields, 8),
        text=None,
    )


def _media_reupload_source_url(url: str | None, direct_path: str | None) -> str | None:
    if url:
        return url
    if direct_path is None:
        return None
    path = direct_path if direct_path.startswith("/") else f"/{direct_path}"
    return f"https://{WA_MEDIA_HOST}{path}"


def _whatsapp_text_cloud_payload(
    text: str,
    *,
    kind: str,
    context_message_id: str | None,
) -> WhatsAppCloudOutboundPayload:
    payload: dict[str, Any] = {
        "type": "text",
        "text": {"body": text},
    }
    if context_message_id is not None:
        payload["context"] = {"message_id": context_message_id}
    return WhatsAppCloudOutboundPayload(
        outcome="sendable",
        kind=kind,
        text=text,
        provider_payload=payload,
    )


def _whatsapp_message_from_payload(message: dict[str, Any]) -> bytes | None:
    parts: list[bytes] = []

    conversation = _optional_payload_str(message.get("conversation"))
    if conversation is not None:
        parts.append(_proto_bytes_field(1, conversation.encode("utf-8")))

    sender_key_distribution = message.get("senderKeyDistributionMessage")
    if isinstance(sender_key_distribution, dict):
        encoded = _sender_key_distribution_message_proto(sender_key_distribution)
        if encoded:
            parts.append(_proto_message_field(2, encoded))

    image = message.get("imageMessage")
    if isinstance(image, dict):
        encoded = _image_message_proto(image)
        if encoded:
            parts.append(_proto_message_field(3, encoded))

    audio = message.get("audioMessage")
    if isinstance(audio, dict):
        encoded = _audio_message_proto(audio)
        if encoded:
            parts.append(_proto_message_field(8, encoded))

    extended = message.get("extendedTextMessage")
    if isinstance(extended, dict):
        encoded = _extended_text_message_proto(extended)
        if encoded:
            parts.append(_proto_message_field(6, encoded))

    message_context = message.get("messageContextInfo")
    if isinstance(message_context, dict):
        encoded = _message_context_info_proto(message_context)
        if encoded:
            parts.append(_proto_message_field(35, encoded))

    if not parts:
        return None
    return b"".join(parts)


def _sender_key_distribution_message_proto(message: dict[str, Any]) -> bytes:
    parts: list[bytes] = []
    group_id = _optional_payload_str(message.get("groupId"))
    if group_id is not None:
        parts.append(_proto_bytes_field(1, group_id.encode("utf-8")))
    axolotl = _optional_payload_bytes(message.get("axolotlSenderKeyDistributionMessage"))
    if axolotl is not None:
        parts.append(_proto_bytes_field(2, axolotl))
    return b"".join(parts)


def _extended_text_message_proto(message: dict[str, Any]) -> bytes:
    parts: list[bytes] = []
    text = _optional_payload_str(message.get("text"))
    if text is not None:
        parts.append(_proto_bytes_field(1, text.encode("utf-8")))
    matched_text = _optional_payload_str(message.get("matchedText"))
    if matched_text is not None:
        parts.append(_proto_bytes_field(2, matched_text.encode("utf-8")))
    description = _optional_payload_str(message.get("description"))
    if description is not None:
        parts.append(_proto_bytes_field(5, description.encode("utf-8")))
    title = _optional_payload_str(message.get("title"))
    if title is not None:
        parts.append(_proto_bytes_field(6, title.encode("utf-8")))
    preview_type = _optional_payload_int(message.get("previewType"))
    if preview_type is not None:
        parts.append(_proto_varint_field(10, preview_type))
    jpeg_thumbnail = _optional_payload_bytes(message.get("jpegThumbnail"))
    if jpeg_thumbnail is not None:
        parts.append(_proto_bytes_field(16, jpeg_thumbnail))
    context_info = message.get("contextInfo")
    if isinstance(context_info, dict):
        encoded = _context_info_proto(context_info)
        if encoded:
            parts.append(_proto_message_field(17, encoded))
    do_not_play_inline = _optional_payload_bool(message.get("doNotPlayInline"))
    if do_not_play_inline is not None:
        parts.append(_proto_varint_field(18, int(do_not_play_inline)))
    return b"".join(parts)


def _context_info_proto(message: dict[str, Any]) -> bytes:
    parts: list[bytes] = []
    stanza_id = _optional_payload_str(message.get("stanzaId"))
    if stanza_id is not None:
        parts.append(_proto_bytes_field(1, stanza_id.encode("utf-8")))
    participant = _optional_payload_str(message.get("participant"))
    if participant is not None:
        parts.append(_proto_bytes_field(2, participant.encode("utf-8")))
    quoted = message.get("quotedMessage")
    if isinstance(quoted, dict):
        encoded = _whatsapp_message_from_payload(quoted)
        if encoded:
            parts.append(_proto_message_field(3, encoded))
    remote_jid = _optional_payload_str(message.get("remoteJid"))
    if remote_jid is not None:
        parts.append(_proto_bytes_field(4, remote_jid.encode("utf-8")))
    mentioned = message.get("mentionedJid")
    if isinstance(mentioned, list):
        for jid in mentioned:
            mentioned_jid = _optional_payload_str(jid)
            if mentioned_jid is not None:
                parts.append(_proto_bytes_field(15, mentioned_jid.encode("utf-8")))
    forwarding_score = _optional_payload_int(message.get("forwardingScore"))
    if forwarding_score is not None:
        parts.append(_proto_varint_field(21, forwarding_score))
    is_forwarded = _optional_payload_bool(message.get("isForwarded"))
    if is_forwarded is not None:
        parts.append(_proto_varint_field(22, int(is_forwarded)))
    expiration = _optional_payload_int(message.get("expiration"))
    if expiration is not None:
        parts.append(_proto_varint_field(25, expiration))
    ephemeral_setting_timestamp = _optional_payload_int(message.get("ephemeralSettingTimestamp"))
    if ephemeral_setting_timestamp is not None:
        parts.append(_proto_varint_field(26, ephemeral_setting_timestamp))
    ephemeral_shared_secret = _optional_payload_bytes(message.get("ephemeralSharedSecret"))
    if ephemeral_shared_secret is not None:
        parts.append(_proto_bytes_field(27, ephemeral_shared_secret))
    return b"".join(parts)


def _image_message_proto(message: dict[str, Any]) -> bytes:
    parts: list[bytes] = []
    for field_number, key in ((1, "url"), (2, "mimetype"), (3, "caption")):
        value = _optional_payload_str(message.get(key))
        if value is not None:
            parts.append(_proto_bytes_field(field_number, value.encode("utf-8")))
    file_sha256 = _optional_payload_bytes(message.get("fileSha256"))
    if file_sha256 is not None:
        parts.append(_proto_bytes_field(4, file_sha256))
    for field_number, key in ((5, "fileLength"), (6, "height"), (7, "width")):
        value = _optional_payload_int(message.get(key))
        if value is not None:
            parts.append(_proto_varint_field(field_number, value))
    media_key = _optional_payload_bytes(message.get("mediaKey"))
    if media_key is not None:
        parts.append(_proto_bytes_field(8, media_key))
    file_enc_sha256 = _optional_payload_bytes(message.get("fileEncSha256"))
    if file_enc_sha256 is not None:
        parts.append(_proto_bytes_field(9, file_enc_sha256))
    direct_path = _optional_payload_str(message.get("directPath"))
    if direct_path is not None:
        parts.append(_proto_bytes_field(11, direct_path.encode("utf-8")))
    media_key_timestamp = _optional_payload_int(message.get("mediaKeyTimestamp"))
    if media_key_timestamp is not None:
        parts.append(_proto_varint_field(12, media_key_timestamp))
    jpeg_thumbnail = _optional_payload_bytes(message.get("jpegThumbnail"))
    if jpeg_thumbnail is not None:
        parts.append(_proto_bytes_field(16, jpeg_thumbnail))
    context_info = message.get("contextInfo")
    if isinstance(context_info, dict):
        encoded = _context_info_proto(context_info)
        if encoded:
            parts.append(_proto_message_field(17, encoded))
    view_once = _optional_payload_bool(message.get("viewOnce"))
    if view_once is not None:
        parts.append(_proto_varint_field(25, int(view_once)))
    return b"".join(parts)


def _audio_message_proto(message: dict[str, Any]) -> bytes:
    parts: list[bytes] = []
    for field_number, key in ((1, "url"), (2, "mimetype")):
        value = _optional_payload_str(message.get(key))
        if value is not None:
            parts.append(_proto_bytes_field(field_number, value.encode("utf-8")))
    file_sha256 = _optional_payload_bytes(message.get("fileSha256"))
    if file_sha256 is not None:
        parts.append(_proto_bytes_field(3, file_sha256))
    for field_number, key in ((4, "fileLength"), (5, "seconds")):
        value = _optional_payload_int(message.get(key))
        if value is not None:
            parts.append(_proto_varint_field(field_number, value))
    ptt = _optional_payload_bool(message.get("ptt"))
    if ptt is not None:
        parts.append(_proto_varint_field(6, int(ptt)))
    media_key = _optional_payload_bytes(message.get("mediaKey"))
    if media_key is not None:
        parts.append(_proto_bytes_field(7, media_key))
    file_enc_sha256 = _optional_payload_bytes(message.get("fileEncSha256"))
    if file_enc_sha256 is not None:
        parts.append(_proto_bytes_field(8, file_enc_sha256))
    direct_path = _optional_payload_str(message.get("directPath"))
    if direct_path is not None:
        parts.append(_proto_bytes_field(9, direct_path.encode("utf-8")))
    media_key_timestamp = _optional_payload_int(message.get("mediaKeyTimestamp"))
    if media_key_timestamp is not None:
        parts.append(_proto_varint_field(10, media_key_timestamp))
    context_info = message.get("contextInfo")
    if isinstance(context_info, dict):
        encoded = _context_info_proto(context_info)
        if encoded:
            parts.append(_proto_message_field(17, encoded))
    streaming_sidecar = _optional_payload_bytes(message.get("streamingSidecar"))
    if streaming_sidecar is not None:
        parts.append(_proto_bytes_field(18, streaming_sidecar))
    waveform = _optional_payload_bytes(message.get("waveform"))
    if waveform is not None:
        parts.append(_proto_bytes_field(19, waveform))
    view_once = _optional_payload_bool(message.get("viewOnce"))
    if view_once is not None:
        parts.append(_proto_varint_field(21, int(view_once)))
    accessibility_label = _optional_payload_str(message.get("accessibilityLabel"))
    if accessibility_label is not None:
        parts.append(_proto_bytes_field(22, accessibility_label.encode("utf-8")))
    media_key_domain = _optional_payload_int(message.get("mediaKeyDomain"))
    if media_key_domain is not None:
        parts.append(_proto_varint_field(23, media_key_domain))
    return b"".join(parts)


def _message_context_info_proto(message: dict[str, Any]) -> bytes:
    parts: list[bytes] = []
    message_secret = _optional_payload_bytes(message.get("messageSecret"))
    if message_secret is not None:
        parts.append(_proto_bytes_field(3, message_secret))
    padding_bytes = _optional_payload_bytes(message.get("paddingBytes"))
    if padding_bytes is not None:
        parts.append(_proto_bytes_field(4, padding_bytes))
    message_addon_duration = _optional_payload_int(message.get("messageAddOnDurationInSecs"))
    if message_addon_duration is not None:
        parts.append(_proto_varint_field(5, message_addon_duration))
    bot_message_secret = _optional_payload_bytes(message.get("botMessageSecret"))
    if bot_message_secret is not None:
        parts.append(_proto_bytes_field(6, bot_message_secret))
    reporting_token_version = _optional_payload_int(message.get("reportingTokenVersion"))
    if reporting_token_version is not None:
        parts.append(_proto_varint_field(8, reporting_token_version))
    return b"".join(parts)


def _optional_payload_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    if isinstance(value, int):
        return str(value)
    return None


def _optional_payload_bytes(value: Any) -> bytes | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, str):
        stripped = value.strip()
        for candidate in (
            stripped,
            stripped.rstrip("=") + ("=" * (-len(stripped.rstrip("=")) % 4)),
        ):
            try:
                return base64.b64decode(candidate, validate=True)
            except ValueError:
                continue
        return None
    if isinstance(value, list) and all(isinstance(item, int) for item in value):
        if all(0 <= item <= 255 for item in value):
            return bytes(value)
        return None
    if isinstance(value, dict) and value.get("type") == "Buffer":
        data = value.get("data")
        if isinstance(data, list) and all(isinstance(item, int) for item in data):
            if all(0 <= item <= 255 for item in data):
                return bytes(data)
    return None


def _optional_payload_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    return None


def _optional_payload_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.isdigit():
            parsed = int(stripped)
            return parsed if parsed > 0 else None
    return None


def _proto_varint_field(field_number: int, value: int) -> bytes:
    return _proto_key(field_number, 0) + _proto_varint(value)


def _whatsapp_inbox_message_debug(payload: dict[str, Any], text: str | None) -> dict[str, Any]:
    message = payload.get("message")
    message_dict = message if isinstance(message, dict) else {}
    proto_bytes = len(whatsapp_message_proto_bytes(payload, text))
    debug: dict[str, Any] = {
        "topLevelKinds": sorted(key for key, value in message_dict.items() if value is not None),
        "protoBytes": proto_bytes,
    }
    if text is not None:
        debug["textLength"] = len(text)
        debug["textSha256"] = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return debug


def _proto_message_field(field_number: int, payload: bytes) -> bytes:
    return _proto_key(field_number, 2) + _proto_varint(len(payload)) + payload


def _proto_bytes_field(field_number: int, payload: bytes) -> bytes:
    return _proto_message_field(field_number, payload)


def _proto_key(field_number: int, wire_type: int) -> bytes:
    return _proto_varint((field_number << 3) | wire_type)


def _proto_varint(value: int) -> bytes:
    out = bytearray()
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


async def forward_iq_over(
    query: Callable[[BinaryNode, int], BinaryNode | Awaitable[BinaryNode | None] | None],
    node: BinaryNode,
    *,
    timeout_ms: int = 15_000,
) -> BinaryNode | None:
    attrs = dict(_attrs(node))
    original_id = attrs.pop("id", None)
    upstream_node = {**node, "attrs": attrs}
    try:
        response = query(upstream_node, timeout_ms)
        if inspect.isawaitable(response):
            response = await response
    except Exception:  # noqa: BLE001 - shared runtime falls back to emulator ack on upstream failure.
        return None
    if not isinstance(response, dict):
        return None
    response_attrs = dict(_attrs(response))
    if original_id:
        response_attrs["id"] = original_id
    return {**response, "attrs": response_attrs}


def parse_whatsapp_jid(jid: str | None) -> WhatsAppJid | None:
    if not jid or "@" not in jid:
        return None
    user_part, server = jid.rsplit("@", 1)
    if not user_part or not server:
        return None
    device: int | None = None
    user = user_part
    if ":" in user_part:
        user, raw_device = user_part.split(":", 1)
        if not user:
            return None
        try:
            device = int(raw_device)
        except ValueError:
            return None
    return WhatsAppJid(user=user, server=server, device=device)


def strip_whatsapp_device(jid: str) -> str:
    parsed = parse_whatsapp_jid(jid)
    if parsed is None:
        return jid
    return f"{parsed.user}@{parsed.server}"


def whatsapp_jid_candidates(jid: str) -> list[str]:
    out = [jid]
    parsed = parse_whatsapp_jid(jid)
    if parsed is None:
        return out
    bare = f"{parsed.user}@{parsed.server}"
    if bare != jid:
        out.append(bare)
    if parsed.server == "lid":
        out.append(f"{parsed.user}@s.whatsapp.net")
    return list(dict.fromkeys(out))


def choose_whatsapp_route_jid(remote_jid: str, alt_jid: str | None) -> str:
    if remote_jid.endswith("@lid") and alt_jid and alt_jid.endswith("@s.whatsapp.net"):
        return alt_jid
    return remote_jid


def describe_whatsapp_jid_for_log(jid: str | None) -> str:
    parsed = parse_whatsapp_jid(jid)
    if jid is None:
        return "missing"
    if parsed is None:
        return "invalid"
    return f"server={parsed.server} device={parsed.device is not None}".lower()


def buffer_json(data: bytes) -> dict[str, str]:
    return {
        "type": "Buffer",
        "data": base64.b64encode(data).decode("ascii"),
    }


def encode_buffer_json(value: Any) -> Any:
    if isinstance(value, bytes):
        return buffer_json(value)
    if isinstance(value, bytearray):
        return buffer_json(bytes(value))
    if isinstance(value, list):
        return [encode_buffer_json(item) for item in value]
    if isinstance(value, dict):
        return {key: encode_buffer_json(item) for key, item in value.items()}
    return value


def decode_buffer_json(value: Any) -> Any:
    if isinstance(value, dict):
        if value.get("type") == "Buffer" and isinstance(value.get("data"), str):
            return base64.b64decode(value["data"])
        return {key: decode_buffer_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [decode_buffer_json(item) for item in value]
    return value


def serialize_creds(creds: dict[str, Any]) -> str:
    return json.dumps(encode_buffer_json(creds), separators=(",", ":"), sort_keys=True)


def deserialize_creds(serialized: str) -> dict[str, Any]:
    parsed = json.loads(serialized)
    return decode_buffer_json(parsed)


def serialize_agent_bundle(bundle: AgentBundle) -> dict[str, Any]:
    return {
        "registrationId": bundle.registration_id,
        "identity": buffer_json(bundle.identity_key),
        "signedPreKey": {
            "id": bundle.signed_pre_key.id,
            "public": buffer_json(bundle.signed_pre_key.public_key),
            "signature": buffer_json(bundle.signed_pre_key.signature),
        },
        "preKeys": [
            {
                "id": pre_key.id,
                "public": buffer_json(pre_key.public_key),
            }
            for pre_key in bundle.pre_keys
        ],
    }


def deserialize_agent_bundle(value: Any) -> AgentBundle:
    decoded = decode_buffer_json(value)
    if not isinstance(decoded, dict):
        raise ValueError("agent-bundle: stored bundle must be an object")
    signed = decoded.get("signedPreKey")
    pre_keys = decoded.get("preKeys")
    if not isinstance(signed, dict):
        raise ValueError("agent-bundle: stored signedPreKey missing")
    if not isinstance(pre_keys, list):
        raise ValueError("agent-bundle: stored preKeys missing")
    registration_id = decoded.get("registrationId")
    identity = decoded.get("identity")
    signed_public = signed.get("public")
    signed_signature = signed.get("signature")
    if not isinstance(registration_id, int):
        raise ValueError("agent-bundle: stored registrationId invalid")
    if not isinstance(identity, bytes):
        raise ValueError("agent-bundle: stored identity invalid")
    if not isinstance(signed.get("id"), int):
        raise ValueError("agent-bundle: stored signedPreKey id invalid")
    if not isinstance(signed_public, bytes):
        raise ValueError("agent-bundle: stored signedPreKey public invalid")
    if not isinstance(signed_signature, bytes):
        raise ValueError("agent-bundle: stored signedPreKey signature invalid")
    parsed_pre_keys: list[AgentPreKey] = []
    for item in pre_keys:
        if not isinstance(item, dict):
            raise ValueError("agent-bundle: stored preKey invalid")
        pre_key_id = item.get("id")
        pre_key_public = item.get("public")
        if not isinstance(pre_key_id, int) or not isinstance(pre_key_public, bytes):
            raise ValueError("agent-bundle: stored preKey fields invalid")
        parsed_pre_keys.append(AgentPreKey(id=pre_key_id, public_key=pre_key_public))
    return AgentBundle(
        registration_id=registration_id,
        identity_key=identity,
        signed_pre_key=AgentSignedPreKey(
            id=signed["id"],
            public_key=signed_public,
            signature=signed_signature,
        ),
        pre_keys=parsed_pre_keys,
    )


def serialize_signal_sender_snapshot(snapshot: SignalSenderSnapshot) -> dict[str, Any]:
    return {
        "version": snapshot.version,
        "identity": _serialize_signal_key_pair(snapshot.identity),
        "registrationId": snapshot.registration_id,
        "signedPreKeyPair": _serialize_signal_key_pair(snapshot.signed_pre_key_pair),
        "preKeyPair": _serialize_signal_key_pair(snapshot.pre_key_pair),
        "signedPreKeySignature": buffer_json(snapshot.signed_pre_key_signature),
        "records": encode_buffer_json(snapshot.records),
        "preKeys": {
            str(key_id): _serialize_signal_key_pair(key_pair)
            for key_id, key_pair in snapshot.pre_keys.items()
        },
        "signedPreKeys": {
            str(key_id): _serialize_signal_key_pair(key_pair)
            for key_id, key_pair in snapshot.signed_pre_keys.items()
        },
    }


def deserialize_signal_sender_snapshot(value: Any) -> SignalSenderSnapshot:
    decoded = decode_buffer_json(value)
    if not isinstance(decoded, dict):
        raise ValueError("signal-sender: stored snapshot must be an object")
    version = decoded.get("version")
    registration_id = decoded.get("registrationId")
    signature = decoded.get("signedPreKeySignature")
    records = decoded.get("records")
    pre_keys = decoded.get("preKeys")
    signed_pre_keys = decoded.get("signedPreKeys")
    if version != 1:
        raise ValueError("signal-sender: unsupported snapshot version")
    if not isinstance(registration_id, int):
        raise ValueError("signal-sender: invalid registration id")
    if not isinstance(signature, bytes):
        raise ValueError("signal-sender: invalid signed pre-key signature")
    if not isinstance(records, dict):
        raise ValueError("signal-sender: invalid records")
    if not isinstance(pre_keys, dict) or not isinstance(signed_pre_keys, dict):
        raise ValueError("signal-sender: invalid key maps")
    return SignalSenderSnapshot(
        version=version,
        identity=_deserialize_signal_key_pair(decoded.get("identity"), "identity"),
        registration_id=registration_id,
        signed_pre_key_pair=_deserialize_signal_key_pair(
            decoded.get("signedPreKeyPair"),
            "signedPreKeyPair",
        ),
        pre_key_pair=_deserialize_signal_key_pair(decoded.get("preKeyPair"), "preKeyPair"),
        signed_pre_key_signature=signature,
        records={str(address): _copy_signal_session(record) for address, record in records.items()},
        pre_keys={
            int(key_id): _deserialize_signal_key_pair(key_pair, "preKeys")
            for key_id, key_pair in pre_keys.items()
            if str(key_id).isdigit()
        },
        signed_pre_keys={
            int(key_id): _deserialize_signal_key_pair(key_pair, "signedPreKeys")
            for key_id, key_pair in signed_pre_keys.items()
            if str(key_id).isdigit()
        },
    )


def _serialize_signal_key_pair(key_pair: SignalSenderKeyPair) -> dict[str, Any]:
    return {
        "public": buffer_json(key_pair.public_key),
        "private": buffer_json(key_pair.private_key),
    }


def _deserialize_signal_key_pair(value: Any, context: str) -> SignalSenderKeyPair:
    if not isinstance(value, dict):
        raise ValueError(f"signal-sender: invalid {context}")
    public_key = value.get("public")
    private_key = value.get("private")
    if not isinstance(public_key, bytes) or not isinstance(private_key, bytes):
        raise ValueError(f"signal-sender: invalid {context} key material")
    return SignalSenderKeyPair(public_key=public_key, private_key=private_key)


def whatsapp_signal_senders_from_config(
    config: dict[str, Any] | None,
) -> dict[str, SignalSenderSnapshot]:
    if not isinstance(config, dict):
        return {}
    stored = config.get("signal_senders")
    if not isinstance(stored, dict):
        return {}
    snapshots: dict[str, SignalSenderSnapshot] = {}
    for key, value in stored.items():
        if not isinstance(key, str):
            continue
        try:
            snapshots[key] = deserialize_signal_sender_snapshot(value)
        except ValueError:
            continue
    return snapshots


def whatsapp_group_sender_keys_from_config(
    config: dict[str, Any] | None,
) -> dict[str, SenderKeyRecordSnapshot]:
    if not isinstance(config, dict):
        return {}
    stored = decode_buffer_json(config.get("group_sender_keys"))
    if not isinstance(stored, dict):
        return {}
    out: dict[str, SenderKeyRecordSnapshot] = {}
    for key_name, record in stored.items():
        if not isinstance(key_name, str) or not isinstance(record, dict):
            continue
        key = record.get("key")
        iteration = record.get("iteration")
        version = record.get("version")
        if version != 1 or not isinstance(key, bytes) or not isinstance(iteration, int):
            continue
        out[key_name] = {"version": 1, "key": key, "iteration": iteration}
    return out


def whatsapp_agent_bundle_from_config(config: dict[str, Any] | None) -> AgentBundle | None:
    if not isinstance(config, dict):
        return None
    bundle = config.get("agent_bundle")
    if not isinstance(bundle, dict):
        return None
    try:
        return deserialize_agent_bundle(bundle)
    except ValueError:
        return None


def whatsapp_agent_bundle_pre_key_count(config: dict[str, Any] | None) -> int:
    bundle = whatsapp_agent_bundle_from_config(config)
    if bundle is not None:
        return len(bundle.pre_keys)
    if not isinstance(config, dict):
        return 0
    bundle = config.get("agent_bundle")
    if not isinstance(bundle, dict):
        return 0
    pre_keys = bundle.get("preKeys")
    if not isinstance(pre_keys, list):
        return 0
    return sum(1 for item in pre_keys if isinstance(item, dict))


async def save_whatsapp_agent_bundle(
    db: AsyncSession,
    *,
    credential_id: UUID,
    account_id: UUID,
    bundle: AgentBundle,
) -> ChannelAgentCredential | None:
    credential = await db.get(ChannelAgentCredential, credential_id)
    if (
        credential is None
        or credential.account_id != account_id
        or credential.revoked_at is not None
    ):
        return None
    config = dict(credential.config or {})
    config["agent_bundle"] = serialize_agent_bundle(bundle)
    config["agent_bundle_updated_at"] = datetime.now(UTC).isoformat()
    credential.config = config
    await db.flush()
    return credential


async def save_whatsapp_signal_senders(
    db: AsyncSession,
    *,
    credential_id: UUID,
    account_id: UUID,
    senders: Mapping[str, SignalSenderSnapshot],
) -> ChannelAgentCredential | None:
    credential = await db.get(ChannelAgentCredential, credential_id)
    if (
        credential is None
        or credential.account_id != account_id
        or credential.revoked_at is not None
    ):
        return None
    config = dict(credential.config or {})
    config["signal_senders"] = {
        key: serialize_signal_sender_snapshot(snapshot) for key, snapshot in sorted(senders.items())
    }
    config["signal_senders_updated_at"] = datetime.now(UTC).isoformat()
    credential.config = config
    await db.flush()
    return credential


async def save_whatsapp_group_sender_keys(
    db: AsyncSession,
    *,
    credential_id: UUID,
    account_id: UUID,
    group_sender_keys: Mapping[str, SenderKeyRecordSnapshot],
) -> ChannelAgentCredential | None:
    credential = await db.get(ChannelAgentCredential, credential_id)
    if (
        credential is None
        or credential.account_id != account_id
        or credential.revoked_at is not None
    ):
        return None
    config = dict(credential.config or {})
    config["group_sender_keys"] = encode_buffer_json(
        {key: dict(record) for key, record in sorted(group_sender_keys.items())}
    )
    config["group_sender_keys_updated_at"] = datetime.now(UTC).isoformat()
    credential.config = config
    await db.flush()
    return credential


def mint_tenant_creds(
    *,
    tenant_id: str,
    phone_user: str | None = None,
    device: int = 1,
    name: str | None = None,
    self_identity: dict[str, str | None] | None = None,
) -> MintedWhatsAppCreds:
    noise_key = _x25519_key_pair()
    signed_identity_key = _x25519_key_pair()
    signed_pre_key = _x25519_key_pair()
    pairing_key = _x25519_key_pair()
    signature_key = ed25519.Ed25519PrivateKey.generate()
    signature = signature_key.sign(b"\x05" + signed_pre_key["public"])

    jid = _stamp_whatsapp_self_identity(
        tenant_id=tenant_id,
        phone_user=phone_user,
        device=device,
        name=name,
        self_identity=self_identity,
    )
    me: dict[str, str] = {
        "id": jid,
        "name": (self_identity or {}).get("name") or name or f"tenant:{tenant_id}",
    }
    lid = (self_identity or {}).get("lid")
    if lid:
        me["lid"] = lid

    creds: dict[str, Any] = {
        "noiseKey": noise_key,
        "pairingEphemeralKeyPair": pairing_key,
        "signedIdentityKey": signed_identity_key,
        "signedPreKey": {
            "keyPair": signed_pre_key,
            "signature": signature,
            "keyId": secrets.randbelow(16_000_000) + 1,
        },
        "registrationId": secrets.randbelow(16_384),
        "advSecretKey": base64.b64encode(secrets.token_bytes(32)).decode("ascii"),
        "processedHistoryMessages": [],
        "nextPreKeyId": 1,
        "firstUnuploadedPreKeyId": 1,
        "accountSyncCounter": 0,
        "accountSettings": {"unarchiveChats": False},
        "deviceId": base64.b64encode(secrets.token_bytes(16)).decode("ascii"),
        "phoneId": secrets.token_hex(16),
        "identityId": secrets.token_bytes(20),
        "backupToken": secrets.token_bytes(20),
        "registered": True,
        "me": me,
    }
    return MintedWhatsAppCreds(
        creds=creds,
        identity_pub_key=noise_key["public"],
        jid=jid,
    )


def apply_whatsapp_self_identity(
    creds: dict[str, Any],
    *,
    self_identity: dict[str, str | None],
    fallback_name: str,
) -> str:
    jid = str(self_identity["id"])
    me = {
        "id": jid,
        "name": self_identity.get("name") or fallback_name,
    }
    if self_identity.get("lid"):
        me["lid"] = str(self_identity["lid"])
    creds["me"] = me
    return jid


def parse_agent_bundle(req: BinaryNode) -> AgentBundle:
    if req.get("tag") != "iq":
        raise ValueError("agent-bundle: expected tag=iq")
    attrs = _attrs(req)
    if attrs.get("xmlns") != "encrypt" or attrs.get("type") != "set":
        raise ValueError("agent-bundle: expected xmlns=encrypt type=set")

    registration_id = _read_big_endian(
        _node_bytes(_child_by_tag(req, "registration"), "registration")
    )
    identity_key = _strip_key_prefix(_node_bytes(_child_by_tag(req, "identity"), "identity"))

    skey = _child_by_tag(req, "skey")
    if skey is None:
        raise ValueError("agent-bundle: missing <skey>")
    signed_pre_key = AgentSignedPreKey(
        id=_read_big_endian(_node_bytes(_child_by_tag(skey, "id"), "skey.id")),
        public_key=_strip_key_prefix(_node_bytes(_child_by_tag(skey, "value"), "skey.value")),
        signature=_node_bytes(_child_by_tag(skey, "signature"), "skey.signature"),
    )

    pre_keys: list[AgentPreKey] = []
    list_node = _child_by_tag(req, "list")
    if list_node is not None:
        for key_node in _children_by_tag(list_node, "key"):
            pre_keys.append(
                AgentPreKey(
                    id=_read_big_endian(_node_bytes(_child_by_tag(key_node, "id"), "key.id")),
                    public_key=_strip_key_prefix(
                        _node_bytes(_child_by_tag(key_node, "value"), "key.value")
                    ),
                )
            )
    return AgentBundle(
        registration_id=registration_id,
        identity_key=identity_key,
        signed_pre_key=signed_pre_key,
        pre_keys=pre_keys,
    )


class SignalSender:
    """Persistent synthetic WhatsApp Signal sender state.

    Implements the libsignal subset used by the legacy channel bridge: X3DH pre-key session
    setup, Double Ratchet message chains, WhisperMessage/PreKeyWhisperMessage
    framing, and serializable state. The implementation intentionally follows
    the old Node `libsignal` package so real Baileys clients can decrypt
    backend-synthesized inbound messages and the backend can decrypt their
    replies without a Node runtime in production.
    """

    signed_pre_key_id = 1
    pre_key_id = 1

    def __init__(self, snapshot: SignalSenderSnapshot | None = None) -> None:
        if snapshot is None:
            identity = _signal_key_pair()
            signed_pre_key_pair = _signal_key_pair()
            pre_key_pair = _signal_key_pair()
            self.registration_id = secrets.randbelow(16_384)
            self.identity = identity
            self.signed_pre_key_pair = signed_pre_key_pair
            self.pre_key_pair = pre_key_pair
            self.signed_pre_key_signature = hmac.digest(
                identity.private_key,
                signed_pre_key_pair.public_key,
                "sha256",
            ) + hmac.digest(
                identity.private_key,
                b"sig2:" + signed_pre_key_pair.public_key,
                "sha256",
            )
            self.records: dict[str, SignalSessionSnapshot] = {}
            self.pre_keys = {self.pre_key_id: pre_key_pair}
            self.signed_pre_keys = {self.signed_pre_key_id: signed_pre_key_pair}
            return

        if snapshot.version != 1:
            raise ValueError(f"unsupported SignalSenderSnapshot version {snapshot.version}")
        self.registration_id = snapshot.registration_id
        self.identity = snapshot.identity
        self.signed_pre_key_pair = snapshot.signed_pre_key_pair
        self.pre_key_pair = snapshot.pre_key_pair
        self.signed_pre_key_signature = snapshot.signed_pre_key_signature
        self.records = {
            address: _copy_signal_session(record) for address, record in snapshot.records.items()
        }
        self.pre_keys = dict(snapshot.pre_keys)
        self.signed_pre_keys = dict(snapshot.signed_pre_keys)

    def snapshot(self) -> SignalSenderSnapshot:
        return SignalSenderSnapshot(
            version=1,
            identity=self.identity,
            registration_id=self.registration_id,
            signed_pre_key_pair=self.signed_pre_key_pair,
            pre_key_pair=self.pre_key_pair,
            signed_pre_key_signature=self.signed_pre_key_signature,
            records={
                address: _copy_signal_session(record) for address, record in self.records.items()
            },
            pre_keys=dict(self.pre_keys),
            signed_pre_keys=dict(self.signed_pre_keys),
        )

    def get_bundle(self) -> AgentBundle:
        return AgentBundle(
            registration_id=self.registration_id,
            identity_key=self.identity.public_key,
            signed_pre_key=AgentSignedPreKey(
                id=self.signed_pre_key_id,
                public_key=self.signed_pre_key_pair.public_key,
                signature=self.signed_pre_key_signature,
            ),
            pre_keys=[
                AgentPreKey(id=key_id, public_key=key_pair.public_key)
                for key_id, key_pair in sorted(self.pre_keys.items())
            ],
        )

    def encrypt_for(
        self,
        sender_user: str,
        sender_device: int,
        bundle: AgentBundle,
        plaintext: bytes,
    ) -> EncryptedSignalEnvelope:
        address = _signal_address(sender_user, sender_device)
        record = self.records.get(address)
        if record is None:
            pre_key = bundle.pre_keys.pop(0) if bundle.pre_keys else None
            record = _new_signal_session(
                local_identity=self.identity,
                local_registration_id=self.registration_id,
                remote_registration_id=bundle.registration_id,
                remote_identity=bundle.identity_key,
                signed_pre_key=bundle.signed_pre_key,
                pre_key=pre_key,
            )
            self.records[address] = record

        ciphertext = _encrypt_signal_record(
            record,
            local_identity=self.identity,
            plaintext=plaintext,
        )
        envelope_type: Literal["pkmsg", "msg"] = "pkmsg" if record.get("pendingPreKey") else "msg"
        return EncryptedSignalEnvelope(type=envelope_type, ciphertext=ciphertext)

    def decrypt_from(
        self,
        agent_user: str,
        agent_device: int,
        envelope: EncryptedSignalEnvelope,
    ) -> bytes:
        address = _signal_address(agent_user, agent_device)
        record = self.records.get(address)
        if envelope.type == "pkmsg":
            plaintext, updated = _decrypt_signal_prekey_record(
                record=record,
                local_identity=self.identity,
                local_registration_id=self.registration_id,
                signed_pre_keys=self.signed_pre_keys,
                pre_keys=self.pre_keys,
                ciphertext=envelope.ciphertext,
            )
            self.records[address] = updated
            return plaintext
        if record is None:
            raise ValueError(f"signal session {address} not found")
        return _decrypt_signal_record(
            record,
            local_identity=self.identity,
            ciphertext=envelope.ciphertext,
        )

    def encrypt_from_established_session(
        self,
        agent_user: str,
        agent_device: int,
        plaintext: bytes,
    ) -> EncryptedSignalEnvelope:
        """Test/emulator helper for the agent-authored half of a mirrored session."""

        address = _signal_address(agent_user, agent_device)
        record = self.records.get(address)
        if record is None:
            raise ValueError(f"signal session {address} not found")
        return EncryptedSignalEnvelope(
            type="msg",
            ciphertext=_encrypt_signal_peer_record(
                record,
                local_identity=self.identity,
                plaintext=plaintext,
            ),
        )

    def mirror_session(
        self,
        from_user: str,
        from_device: int,
        to_user: str,
        to_device: int,
    ) -> None:
        if from_user == to_user and from_device == to_device:
            return
        from_address = _signal_address(from_user, from_device)
        record = self.records.get(from_address)
        if record is None:
            raise ValueError(f"signal session {from_address} not found")
        self.records[_signal_address(to_user, to_device)] = _copy_signal_session(record)


class GroupCipherBackend:
    def __init__(
        self,
        *,
        store: WhatsAppGroupSenderKeyStore | None = None,
        snapshot: Mapping[str, SenderKeyRecordSnapshot] | None = None,
    ) -> None:
        self._store = store
        self._records: dict[str, SenderKeyRecordSnapshot] = {
            key: dict(record) for key, record in (snapshot or {}).items()
        }

    def snapshot(self) -> dict[str, SenderKeyRecordSnapshot]:
        return {key: dict(record) for key, record in self._records.items()}

    def load_snapshot(self, snapshot: Mapping[str, SenderKeyRecordSnapshot]) -> None:
        self._records = {key: dict(record) for key, record in snapshot.items()}

    def has_sender_key(
        self,
        *,
        group_jid: str,
        author_user: str,
        author_device: int,
    ) -> bool:
        return (
            self._load_record(
                _sender_key_name(group_jid, author_user, author_device),
                create=False,
            )
            is not None
        )

    def clear(self) -> None:
        self._records.clear()

    def process_skdm(
        self,
        *,
        group_jid: str,
        author_user: str,
        author_device: int,
        axolotl_bytes: bytes,
    ) -> None:
        key_name = _sender_key_name(group_jid, author_user, author_device)
        snapshot = {
            "version": 1,
            "key": hashlib.sha256(axolotl_bytes).digest(),
            "iteration": 0,
        }
        self._records[key_name] = snapshot
        self._store_record(key_name, snapshot)

    def decrypt_skmsg(
        self,
        *,
        group_jid: str,
        author_user: str,
        author_device: int,
        ciphertext: bytes,
    ) -> bytes:
        key_name = _sender_key_name(group_jid, author_user, author_device)
        record = self._load_record(key_name, create=False)
        if record is None:
            raise ValueError(f"sender-key {key_name} not found")
        plaintext = _decrypt_sender_key_record(record, ciphertext)
        record["iteration"] = int(record.get("iteration", 0)) + 1
        self._store_record(key_name, record)
        return plaintext

    def _load_record(
        self,
        key_name: str,
        *,
        create: bool,
    ) -> SenderKeyRecordSnapshot | None:
        if key_name in self._records:
            return self._records[key_name]
        persisted = self._store.load(key_name) if self._store is not None else None
        if persisted is not None:
            self._records[key_name] = dict(persisted)
            return self._records[key_name]
        if not create:
            return None
        self._records[key_name] = {"version": 1, "key": secrets.token_bytes(32), "iteration": 0}
        return self._records[key_name]

    def _store_record(self, key_name: str, record: SenderKeyRecordSnapshot) -> None:
        self._records[key_name] = dict(record)
        if self._store is not None:
            self._store.save(key_name, dict(record))


def encrypt_whatsapp_group_message_for_sender_key(
    *,
    axolotl_bytes: bytes,
    plaintext: bytes,
) -> bytes:
    record = {"version": 1, "key": hashlib.sha256(axolotl_bytes).digest(), "iteration": 0}
    return _encrypt_sender_key_record(record, plaintext)


async def respond_to_iq(
    req: BinaryNode,
    *,
    pre_key_count: int,
    agent_user: str | None,
    agent_lid: str | None = None,
    tenant_id: str | None = None,
    resolve_recipient_bundle: Callable[[str], AgentBundle | None] | None = None,
    resolve_recipient_lid: Callable[[str], str | None] | None = None,
    resolve_group_participants: Callable[[str], list[WhatsAppGroupParticipantAddress]]
    | None = None,
    forward_iq: Callable[[BinaryNode, str | None], BinaryNode | Awaitable[BinaryNode | None] | None]
    | None = None,
) -> BinaryNode:
    if req.get("tag") != "iq":
        raise ValueError(f"iq: expected tag=iq, got {req.get('tag')}")
    attrs = _attrs(req)
    xmlns = attrs.get("xmlns")
    iq_type = attrs.get("type")
    child = _first_child_tag(req)

    if xmlns == "encrypt" and iq_type == "get" and child == "count":
        return _iq_result(req, [{"tag": "count", "attrs": {"value": str(pre_key_count)}}])

    if xmlns == "encrypt" and iq_type == "get" and child == "key":
        if resolve_recipient_bundle is None:
            return _iq_result(req)
        return _iq_result(
            req,
            [
                _recipient_bundle_node(jid, resolve_recipient_bundle(jid))
                for jid in _extract_user_jids_from_key_request(req)
            ],
        )

    if xmlns == "encrypt" and iq_type == "get" and child == "digest":
        return _iq_result(req, [{"tag": "digest", "attrs": {}}])

    if xmlns == "encrypt" and iq_type == "set":
        return _iq_result(req)

    if xmlns in {"passive", "md"} and iq_type == "set":
        return _iq_result(req)

    if xmlns == "w:g2" and iq_type == "get" and child == "query":
        forwarded = await _maybe_forward_iq(forward_iq, req, tenant_id)
        if forwarded is not None:
            return forwarded
        return _group_metadata_result(
            req,
            agent_user=agent_user,
            agent_lid=agent_lid,
            resolve_group_participants=resolve_group_participants,
        )

    if xmlns == "usync" and iq_type == "get":
        return _usync_devices_result(
            req,
            agent_user=agent_user,
            agent_lid=agent_lid,
            resolve_recipient_lid=resolve_recipient_lid,
        )

    if (
        isinstance(xmlns, str)
        and (
            (iq_type == "get" and xmlns in FORWARDABLE_GET_XMLNS)
            or (iq_type == "set" and xmlns in FORWARDABLE_SET_XMLNS)
        )
        and forward_iq is not None
    ):
        forwarded = await _maybe_forward_iq(forward_iq, req, tenant_id)
        if forwarded is not None:
            return forwarded

    return _iq_result(req)


def decide_whatsapp_relay(
    node: BinaryNode,
    *,
    resolve_jid: Callable[[str], str | None],
    lookup_inbound_sender: Callable[[str], str | None],
) -> RelayDecision:
    tag = str(node.get("tag") or "")
    if tag not in RELAY_TAG_ALLOWLIST:
        return RelayDecision(action="drop", reason="tag-not-allowlisted")
    attrs = _attrs(node)
    to_jid = attrs.get("to")
    if not to_jid:
        return RelayDecision(action="drop", reason="no-to-attr")
    relay_to_jid = resolve_jid(to_jid)
    if relay_to_jid is None:
        return RelayDecision(action="drop", reason="unbound-jid")

    recipient_jid = attrs.get("recipient")
    relay_recipient_jid: str | None = None
    if recipient_jid:
        relay_recipient_jid = resolve_jid(recipient_jid)
        if relay_recipient_jid is None:
            return RelayDecision(action="drop", reason="unbound-jid")

    bounds = _check_bounds(node, MAX_NODE_DEPTH, MAX_NODE_COUNT)
    if bounds == "too-deep":
        return RelayDecision(action="drop", reason="node-too-deep")
    if bounds == "too-wide":
        return RelayDecision(action="drop", reason="node-too-wide")

    is_group_receipt = tag == "receipt" and (
        to_jid.endswith("@g.us") or (recipient_jid or "").endswith("@g.us")
    )
    if is_group_receipt:
        claimed_participant = attrs.get("participant")
        if not attrs.get("id") or not claimed_participant:
            return RelayDecision(action="drop", reason="receipt-malformed")
        if not _valid_receipt_shape(node):
            return RelayDecision(action="drop", reason="receipt-malformed")
        for message_id in _collect_receipt_ids(node):
            known_sender = lookup_inbound_sender(message_id)
            if known_sender is None:
                return RelayDecision(action="drop", reason="receipt-id-unknown")
            if known_sender != claimed_participant:
                return RelayDecision(action="drop", reason="receipt-participant-mismatch")

    return RelayDecision(
        action="relay",
        node=_with_relay_addresses(node, relay_to_jid, relay_recipient_jid),
    )


def rewrite_whatsapp_media_to_upstream_url(
    incoming_url: str,
    *,
    upstream_host: str = WA_MEDIA_HOST,
) -> str | None:
    parsed = urlparse(incoming_url)
    for prefix in (MEDIA_PROXY_PREFIX, _LEGACY_MEDIA_PROXY_PREFIX):
        if parsed.path.startswith(prefix):
            direct_path = parsed.path[len(prefix) :]
            break
    else:
        return None
    if not direct_path.startswith("/"):
        return None
    return urlunparse(
        (
            "https",
            upstream_host,
            direct_path,
            "",
            parsed.query,
            "",
        )
    )


def rewrite_whatsapp_media_to_proxy_url(upstream_url: str, proxy_base_url: str) -> str:
    parsed = urlparse(upstream_url)
    if parsed.hostname != WA_MEDIA_HOST:
        raise ValueError(f"media-proxy: refusing to rewrite non-WA url {upstream_url}")
    base = proxy_base_url.rstrip("/")
    query = f"?{parsed.query}" if parsed.query else ""
    return f"{base}{MEDIA_PROXY_PREFIX}{parsed.path}{query}"


async def find_whatsapp_binding_by_jids(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    remote_jid: str,
    alt_jid: str | None = None,
) -> ChannelBinding | None:
    lookup = await resolve_whatsapp_binding_by_jids(
        db,
        account=account,
        remote_jid=remote_jid,
        alt_jid=alt_jid,
    )
    return lookup.binding


async def resolve_whatsapp_binding_by_jids(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    remote_jid: str,
    alt_jid: str | None = None,
) -> WhatsAppBindingLookup:
    matches: list[ChannelBinding] = []
    for candidate in _binding_candidates(remote_jid, alt_jid):
        binding = await _find_direct_binding(db, account=account, external_chat_id=candidate)
        if binding is not None:
            matches.append(binding)
        alias = await _find_binding_alias(db, account=account, alias_external_chat_id=candidate)
        if alias is not None:
            alias_binding = await db.get(ChannelBinding, alias.binding_id)
            if alias_binding is not None and alias_binding.status == BINDING_STATUS_ACTIVE:
                matches.append(alias_binding)
    unique_matches = list({binding.id: binding for binding in matches}.values())
    if len({binding.bot_agent_link_id for binding in unique_matches}) > 1:
        return WhatsAppBindingLookup(binding=None, conflict=True)
    return WhatsAppBindingLookup(binding=unique_matches[0] if unique_matches else None)


async def remember_whatsapp_binding_aliases(
    db: AsyncSession,
    *,
    binding: ChannelBinding | None,
    remote_jid: str,
    alt_jid: str | None = None,
) -> None:
    if binding is None:
        return
    for candidate in _binding_candidates(remote_jid, alt_jid):
        if candidate == binding.external_chat_id:
            continue
        direct = await _find_direct_binding(
            db,
            account_id=binding.account_id,
            external_chat_id=candidate,
        )
        if direct is not None:
            continue
        existing = await _find_binding_alias(
            db,
            account_id=binding.account_id,
            alias_external_chat_id=candidate,
        )
        if existing is not None:
            if existing.binding_id == binding.id:
                continue
            return
        db.add(
            ChannelBindingAlias(
                account_id=binding.account_id,
                bot_agent_link_id=binding.bot_agent_link_id,
                binding_id=binding.id,
                user_id=binding.user_id,
                alias_external_chat_id=candidate,
            )
        )


async def load_or_create_whatsapp_auth_cert(
    db: AsyncSession,
    *,
    account: ChannelAccount,
) -> WhatsAppAuthCert:
    result = await db.execute(
        select(ChannelWhatsAppAuthCert).where(ChannelWhatsAppAuthCert.account_id == account.id)
    )
    row = result.scalar_one_or_none()
    if row is not None:
        return WhatsAppAuthCert(
            serial=row.serial,
            issuer="clawdi",
            root_public_key=row.root_public_key,
            root_private_key=base64.b64decode(
                decrypt(row.encrypted_root_private_key, row.root_private_key_nonce)
            ),
            intermediate_public_key=row.intermediate_public_key,
            intermediate_private_key=base64.b64decode(
                decrypt(
                    row.encrypted_intermediate_private_key,
                    row.intermediate_private_key_nonce,
                )
            ),
        )

    root = _x25519_key_pair()
    intermediate = _x25519_key_pair()
    root_ciphertext, root_nonce = encrypt(base64.b64encode(root["private"]).decode("ascii"))
    intermediate_ciphertext, intermediate_nonce = encrypt(
        base64.b64encode(intermediate["private"]).decode("ascii")
    )
    db.add(
        ChannelWhatsAppAuthCert(
            account_id=account.id,
            user_id=account.user_id,
            root_public_key=root["public"],
            encrypted_root_private_key=root_ciphertext,
            root_private_key_nonce=root_nonce,
            intermediate_public_key=intermediate["public"],
            encrypted_intermediate_private_key=intermediate_ciphertext,
            intermediate_private_key_nonce=intermediate_nonce,
            serial=0,
        )
    )
    await db.flush()
    return WhatsAppAuthCert(
        serial=0,
        issuer="clawdi",
        root_public_key=root["public"],
        root_private_key=root["private"],
        intermediate_public_key=intermediate["public"],
        intermediate_private_key=intermediate["private"],
    )


def serialize_whatsapp_auth_cert(cert: WhatsAppAuthCert) -> dict[str, Any]:
    return {
        "SERIAL": cert.serial,
        "ISSUER": cert.issuer,
        "PUBLIC_KEY": buffer_json(cert.root_public_key),
    }


async def mint_whatsapp_agent_credential(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
    user_id: UUID | None = None,
    phone_user: str | None = None,
    device: int = 1,
    name: str | None = None,
    self_identity: dict[str, str | None] | None = None,
) -> StoredWhatsAppCredential:
    minted = mint_tenant_creds(
        tenant_id=str(bot_agent_link_id),
        phone_user=phone_user,
        device=device,
        name=name,
        self_identity=self_identity,
    )
    serialized = serialize_creds(minted.creds)
    ciphertext, nonce = encrypt(serialized)
    credential = ChannelAgentCredential(
        account_id=account.id,
        bot_agent_link_id=bot_agent_link_id,
        user_id=user_id or account.user_id,
        provider=CHANNEL_PROVIDER_WHATSAPP,
        identity_pub_key_hash=hashlib.sha256(minted.identity_pub_key).hexdigest(),
        identity_public_key=minted.identity_pub_key,
        synthetic_jid=minted.jid,
        encrypted_credentials=ciphertext,
        credential_nonce=nonce,
        config={"device": device, "name": name},
    )
    db.add(credential)
    await db.flush()
    return StoredWhatsAppCredential(credential=credential, minted=minted)


async def resolve_whatsapp_credential_by_identity(
    db: AsyncSession,
    *,
    identity_public_key: bytes,
) -> ChannelAgentCredential | None:
    result = await db.execute(
        select(ChannelAgentCredential).where(
            ChannelAgentCredential.provider == CHANNEL_PROVIDER_WHATSAPP,
            ChannelAgentCredential.identity_pub_key_hash
            == hashlib.sha256(identity_public_key).hexdigest(),
            ChannelAgentCredential.revoked_at.is_(None),
        )
    )
    return result.scalar_one_or_none()


async def revoke_whatsapp_agent_credential(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    credential_id: UUID,
    user_id: UUID | None = None,
) -> bool:
    credential = await db.get(ChannelAgentCredential, credential_id)
    if (
        credential is None
        or credential.account_id != account.id
        or (user_id is not None and credential.user_id != user_id)
        or credential.revoked_at is not None
    ):
        return False
    credential.revoked_at = datetime.now(UTC)
    return True


def whatsapp_agent_websocket_url(account_id: UUID | str | None = None) -> str:
    path = (
        f"/v1/channels/whatsapp/{account_id}/baileys"
        if account_id is not None
        else "/v1/channels/whatsapp/baileys"
    )
    return _public_ws_url(path)


def whatsapp_media_proxy_base_url() -> str:
    return f"{settings.public_api_url.rstrip('/')}{MEDIA_PROXY_PREFIX}"


def _x25519_key_pair() -> dict[str, bytes]:
    private_key = x25519.X25519PrivateKey.generate()
    public_key = private_key.public_key()
    return {
        "private": private_key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        ),
        "public": public_key.public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        ),
    }


def _signal_key_pair() -> SignalSenderKeyPair:
    raw = _x25519_key_pair()
    return SignalSenderKeyPair(public_key=raw["public"], private_key=raw["private"])


def _signal_address(user: str, device: int) -> str:
    return f"{user}.{device}"


def _sender_key_name(group_jid: str, author_user: str, author_device: int) -> str:
    return f"{group_jid}::{author_user}::{author_device}"


def _new_signal_session(
    *,
    local_identity: SignalSenderKeyPair,
    local_registration_id: int,
    remote_registration_id: int,
    remote_identity: bytes,
    signed_pre_key: AgentSignedPreKey,
    pre_key: AgentPreKey | None,
) -> SignalSessionSnapshot:
    base_key = _signal_key_pair()
    remote_identity_key = _signal_prefixed_public_key(remote_identity)
    remote_signed_key = _signal_prefixed_public_key(signed_pre_key.public_key)
    remote_pre_key = (
        _signal_prefixed_public_key(pre_key.public_key) if pre_key is not None else None
    )
    session = _init_signal_session(
        is_initiator=True,
        our_identity=local_identity,
        our_ephemeral_key=base_key,
        our_signed_key=None,
        their_identity_pub_key=remote_identity_key,
        their_ephemeral_pub_key=remote_pre_key,
        their_signed_pub_key=remote_signed_key,
        registration_id=remote_registration_id,
    )
    pending_pre_key: dict[str, Any] = {
        "signedKeyId": signed_pre_key.id,
        "baseKey": _signal_prefixed_public_key(base_key.public_key),
    }
    if pre_key is not None:
        pending_pre_key["preKeyId"] = pre_key.id
    session["pendingPreKey"] = pending_pre_key
    session["localRegistrationId"] = local_registration_id
    return session


def _copy_signal_session(record: SignalSessionSnapshot) -> SignalSessionSnapshot:
    return _copy_signal_value(record)


SIGNAL_VERSION = 3
SIGNAL_VERSION_BYTE = (SIGNAL_VERSION << 4) | SIGNAL_VERSION
SIGNAL_PREFIX = b"\x05"
SIGNAL_SENDING_CHAIN = 1
SIGNAL_RECEIVING_CHAIN = 2
SIGNAL_BASE_KEY_OURS = 1
SIGNAL_BASE_KEY_THEIRS = 2


def _copy_signal_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _copy_signal_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_copy_signal_value(item) for item in value]
    return value


def _signal_prefixed_public_key(raw: bytes) -> bytes:
    if len(raw) == 33 and raw[:1] == SIGNAL_PREFIX:
        return raw
    if len(raw) == 32:
        return SIGNAL_PREFIX + raw
    raise ValueError("signal: invalid public key")


def _signal_raw_public_key(raw: bytes) -> bytes:
    prefixed = _signal_prefixed_public_key(raw)
    return prefixed[1:]


def _signal_key_dict(key_pair: SignalSenderKeyPair) -> dict[str, bytes]:
    return {
        "public": _signal_prefixed_public_key(key_pair.public_key),
        "private": key_pair.private_key,
    }


def _signal_key_pair_from_dict(value: Mapping[str, Any]) -> SignalSenderKeyPair:
    public = value.get("public")
    private = value.get("private")
    if not isinstance(public, bytes) or not isinstance(private, bytes):
        raise ValueError("signal: invalid key pair")
    return SignalSenderKeyPair(public_key=_signal_raw_public_key(public), private_key=private)


def _signal_agreement(public_key: bytes, private_key: bytes) -> bytes:
    private = x25519.X25519PrivateKey.from_private_bytes(private_key)
    public = x25519.X25519PublicKey.from_public_bytes(_signal_raw_public_key(public_key))
    return private.exchange(public)


def _signal_derive_secrets(
    input_key_material: bytes,
    salt: bytes,
    info: bytes,
    *,
    chunks: int = 3,
) -> list[bytes]:
    if len(salt) != 32:
        raise ValueError("signal: salt must be 32 bytes")
    if chunks < 1 or chunks > 3:
        raise ValueError("signal: chunks must be between 1 and 3")
    prk = hmac.digest(salt, input_key_material, "sha256")
    out: list[bytes] = []
    previous = b""
    for idx in range(1, chunks + 1):
        previous = hmac.digest(prk, previous + info + bytes([idx]), "sha256")
        out.append(previous)
    return out


def _signal_aes_cbc_encrypt(key: bytes, plaintext: bytes, iv: bytes) -> bytes:
    padder = padding.PKCS7(128).padder()
    padded = padder.update(plaintext) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return encryptor.update(padded) + encryptor.finalize()


def _signal_aes_cbc_decrypt(key: bytes, ciphertext: bytes, iv: bytes) -> bytes:
    decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    return unpadder.update(padded) + unpadder.finalize()


def _signal_mac(key: bytes, data: bytes) -> bytes:
    return hmac.digest(key, data, "sha256")


def _signal_verify_mac(data: bytes, key: bytes, expected: bytes, *, length: int = 8) -> None:
    calculated = _signal_mac(key, data)[:length]
    if len(expected) != length or not hmac.compare_digest(calculated, expected):
        raise ValueError("signal: bad mac")


def _init_signal_session(
    *,
    is_initiator: bool,
    our_identity: SignalSenderKeyPair,
    our_ephemeral_key: SignalSenderKeyPair | None,
    our_signed_key: SignalSenderKeyPair | None,
    their_identity_pub_key: bytes,
    their_ephemeral_pub_key: bytes | None,
    their_signed_pub_key: bytes | None,
    registration_id: int,
) -> SignalSessionSnapshot:
    if is_initiator:
        if our_ephemeral_key is None or our_signed_key is not None or their_signed_pub_key is None:
            raise ValueError("signal: invalid initiator session")
        our_signed_key = our_ephemeral_key
    else:
        if (
            our_signed_key is None
            or their_ephemeral_pub_key is None
            or their_signed_pub_key is not None
        ):
            raise ValueError("signal: invalid responder session")
        their_signed_pub_key = their_ephemeral_pub_key

    shared_secret = bytearray(32 * (5 if our_ephemeral_key and their_ephemeral_pub_key else 4))
    shared_secret[:32] = b"\xff" * 32
    a1 = _signal_agreement(their_signed_pub_key, our_identity.private_key)
    a2 = _signal_agreement(their_identity_pub_key, our_signed_key.private_key)
    a3 = _signal_agreement(their_signed_pub_key, our_signed_key.private_key)
    if is_initiator:
        shared_secret[32:64] = a1
        shared_secret[64:96] = a2
    else:
        shared_secret[32:64] = a2
        shared_secret[64:96] = a1
    shared_secret[96:128] = a3
    if our_ephemeral_key and their_ephemeral_pub_key:
        shared_secret[128:160] = _signal_agreement(
            their_ephemeral_pub_key,
            our_ephemeral_key.private_key,
        )

    master_key = _signal_derive_secrets(
        bytes(shared_secret),
        b"\x00" * 32,
        b"WhisperText",
    )
    ratchet_pair = _signal_key_pair() if is_initiator else our_signed_key
    session: SignalSessionSnapshot = {
        "protocol": "libsignal-js",
        "version": 1,
        "registrationId": registration_id,
        "currentRatchet": {
            "rootKey": master_key[0],
            "ephemeralKeyPair": _signal_key_dict(ratchet_pair),
            "lastRemoteEphemeralKey": _signal_prefixed_public_key(their_signed_pub_key),
            "previousCounter": 0,
        },
        "indexInfo": {
            "created": 0,
            "used": 0,
            "remoteIdentityKey": _signal_prefixed_public_key(their_identity_pub_key),
            "baseKey": _signal_prefixed_public_key(
                our_ephemeral_key.public_key if is_initiator else their_ephemeral_pub_key
            ),
            "baseKeyType": SIGNAL_BASE_KEY_OURS if is_initiator else SIGNAL_BASE_KEY_THEIRS,
            "closed": -1,
        },
        "chains": {},
    }
    if is_initiator:
        _signal_calculate_sending_ratchet(
            session,
            _signal_prefixed_public_key(their_signed_pub_key),
        )
    return session


def _signal_calculate_sending_ratchet(session: SignalSessionSnapshot, remote_key: bytes) -> None:
    ratchet = _signal_ratchet(session)
    key_pair = _signal_key_pair_from_dict(_mapping(ratchet["ephemeralKeyPair"]))
    shared_secret = _signal_agreement(remote_key, key_pair.private_key)
    master_key = _signal_derive_secrets(shared_secret, ratchet["rootKey"], b"WhisperRatchet")
    _signal_add_chain(
        session,
        _signal_prefixed_public_key(key_pair.public_key),
        {
            "messageKeys": {},
            "chainKey": {"counter": -1, "key": master_key[1]},
            "chainType": SIGNAL_SENDING_CHAIN,
        },
    )
    ratchet["rootKey"] = master_key[0]


def _signal_calculate_ratchet(
    session: SignalSessionSnapshot,
    remote_key: bytes,
    *,
    sending: bool,
) -> None:
    ratchet = _signal_ratchet(session)
    key_pair = _signal_key_pair_from_dict(_mapping(ratchet["ephemeralKeyPair"]))
    shared_secret = _signal_agreement(remote_key, key_pair.private_key)
    master_key = _signal_derive_secrets(
        shared_secret,
        ratchet["rootKey"],
        b"WhisperRatchet",
        chunks=2,
    )
    chain_key = _signal_prefixed_public_key(key_pair.public_key) if sending else remote_key
    _signal_add_chain(
        session,
        chain_key,
        {
            "messageKeys": {},
            "chainKey": {"counter": -1, "key": master_key[1]},
            "chainType": SIGNAL_SENDING_CHAIN if sending else SIGNAL_RECEIVING_CHAIN,
        },
    )
    ratchet["rootKey"] = master_key[0]


def _signal_chain_id(key: bytes) -> str:
    return base64.b64encode(_signal_prefixed_public_key(key)).decode("ascii")


def _signal_add_chain(session: SignalSessionSnapshot, key: bytes, value: dict[str, Any]) -> None:
    chains = _mapping(session.setdefault("chains", {}))
    chain_id = _signal_chain_id(key)
    if chain_id in chains:
        raise ValueError("signal: chain overwrite")
    chains[chain_id] = value


def _signal_get_chain(session: SignalSessionSnapshot, key: bytes) -> dict[str, Any] | None:
    chain = _mapping(session.setdefault("chains", {})).get(_signal_chain_id(key))
    return chain if isinstance(chain, dict) else None


def _signal_delete_chain(session: SignalSessionSnapshot, key: bytes) -> None:
    chains = _mapping(session.setdefault("chains", {}))
    del chains[_signal_chain_id(key)]


def _signal_ratchet(session: SignalSessionSnapshot) -> dict[str, Any]:
    return _mapping(session["currentRatchet"])


def _signal_index_info(session: SignalSessionSnapshot) -> dict[str, Any]:
    return _mapping(session["indexInfo"])


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("signal: expected object")
    return value


def _signal_fill_message_keys(chain: dict[str, Any], counter: int) -> None:
    chain_key = _mapping(chain["chainKey"])
    message_keys = _mapping(chain.setdefault("messageKeys", {}))
    current = int(chain_key.get("counter", -1))
    if current >= counter:
        return
    if counter - current > 2000:
        raise ValueError("signal: message counter too far in future")
    key = chain_key.get("key")
    if not isinstance(key, bytes):
        raise ValueError("signal: chain closed")
    while int(chain_key["counter"]) < counter:
        step_key = chain_key["key"]
        message_keys[str(int(chain_key["counter"]) + 1)] = _signal_mac(step_key, b"\x01")
        chain_key["key"] = _signal_mac(step_key, b"\x02")
        chain_key["counter"] = int(chain_key["counter"]) + 1


def _signal_encode_whisper_message(message: Mapping[str, Any]) -> bytes:
    return b"".join(
        [
            _proto_bytes_field(1, _bytes_value(message["ephemeralKey"])),
            _proto_key(2, 0) + _proto_varint(int(message["counter"])),
            _proto_key(3, 0) + _proto_varint(int(message["previousCounter"])),
            _proto_bytes_field(4, _bytes_value(message["ciphertext"])),
        ]
    )


def _signal_decode_whisper_message(data: bytes) -> dict[str, Any]:
    fields = _decode_protobuf_fields(data)
    return {
        "ephemeralKey": _required_bytes_field(fields, 1, "ephemeralKey"),
        "counter": _required_int_field(fields, 2, "counter"),
        "previousCounter": _required_int_field(fields, 3, "previousCounter"),
        "ciphertext": _required_bytes_field(fields, 4, "ciphertext"),
    }


def _signal_encode_prekey_message(message: Mapping[str, Any]) -> bytes:
    parts: list[bytes] = []
    pre_key_id = message.get("preKeyId")
    if pre_key_id is not None:
        parts.append(_proto_key(1, 0) + _proto_varint(int(pre_key_id)))
    parts.extend(
        [
            _proto_bytes_field(2, _bytes_value(message["baseKey"])),
            _proto_bytes_field(3, _bytes_value(message["identityKey"])),
            _proto_bytes_field(4, _bytes_value(message["message"])),
            _proto_key(5, 0) + _proto_varint(int(message["registrationId"])),
            _proto_key(6, 0) + _proto_varint(int(message["signedPreKeyId"])),
        ]
    )
    return b"".join(parts)


def _signal_decode_prekey_message(data: bytes) -> dict[str, Any]:
    fields = _decode_protobuf_fields(data)
    return {
        "preKeyId": _optional_int_field(fields, 1),
        "baseKey": _required_bytes_field(fields, 2, "baseKey"),
        "identityKey": _required_bytes_field(fields, 3, "identityKey"),
        "message": _required_bytes_field(fields, 4, "message"),
        "registrationId": _required_int_field(fields, 5, "registrationId"),
        "signedPreKeyId": _required_int_field(fields, 6, "signedPreKeyId"),
    }


def _bytes_value(value: Any) -> bytes:
    if not isinstance(value, bytes):
        raise ValueError("signal: expected bytes")
    return value


def _decode_protobuf_fields(data: bytes) -> dict[int, Any]:
    pos = 0
    out: dict[int, Any] = {}
    while pos < len(data):
        key, pos = _read_proto_varint(data, pos)
        field_number = key >> 3
        wire_type = key & 0x07
        if wire_type == 0:
            value, pos = _read_proto_varint(data, pos)
            out[field_number] = value
            continue
        if wire_type == 2:
            length, pos = _read_proto_varint(data, pos)
            end = pos + length
            if end > len(data):
                raise ValueError("signal: protobuf length out of range")
            out[field_number] = data[pos:end]
            pos = end
            continue
        raise ValueError(f"signal: unsupported protobuf wire type {wire_type}")
    return out


def _optional_proto_string(fields: Mapping[int, Any], field: int) -> str | None:
    value = fields.get(field)
    if not isinstance(value, bytes):
        return None
    return value.decode("utf-8", errors="replace")


def _optional_proto_bytes(fields: Mapping[int, Any], field: int) -> bytes | None:
    value = fields.get(field)
    return value if isinstance(value, bytes) else None


def _read_proto_varint(data: bytes, pos: int) -> tuple[int, int]:
    shift = 0
    value = 0
    while pos < len(data):
        byte = data[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, pos
        shift += 7
        if shift > 63:
            raise ValueError("signal: varint too long")
    raise ValueError("signal: truncated varint")


def _required_bytes_field(fields: Mapping[int, Any], field: int, name: str) -> bytes:
    value = fields.get(field)
    if not isinstance(value, bytes):
        raise ValueError(f"signal: missing {name}")
    return value


def _required_int_field(fields: Mapping[int, Any], field: int, name: str) -> int:
    value = fields.get(field)
    if not isinstance(value, int):
        raise ValueError(f"signal: missing {name}")
    return value


def _optional_int_field(fields: Mapping[int, Any], field: int) -> int | None:
    value = fields.get(field)
    return value if isinstance(value, int) else None


def _signal_encode_tuple_byte(number1: int, number2: int) -> int:
    if number1 > 15 or number2 > 15:
        raise ValueError("signal: tuple byte values must fit in four bits")
    return (number1 << 4) | number2


def _signal_check_version(data: bytes, *, context: str) -> bytes:
    if not data:
        raise ValueError(f"signal: empty {context}")
    max_version = data[0] >> 4
    min_version = data[0] & 0x0F
    if min_version > SIGNAL_VERSION or max_version < SIGNAL_VERSION:
        raise ValueError(f"signal: incompatible version on {context}")
    return data[1:]


def _encrypt_signal_record(
    record: SignalSessionSnapshot,
    *,
    local_identity: SignalSenderKeyPair,
    plaintext: bytes,
) -> bytes:
    session = _mapping(record)
    identity_key = _signal_prefixed_public_key(local_identity.public_key)
    ratchet = _signal_ratchet(session)
    current_key = _signal_key_pair_from_dict(_mapping(ratchet["ephemeralKeyPair"]))
    chain = _signal_get_chain(session, _signal_prefixed_public_key(current_key.public_key))
    if chain is None or chain.get("chainType") == SIGNAL_RECEIVING_CHAIN:
        raise ValueError("signal: no sending chain")
    chain_key = _mapping(chain["chainKey"])
    _signal_fill_message_keys(chain, int(chain_key["counter"]) + 1)
    counter = int(chain_key["counter"])
    message_keys = _mapping(chain["messageKeys"])
    message_key = _bytes_value(message_keys.pop(str(counter)))
    keys = _signal_derive_secrets(message_key, b"\x00" * 32, b"WhisperMessageKeys")
    message = {
        "ephemeralKey": _signal_prefixed_public_key(current_key.public_key),
        "counter": counter,
        "previousCounter": int(ratchet.get("previousCounter", 0)),
        "ciphertext": _signal_aes_cbc_encrypt(keys[0], plaintext, keys[2][:16]),
    }
    message_proto = _signal_encode_whisper_message(message)
    remote_identity = _bytes_value(_signal_index_info(session)["remoteIdentityKey"])
    version = _signal_encode_tuple_byte(SIGNAL_VERSION, SIGNAL_VERSION)
    mac_input = identity_key + remote_identity + bytes([version]) + message_proto
    mac = _signal_mac(keys[1], mac_input)[:8]
    whisper_body = bytes([version]) + message_proto + mac
    pending = session.get("pendingPreKey")
    if not isinstance(pending, dict):
        return whisper_body
    prekey_body = _signal_encode_prekey_message(
        {
            "identityKey": identity_key,
            "registrationId": int(session.get("localRegistrationId", 0)),
            "baseKey": _bytes_value(pending["baseKey"]),
            "signedPreKeyId": int(pending["signedKeyId"]),
            "preKeyId": pending.get("preKeyId"),
            "message": whisper_body,
        }
    )
    return bytes([version]) + prekey_body


def _decrypt_signal_prekey_record(
    *,
    record: SignalSessionSnapshot | None,
    local_identity: SignalSenderKeyPair,
    local_registration_id: int,
    signed_pre_keys: dict[int, SignalSenderKeyPair],
    pre_keys: dict[int, SignalSenderKeyPair],
    ciphertext: bytes,
) -> tuple[bytes, SignalSessionSnapshot]:
    prekey_proto = _signal_decode_prekey_message(
        _signal_check_version(ciphertext, context="PreKeyWhisperMessage")
    )
    session = record
    base_key = _signal_prefixed_public_key(prekey_proto["baseKey"])
    if session is None or _signal_index_info(session).get("baseKey") != base_key:
        signed_key_id = int(prekey_proto["signedPreKeyId"])
        signed_key = signed_pre_keys.get(signed_key_id)
        if signed_key is None:
            raise ValueError("signal: missing signed pre-key")
        pre_key: SignalSenderKeyPair | None = None
        pre_key_id = prekey_proto.get("preKeyId")
        if pre_key_id is not None:
            pre_key = pre_keys.get(int(pre_key_id))
            if pre_key is None:
                raise ValueError("signal: missing pre-key")
        session = _init_signal_session(
            is_initiator=False,
            our_identity=local_identity,
            our_ephemeral_key=pre_key,
            our_signed_key=signed_key,
            their_identity_pub_key=prekey_proto["identityKey"],
            their_ephemeral_pub_key=base_key,
            their_signed_pub_key=None,
            registration_id=int(prekey_proto["registrationId"]),
        )
        session["localRegistrationId"] = local_registration_id
    plaintext = _decrypt_signal_record(
        session,
        local_identity=local_identity,
        ciphertext=prekey_proto["message"],
    )
    pre_key_id = prekey_proto.get("preKeyId")
    if pre_key_id is not None:
        pre_keys.pop(int(pre_key_id), None)
    return plaintext, session


def _decrypt_signal_record(
    record: SignalSessionSnapshot,
    *,
    local_identity: SignalSenderKeyPair,
    ciphertext: bytes,
) -> bytes:
    session = _mapping(record)
    message_buffer = _signal_check_version(ciphertext, context="WhisperMessage")
    if len(message_buffer) < 8:
        raise ValueError("signal: whisper message too short")
    message_proto = message_buffer[:-8]
    message = _signal_decode_whisper_message(message_proto)
    _signal_maybe_step_ratchet(
        session,
        _signal_prefixed_public_key(message["ephemeralKey"]),
        int(message["previousCounter"]),
    )
    chain = _signal_get_chain(session, _signal_prefixed_public_key(message["ephemeralKey"]))
    if chain is None or chain.get("chainType") == SIGNAL_SENDING_CHAIN:
        raise ValueError("signal: no receiving chain")
    counter = int(message["counter"])
    _signal_fill_message_keys(chain, counter)
    message_keys = _mapping(chain["messageKeys"])
    if str(counter) not in message_keys:
        raise ValueError("signal: message key unavailable")
    message_key = _bytes_value(message_keys.pop(str(counter)))
    keys = _signal_derive_secrets(message_key, b"\x00" * 32, b"WhisperMessageKeys")
    local_identity_key = _signal_prefixed_public_key(local_identity.public_key)
    remote_identity = _bytes_value(_signal_index_info(session)["remoteIdentityKey"])
    version = _signal_encode_tuple_byte(SIGNAL_VERSION, SIGNAL_VERSION)
    mac_input = remote_identity + local_identity_key + bytes([version]) + message_proto
    _signal_verify_mac(mac_input, keys[1], message_buffer[-8:], length=8)
    session.pop("pendingPreKey", None)
    return _signal_aes_cbc_decrypt(keys[0], message["ciphertext"], keys[2][:16])


def _signal_maybe_step_ratchet(
    session: SignalSessionSnapshot,
    remote_key: bytes,
    previous_counter: int,
) -> None:
    remote_key = _signal_prefixed_public_key(remote_key)
    if _signal_get_chain(session, remote_key) is not None:
        return
    ratchet = _signal_ratchet(session)
    previous_remote = _bytes_value(ratchet["lastRemoteEphemeralKey"])
    previous_ratchet = _signal_get_chain(session, previous_remote)
    if previous_ratchet is not None:
        _signal_fill_message_keys(previous_ratchet, previous_counter)
        _mapping(previous_ratchet["chainKey"]).pop("key", None)
    _signal_calculate_ratchet(session, remote_key, sending=False)
    old_local_key = _signal_key_pair_from_dict(_mapping(ratchet["ephemeralKeyPair"]))
    old_local_chain = _signal_get_chain(
        session,
        _signal_prefixed_public_key(old_local_key.public_key),
    )
    if old_local_chain is not None:
        ratchet["previousCounter"] = int(_mapping(old_local_chain["chainKey"])["counter"])
        _signal_delete_chain(session, _signal_prefixed_public_key(old_local_key.public_key))
    new_local_key = _signal_key_pair()
    ratchet["ephemeralKeyPair"] = _signal_key_dict(new_local_key)
    _signal_calculate_ratchet(session, remote_key, sending=True)
    ratchet["lastRemoteEphemeralKey"] = remote_key


def _encrypt_signal_peer_record(
    record: SignalSessionSnapshot,
    *,
    local_identity: SignalSenderKeyPair,
    plaintext: bytes,
) -> bytes:
    session = _mapping(record)
    ratchet = _signal_ratchet(session)
    local_ratchet_key = _signal_key_pair_from_dict(_mapping(ratchet["ephemeralKeyPair"]))
    peer_ephemeral = _signal_key_pair()
    master_key = _signal_derive_secrets(
        _signal_agreement(
            _signal_prefixed_public_key(local_ratchet_key.public_key),
            peer_ephemeral.private_key,
        ),
        ratchet["rootKey"],
        b"WhisperRatchet",
        chunks=2,
    )
    chain: dict[str, Any] = {
        "messageKeys": {},
        "chainKey": {"counter": -1, "key": master_key[1]},
        "chainType": SIGNAL_SENDING_CHAIN,
    }
    _signal_fill_message_keys(chain, 0)
    message_key = _bytes_value(_mapping(chain["messageKeys"]).pop("0"))
    keys = _signal_derive_secrets(message_key, b"\x00" * 32, b"WhisperMessageKeys")
    message = {
        "ephemeralKey": _signal_prefixed_public_key(peer_ephemeral.public_key),
        "counter": 0,
        "previousCounter": 0,
        "ciphertext": _signal_aes_cbc_encrypt(keys[0], plaintext, keys[2][:16]),
    }
    message_proto = _signal_encode_whisper_message(message)
    remote_identity = _bytes_value(_signal_index_info(session)["remoteIdentityKey"])
    local_identity_key = _signal_prefixed_public_key(local_identity.public_key)
    version = _signal_encode_tuple_byte(SIGNAL_VERSION, SIGNAL_VERSION)
    mac_input = remote_identity + local_identity_key + bytes([version]) + message_proto
    mac = _signal_mac(keys[1], mac_input)[:8]
    return bytes([version]) + message_proto + mac


def _encrypt_sender_key_record(record: SenderKeyRecordSnapshot, plaintext: bytes) -> bytes:
    iteration = int(record.get("iteration", 0))
    nonce = _record_nonce(b"sender-key", iteration)
    return nonce + AESGCM(record["key"]).encrypt(nonce, plaintext, None)


def _decrypt_sender_key_record(record: SenderKeyRecordSnapshot, ciphertext: bytes) -> bytes:
    if len(ciphertext) < 13:
        raise ValueError("sender-key ciphertext too short")
    nonce = ciphertext[:12]
    body = ciphertext[12:]
    return AESGCM(record["key"]).decrypt(nonce, body, None)


def _record_nonce(prefix: bytes, counter: int) -> bytes:
    return hashlib.sha256(prefix + counter.to_bytes(8, "big")).digest()[:12]


def _stamp_whatsapp_self_identity(
    *,
    tenant_id: str,
    phone_user: str | None,
    device: int,
    name: str | None,
    self_identity: dict[str, str | None] | None,
) -> str:
    del name
    if self_identity and self_identity.get("id"):
        return str(self_identity["id"])
    phone = phone_user or _derive_synthetic_user(tenant_id)
    return f"{phone}:{device}@s.whatsapp.net"


def _derive_synthetic_user(tenant_id: str) -> str:
    hi = 0xCBF29CE4
    lo = 0x84222325
    for char in tenant_id:
        lo ^= ord(char)
        combined = ((hi << 32) | lo) * 0x100000001B3
        combined &= 0xFFFFFFFFFFFFFFFF
        hi = (combined >> 32) & 0xFFFFFFFF
        lo = combined & 0xFFFFFFFF
    combined = ((hi << 32) | lo) & 0xFFFFFFFFFFFFFFFF
    return str(combined % 900_000_000_000_000 + 100_000_000_000_000)


def _attrs(node: BinaryNode) -> dict[str, str]:
    attrs = node.get("attrs")
    return attrs if isinstance(attrs, dict) else {}


def _content(node: BinaryNode) -> Any:
    return node.get("content")


def _children(node: BinaryNode) -> list[BinaryNode]:
    content = _content(node)
    if not isinstance(content, list):
        return []
    return [child for child in content if isinstance(child, dict) and "tag" in child]


def _child_by_tag(node: BinaryNode | None, tag: str) -> BinaryNode | None:
    if node is None:
        return None
    for child in _children(node):
        if child.get("tag") == tag:
            return child
    return None


def _children_by_tag(node: BinaryNode, tag: str) -> list[BinaryNode]:
    return [child for child in _children(node) if child.get("tag") == tag]


def _node_bytes(node: BinaryNode | None, context: str) -> bytes:
    if node is None:
        raise ValueError(f"agent-bundle: {context} missing or not bytes")
    value = _content(node)
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, list) and all(isinstance(item, int) for item in value):
        return bytes(value)
    if isinstance(value, dict) and value.get("type") == "Buffer":
        data = value.get("data")
        if isinstance(data, str):
            return base64.b64decode(data)
        if isinstance(data, list) and all(isinstance(item, int) for item in data):
            return bytes(data)
    if isinstance(value, str):
        return base64.b64decode(value)
    raise ValueError(f"agent-bundle: {context} missing or not bytes")


def _read_big_endian(data: bytes) -> int:
    value = 0
    for byte in data:
        value = (value << 8) | byte
    return value & 0xFFFFFFFF


def _encode_big_endian(value: int, size: int) -> bytes:
    return value.to_bytes(size, byteorder="big", signed=False)


def _strip_key_prefix(key: bytes) -> bytes:
    if len(key) == 33 and key[0] == 0x05:
        return key[1:]
    if len(key) == 32:
        return key
    raise ValueError(f"agent-bundle: expected 32- or 33-byte key, got {len(key)}")


def _maybe_prefixed_key(key: bytes) -> bytes:
    return key if len(key) == 33 else b"\x05" + key


def _iq_result(req: BinaryNode, content: list[BinaryNode] | None = None) -> BinaryNode:
    iq_id = _attrs(req).get("id")
    if not iq_id:
        raise ValueError("iq: inbound request missing attrs.id")
    result: BinaryNode = {
        "tag": "iq",
        "attrs": {
            "id": iq_id,
            "type": "result",
            "from": "s.whatsapp.net",
        },
    }
    if content is not None:
        result["content"] = content
    return result


def _first_child_tag(node: BinaryNode) -> str | None:
    children = _children(node)
    if not children:
        return None
    tag = children[0].get("tag")
    return str(tag) if isinstance(tag, str) else None


def _extract_user_jids_from_key_request(req: BinaryNode) -> list[str]:
    jids: list[str] = []
    for child in _children(req):
        if child.get("tag") != "key":
            continue
        for user in _children(child):
            if user.get("tag") == "user":
                jid = _attrs(user).get("jid")
                if jid:
                    jids.append(jid)
    return jids


def _recipient_bundle_node(jid: str, bundle: AgentBundle | None) -> BinaryNode:
    if bundle is None:
        return {
            "tag": "user",
            "attrs": {"jid": jid},
            "content": [{"tag": "error", "attrs": {"code": "404"}}],
        }
    return {
        "tag": "user",
        "attrs": {"jid": jid},
        "content": [
            {
                "tag": "registration",
                "attrs": {},
                "content": _encode_big_endian(bundle.registration_id, 4),
            },
            {"tag": "type", "attrs": {}, "content": b"\x05"},
            {
                "tag": "identity",
                "attrs": {},
                "content": _maybe_prefixed_key(bundle.identity_key),
            },
            {
                "tag": "skey",
                "attrs": {},
                "content": [
                    {
                        "tag": "id",
                        "attrs": {},
                        "content": _encode_big_endian(bundle.signed_pre_key.id, 3),
                    },
                    {
                        "tag": "value",
                        "attrs": {},
                        "content": _maybe_prefixed_key(bundle.signed_pre_key.public_key),
                    },
                    {
                        "tag": "signature",
                        "attrs": {},
                        "content": bundle.signed_pre_key.signature,
                    },
                ],
            },
            {
                "tag": "list",
                "attrs": {},
                "content": [
                    {
                        "tag": "key",
                        "attrs": {},
                        "content": [
                            {
                                "tag": "id",
                                "attrs": {},
                                "content": _encode_big_endian(pre_key.id, 3),
                            },
                            {
                                "tag": "value",
                                "attrs": {},
                                "content": _maybe_prefixed_key(pre_key.public_key),
                            },
                        ],
                    }
                    for pre_key in bundle.pre_keys
                ],
            },
        ],
    }


async def _maybe_forward_iq(
    forward_iq: Callable[[BinaryNode, str | None], BinaryNode | Awaitable[BinaryNode | None] | None]
    | None,
    req: BinaryNode,
    tenant_id: str | None,
) -> BinaryNode | None:
    if forward_iq is None:
        return None
    response = forward_iq(req, tenant_id)
    if inspect.isawaitable(response):
        return await response
    return response


def _usync_devices_result(
    req: BinaryNode,
    *,
    agent_user: str | None,
    agent_lid: str | None,
    resolve_recipient_lid: Callable[[str], str | None] | None,
) -> BinaryNode:
    usync = _child_by_tag(req, "usync")
    list_node = _child_by_tag(usync, "list") if usync is not None else None
    agent_lid_user = strip_whatsapp_device(agent_lid).split("@", 1)[0] if agent_lid else None
    users: list[BinaryNode] = []
    if list_node is not None:
        for user in _children_by_tag(list_node, "user"):
            jid = _attrs(user).get("jid")
            if not jid:
                continue
            jid_user = strip_whatsapp_device(jid).split("@", 1)[0]
            is_agent_self = (agent_user is not None and jid_user == agent_user) or (
                agent_lid_user is not None and jid_user == agent_lid_user
            )
            lid = resolve_recipient_lid(jid) if resolve_recipient_lid else None
            lid = lid or f"{jid_user}@lid"
            users.append(
                {
                    "tag": "user",
                    "attrs": {"jid": jid},
                    "content": [
                        {"tag": "lid", "attrs": {"val": lid}},
                        {
                            "tag": "devices",
                            "attrs": {},
                            "content": [
                                {
                                    "tag": "device-list",
                                    "attrs": {},
                                    "content": []
                                    if is_agent_self
                                    else [{"tag": "device", "attrs": {"id": "0"}}],
                                }
                            ],
                        },
                    ],
                }
            )
    usync_attrs = _attrs(usync or {})
    return _iq_result(
        req,
        [
            {
                "tag": "usync",
                "attrs": {
                    "sid": usync_attrs.get("sid", ""),
                    "mode": usync_attrs.get("mode", "query"),
                    "last": usync_attrs.get("last", "true"),
                },
                "content": [{"tag": "list", "attrs": {}, "content": users}],
            }
        ],
    )


def _group_metadata_result(
    req: BinaryNode,
    *,
    agent_user: str | None,
    agent_lid: str | None,
    resolve_group_participants: Callable[[str], list[WhatsAppGroupParticipantAddress]] | None,
) -> BinaryNode:
    group_jid = _attrs(req).get("to", "")
    short_id = group_jid.split("@", 1)[0]
    peers = resolve_group_participants(group_jid) if resolve_group_participants else []
    addressing_mode = _choose_group_addressing_mode(peers)
    participants: list[BinaryNode] = []
    if agent_user:
        agent_pn_jid = f"{agent_user}@s.whatsapp.net"
        agent_lid_jid = strip_whatsapp_device(agent_lid) if agent_lid else None
        agent_jid = agent_lid_jid if addressing_mode == "lid" else agent_pn_jid
        if agent_jid:
            attrs = {"jid": agent_jid, "type": "superadmin"}
            if addressing_mode == "lid":
                attrs["phone_number"] = agent_pn_jid
            elif agent_lid_jid:
                attrs["lid"] = agent_lid_jid
            participants.append({"tag": "participant", "attrs": attrs})
    for peer in peers:
        attrs = _group_participant_attrs(peer, addressing_mode)
        if attrs is not None:
            participants.append({"tag": "participant", "attrs": attrs})
    return _iq_result(
        req,
        [
            {
                "tag": "group",
                "attrs": {
                    "id": short_id,
                    "creation": "1700000000",
                    "addressing_mode": addressing_mode,
                },
                "content": participants,
            }
        ],
    )


def _choose_group_addressing_mode(
    peers: list[WhatsAppGroupParticipantAddress],
) -> Literal["lid", "pn"]:
    return "lid" if any(_lid_for(peer) for peer in peers) else "pn"


def _group_participant_attrs(
    peer: WhatsAppGroupParticipantAddress,
    addressing_mode: Literal["lid", "pn"],
) -> dict[str, str] | None:
    lid_jid = _lid_for(peer)
    pn_jid = _pn_for(peer)
    if addressing_mode == "lid":
        if not lid_jid:
            return None
        attrs = {"jid": lid_jid}
        if pn_jid:
            attrs["phone_number"] = pn_jid
        return attrs
    if not pn_jid:
        return None
    attrs = {"jid": pn_jid}
    if lid_jid:
        attrs["lid"] = lid_jid
    return attrs


def _lid_for(peer: WhatsAppGroupParticipantAddress) -> str | None:
    if peer.lid_jid and peer.lid_jid.endswith("@lid"):
        return strip_whatsapp_device(peer.lid_jid)
    if peer.jid.endswith("@lid"):
        return strip_whatsapp_device(peer.jid)
    return None


def _pn_for(peer: WhatsAppGroupParticipantAddress) -> str | None:
    if peer.pn_jid and peer.pn_jid.endswith("@s.whatsapp.net"):
        return strip_whatsapp_device(peer.pn_jid)
    if peer.jid.endswith("@s.whatsapp.net"):
        return strip_whatsapp_device(peer.jid)
    return None


def _check_bounds(
    root: BinaryNode,
    max_depth: int,
    max_count: int,
) -> Literal["ok", "too-deep", "too-wide"]:
    stack: list[tuple[BinaryNode, int]] = [(root, 0)]
    visited = 0
    while stack:
        node, depth = stack.pop()
        if depth > max_depth:
            return "too-deep"
        visited += 1
        for child in _children(node):
            if visited + len(stack) >= max_count:
                return "too-wide"
            stack.append((child, depth + 1))
    return "ok"


def _valid_receipt_shape(node: BinaryNode) -> bool:
    content = _content(node)
    if content is None:
        return True
    if not isinstance(content, list):
        return False
    if len(content) == 0:
        return True
    if len(content) != 1:
        return False
    list_node = content[0]
    if not isinstance(list_node, dict) or list_node.get("tag") != "list":
        return False
    list_content = list_node.get("content")
    if not isinstance(list_content, list):
        return False
    for item in list_content:
        if not isinstance(item, dict) or item.get("tag") != "item":
            return False
        item_id = _attrs(item).get("id")
        if not item_id:
            return False
        if "content" in item:
            return False
    return True


def _collect_receipt_ids(node: BinaryNode) -> list[str]:
    ids: list[str] = []
    root_id = _attrs(node).get("id")
    if root_id:
        ids.append(root_id)
    for child in _children(node):
        if child.get("tag") != "list":
            continue
        for item in _children(child):
            if item.get("tag") != "item":
                continue
            item_id = _attrs(item).get("id")
            if item_id:
                ids.append(item_id)
    return ids


def _scrub_spoof_attrs(node: BinaryNode) -> BinaryNode:
    attrs = dict(_attrs(node))
    attrs.pop("from", None)
    attrs.pop("name", None)
    out = {key: value for key, value in node.items() if key not in {"attrs", "content"}}
    out["attrs"] = attrs
    content = _content(node)
    if isinstance(content, list):
        out["content"] = [
            _scrub_spoof_attrs(child) if isinstance(child, dict) else child for child in content
        ]
    elif content is not None:
        out["content"] = content
    return out


def _with_relay_addresses(
    node: BinaryNode,
    to_jid: str,
    recipient_jid: str | None,
) -> BinaryNode:
    scrubbed = _scrub_spoof_attrs(node)
    attrs = dict(_attrs(scrubbed))
    attrs["to"] = to_jid
    if recipient_jid:
        attrs["recipient"] = recipient_jid
    scrubbed["attrs"] = attrs
    return scrubbed


def _binding_candidates(remote_jid: str, alt_jid: str | None) -> list[str]:
    candidates: list[str] = []
    for jid in [choose_whatsapp_route_jid(remote_jid, alt_jid), remote_jid, alt_jid]:
        if not jid:
            continue
        candidates.extend(whatsapp_jid_candidates(jid))
    return list(dict.fromkeys(candidates))


async def _find_direct_binding(
    db: AsyncSession,
    *,
    external_chat_id: str,
    account: ChannelAccount | None = None,
    account_id: UUID | None = None,
) -> ChannelBinding | None:
    resolved_account_id = account.id if account is not None else account_id
    if resolved_account_id is None:
        raise ValueError("account or account_id is required")
    result = await db.execute(
        select(ChannelBinding).where(
            ChannelBinding.account_id == resolved_account_id,
            ChannelBinding.external_chat_id == external_chat_id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
    )
    return result.scalar_one_or_none()


async def _find_binding_alias(
    db: AsyncSession,
    *,
    alias_external_chat_id: str,
    account: ChannelAccount | None = None,
    account_id: UUID | None = None,
) -> ChannelBindingAlias | None:
    resolved_account_id = account.id if account is not None else account_id
    if resolved_account_id is None:
        raise ValueError("account or account_id is required")
    result = await db.execute(
        select(ChannelBindingAlias).where(
            ChannelBindingAlias.account_id == resolved_account_id,
            ChannelBindingAlias.alias_external_chat_id == alias_external_chat_id,
        )
    )
    return result.scalar_one_or_none()


def _public_ws_url(path: str) -> str:
    base = settings.public_api_url.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base.removeprefix("https://") + path
    if base.startswith("http://"):
        return "ws://" + base.removeprefix("http://") + path
    return base + path


def append_query(url: str, params: dict[str, str]) -> str:
    parsed = urlparse(url)
    query = parsed.query
    addition = urlencode(params)
    return urlunparse(parsed._replace(query=f"{query}&{addition}" if query else addition))
