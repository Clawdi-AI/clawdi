from __future__ import annotations

import hashlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal, Protocol
from uuid import UUID

import httpx
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import settings
from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_STATUS_ACTIVE,
    MESSAGE_DIRECTION_INBOUND,
    ChannelAccount,
    ChannelMessage,
)
from app.services.channel_debug_events import record_channel_debug_event
from app.services.channels import (
    decrypt_provider_token,
    enqueue_channel_outbound_message,
    find_binding,
)
from app.services.url_security import UnsafeOutboundUrlError, validate_channel_http_url
from app.services.whatsapp_baileys import (
    BinaryNode,
    WhatsAppCloudOutboundPayload,
    decide_whatsapp_relay,
    forward_iq_over,
    whatsapp_cloud_outbound_payload_from_proto,
    whatsapp_media_reupload_candidate_from_proto,
)
from app.services.whatsapp_media_reupload import (
    WhatsAppMediaReuploadError,
    reupload_whatsapp_media,
)
from app.services.whatsapp_runtime_types import WhatsAppOutboundMessage

WHATSAPP_SHARED_RUNTIME_BAILEYS_WEBSOCKET = "baileys_websocket"
WHATSAPP_SHARED_RUNTIME_CLAWDI_OUTBOX = "clawdi_outbox"


@dataclass(frozen=True)
class WhatsAppSharedBotRelayResult:
    outcome: Literal["queued", "relayed", "unsupported", "failed"]
    external_chat_id: str
    provider_message_id: str
    channel_message_id: UUID | None = None
    delivery_id: UUID | None = None
    reason: str | None = None


@dataclass(frozen=True)
class WhatsAppSharedBotRawRelayResult:
    outcome: Literal["relayed", "dropped", "unsupported", "failed"]
    tag: str
    external_chat_id: str | None = None
    reason: str | None = None


@dataclass(frozen=True)
class _WhatsAppCloudRawRelay:
    kind: Literal["receipt_read", "typing_indicator"]
    payloads: tuple[dict[str, Any], ...]


@dataclass(frozen=True)
class WhatsAppSharedBotTransportStatus:
    available: bool
    mode: Literal["in_process", "sidecar", "none"]
    reason: str | None
    supports_outbound_messages: bool
    supports_raw_relay: bool
    supports_iq_queries: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "mode": self.mode,
            "reason": self.reason,
            "supportsOutboundMessages": self.supports_outbound_messages,
            "supportsRawRelay": self.supports_raw_relay,
            "supportsIqQueries": self.supports_iq_queries,
        }


class WhatsAppSharedBotTransport(Protocol):
    async def relay_outbound_message(self, message: WhatsAppOutboundMessage) -> None: ...

    async def relay_raw_node(self, node: BinaryNode) -> None: ...

    async def query_iq(
        self,
        node: BinaryNode,
        timeout_ms: int,
    ) -> BinaryNode | None: ...


class WhatsAppSharedBotRuntime(Protocol):
    async def relay_outbound_message(self, message: WhatsAppOutboundMessage) -> None: ...

    async def relay_raw_node(
        self,
        node: BinaryNode,
        lookup_inbound_sender: Callable[[str], str | None],
    ) -> None: ...

    async def forward_iq(self, node: BinaryNode, tenant_id: str | None) -> BinaryNode | None: ...


_SHARED_BOT_TRANSPORTS: dict[UUID, WhatsAppSharedBotTransport] = {}


def register_whatsapp_shared_bot_transport(
    account_id: UUID,
    transport: WhatsAppSharedBotTransport,
) -> None:
    """Register a native shared-bot transport for one WhatsApp account."""

    _SHARED_BOT_TRANSPORTS[account_id] = transport


def unregister_whatsapp_shared_bot_transport(account_id: UUID) -> None:
    _SHARED_BOT_TRANSPORTS.pop(account_id, None)


def get_whatsapp_shared_bot_transport(account_id: UUID) -> WhatsAppSharedBotTransport | None:
    return _SHARED_BOT_TRANSPORTS.get(account_id)


def whatsapp_shared_bot_transport_status(account_id: UUID) -> WhatsAppSharedBotTransportStatus:
    transport = get_whatsapp_shared_bot_transport(account_id)
    if transport is None:
        return WhatsAppSharedBotTransportStatus(
            available=False,
            mode="none",
            reason="shared-bot-transport-unavailable",
            supports_outbound_messages=False,
            supports_raw_relay=False,
            supports_iq_queries=False,
        )
    connected = _transport_connected(transport)
    return WhatsAppSharedBotTransportStatus(
        available=connected,
        mode=_transport_mode(transport),
        reason=None if connected else "shared-bot-transport-disconnected",
        supports_outbound_messages=callable(getattr(transport, "relay_outbound_message", None)),
        supports_raw_relay=callable(getattr(transport, "relay_raw_node", None)),
        supports_iq_queries=callable(getattr(transport, "query_iq", None)),
    )


class WhatsAppClawdiOutboxSharedBotRuntime:
    """Transparent shared-bot adapter backed by Clawdi's native delivery outbox."""

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        account_id: UUID,
        transport: WhatsAppSharedBotTransport | None = None,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._account_id = account_id
        self._transport = transport
        self._forward_iq_inflight = 0

    async def relay_outbound_message(self, message: WhatsAppOutboundMessage) -> None:
        await self.store_outbound_message(message)

    async def store_outbound_message(
        self,
        message: WhatsAppOutboundMessage,
        *,
        bot_agent_link_id: UUID | None = None,
    ) -> WhatsAppSharedBotRelayResult:
        async with self._sessionmaker() as db:
            account = await _load_active_whatsapp_account(db, account_id=self._account_id)
            details = _outbound_debug_details(message)
            provider_payload = whatsapp_cloud_outbound_payload_from_proto(
                message.message_proto,
                conversation=message.conversation,
            )
            if provider_payload.outcome == "native_required":
                if provider_payload.reason == "media-reupload-required":
                    cloud_media = await self._try_cloud_media_reupload(
                        db,
                        account=account,
                        message=message,
                        bot_agent_link_id=bot_agent_link_id,
                        details={
                            **details,
                            "protoKind": provider_payload.kind,
                            "reason": provider_payload.reason,
                        },
                    )
                    if cloud_media is not None:
                        return cloud_media
                return await self._relay_native_outbound_message(
                    db,
                    account=account,
                    message=message,
                    bot_agent_link_id=bot_agent_link_id,
                    details={
                        **details,
                        "protoKind": provider_payload.kind,
                        "reason": provider_payload.reason or "baileys-native-proto-required",
                    },
                )
            if provider_payload.outcome == "sendable" and _requires_native_outbound_chat(
                message.to_jid
            ):
                return await self._relay_native_outbound_message(
                    db,
                    account=account,
                    message=message,
                    bot_agent_link_id=bot_agent_link_id,
                    details={
                        **details,
                        "protoKind": provider_payload.kind,
                        "reason": "group-cloud-api-native-required",
                    },
                )
            native_reason = _native_outbound_attr_reason(message.attrs)
            if provider_payload.outcome == "sendable" and native_reason is not None:
                return await self._relay_native_outbound_message(
                    db,
                    account=account,
                    message=message,
                    bot_agent_link_id=bot_agent_link_id,
                    details={
                        **details,
                        "protoKind": provider_payload.kind,
                        "reason": native_reason,
                    },
                )
            if provider_payload.outcome != "sendable" or provider_payload.provider_payload is None:
                await record_channel_debug_event(
                    db,
                    account=account,
                    user_id=account.user_id,
                    provider=CHANNEL_PROVIDER_WHATSAPP,
                    direction="agent",
                    stage="outbound_delivery",
                    outcome="unsupported",
                    external_chat_id=message.to_jid,
                    details={
                        **details,
                        "protoKind": provider_payload.kind,
                        "reason": provider_payload.reason or "proto-not-sendable",
                    },
                )
                await db.commit()
                return WhatsAppSharedBotRelayResult(
                    outcome="unsupported",
                    external_chat_id=message.to_jid,
                    provider_message_id=message.message_id,
                    reason=provider_payload.reason or "proto-not-sendable",
                )

            return await self._queue_cloud_provider_payload(
                db,
                account=account,
                message=message,
                details=details,
                bot_agent_link_id=bot_agent_link_id,
                provider_payload=provider_payload,
            )

    async def _try_cloud_media_reupload(
        self,
        db: AsyncSession,
        *,
        account: ChannelAccount,
        message: WhatsAppOutboundMessage,
        bot_agent_link_id: UUID | None,
        details: dict[str, Any],
    ) -> WhatsAppSharedBotRelayResult | None:
        if self._transport is not None:
            return None
        if _requires_native_outbound_chat(message.to_jid):
            return None
        if not _has_whatsapp_cloud_media_reupload_config(account):
            return None
        candidate = whatsapp_media_reupload_candidate_from_proto(message.message_proto)
        if candidate is None:
            return None
        try:
            provider_payload = await reupload_whatsapp_media(
                account=account,
                candidate=candidate,
            )
        except WhatsAppMediaReuploadError as exc:
            await record_channel_debug_event(
                db,
                account=account,
                user_id=account.user_id,
                provider=CHANNEL_PROVIDER_WHATSAPP,
                direction="agent",
                stage="outbound_delivery",
                outcome="failed",
                external_chat_id=message.to_jid,
                details={
                    **details,
                    "mediaKind": candidate.kind,
                    "mediaReupload": "failed",
                    "mediaReuploadReason": exc.reason,
                },
            )
            await db.commit()
            return WhatsAppSharedBotRelayResult(
                outcome="failed",
                external_chat_id=message.to_jid,
                provider_message_id=message.message_id,
                reason=exc.reason,
            )
        except HTTPException as exc:
            await record_channel_debug_event(
                db,
                account=account,
                user_id=account.user_id,
                provider=CHANNEL_PROVIDER_WHATSAPP,
                direction="agent",
                stage="outbound_delivery",
                outcome="failed",
                external_chat_id=message.to_jid,
                details={
                    **details,
                    "mediaKind": candidate.kind,
                    "mediaReupload": "failed",
                    "errorStatus": exc.status_code,
                    "errorDetail": str(exc.detail),
                },
            )
            await db.commit()
            return WhatsAppSharedBotRelayResult(
                outcome="failed",
                external_chat_id=message.to_jid,
                provider_message_id=message.message_id,
                reason="media-reupload-failed",
            )
        return await self._queue_cloud_provider_payload(
            db,
            account=account,
            message=message,
            bot_agent_link_id=bot_agent_link_id,
            details={
                **details,
                "mediaKind": candidate.kind,
                "mediaReupload": "uploaded",
            },
            provider_payload=provider_payload,
        )

    async def _queue_cloud_provider_payload(
        self,
        db: AsyncSession,
        *,
        account: ChannelAccount,
        message: WhatsAppOutboundMessage,
        details: dict[str, Any],
        bot_agent_link_id: UUID | None,
        provider_payload: WhatsAppCloudOutboundPayload,
    ) -> WhatsAppSharedBotRelayResult:
        if provider_payload.provider_payload is None:
            raise ValueError("provider_payload is required")
        queued, delivery = await enqueue_channel_outbound_message(
            db,
            account=account,
            external_chat_id=message.to_jid,
            text=provider_payload.text or "",
            bot_agent_link_id=bot_agent_link_id,
        )
        payload = dict(queued.payload or {})
        payload["source"] = WHATSAPP_SHARED_RUNTIME_BAILEYS_WEBSOCKET
        payload["sharedRuntime"] = WHATSAPP_SHARED_RUNTIME_CLAWDI_OUTBOX
        payload["providerMessageId"] = message.message_id
        payload["protoSha256"] = details["protoSha256"]
        payload["protoKind"] = provider_payload.kind
        payload["providerPayload"] = provider_payload.provider_payload
        queued.payload = payload
        await record_channel_debug_event(
            db,
            account=account,
            user_id=account.user_id,
            provider=CHANNEL_PROVIDER_WHATSAPP,
            direction="agent",
            stage="outbound_delivery",
            outcome="queued",
            external_chat_id=message.to_jid,
            details={
                **details,
                "deliveryId": str(delivery.id),
                "channelMessageId": str(queued.id),
                "protoKind": provider_payload.kind,
                "providerPayloadType": provider_payload.provider_payload.get("type"),
            },
        )
        await db.commit()
        return WhatsAppSharedBotRelayResult(
            outcome="queued",
            external_chat_id=message.to_jid,
            provider_message_id=message.message_id,
            channel_message_id=queued.id,
            delivery_id=delivery.id,
        )

    async def _relay_native_outbound_message(
        self,
        db: AsyncSession,
        *,
        account: ChannelAccount,
        message: WhatsAppOutboundMessage,
        bot_agent_link_id: UUID | None,
        details: dict[str, Any],
    ) -> WhatsAppSharedBotRelayResult:
        relay = _native_outbound_relay(self._transport)
        if relay is None:
            await record_channel_debug_event(
                db,
                account=account,
                user_id=account.user_id,
                provider=CHANNEL_PROVIDER_WHATSAPP,
                direction="agent",
                stage="outbound_delivery",
                outcome="unsupported",
                external_chat_id=message.to_jid,
                details={**details, "nativeTransport": "unavailable"},
            )
            await db.commit()
            return WhatsAppSharedBotRelayResult(
                outcome="unsupported",
                external_chat_id=message.to_jid,
                provider_message_id=message.message_id,
                reason=str(details.get("reason") or "baileys-native-proto-required"),
            )
        try:
            await relay(message)
        except Exception as exc:
            await record_channel_debug_event(
                db,
                account=account,
                user_id=account.user_id,
                provider=CHANNEL_PROVIDER_WHATSAPP,
                direction="agent",
                stage="outbound_delivery",
                outcome="failed",
                external_chat_id=message.to_jid,
                details={**details, "errorType": exc.__class__.__name__},
            )
            await db.commit()
            return WhatsAppSharedBotRelayResult(
                outcome="failed",
                external_chat_id=message.to_jid,
                provider_message_id=message.message_id,
                reason=exc.__class__.__name__,
            )

        await record_channel_debug_event(
            db,
            account=account,
            user_id=account.user_id,
            provider=CHANNEL_PROVIDER_WHATSAPP,
            direction="agent",
            stage="outbound_delivery",
            outcome="relayed",
            external_chat_id=message.to_jid,
            details={**details, "nativeTransport": "relayed"},
        )
        await db.commit()
        return WhatsAppSharedBotRelayResult(
            outcome="relayed",
            external_chat_id=message.to_jid,
            provider_message_id=message.message_id,
        )

    async def relay_raw_node(
        self,
        node: BinaryNode,
        lookup_inbound_sender: Callable[[str], str | None],
    ) -> WhatsAppSharedBotRawRelayResult:
        attrs = _node_attrs(node)
        tag = str(node.get("tag") or "")
        external_chat_id = attrs.get("to") or attrs.get("recipient")
        async with self._sessionmaker() as db:
            account = await _load_active_whatsapp_account(db, account_id=self._account_id)
            resolve_jid = await _build_bound_jid_resolver(db, account=account, node=node)
            decision = decide_whatsapp_relay(
                node,
                resolve_jid=resolve_jid,
                lookup_inbound_sender=lookup_inbound_sender,
            )
            details = _raw_relay_debug_details(node)
            if decision.action == "drop" or decision.node is None:
                await record_channel_debug_event(
                    db,
                    account=account,
                    user_id=account.user_id,
                    provider=CHANNEL_PROVIDER_WHATSAPP,
                    direction="agent",
                    stage="outbound_relay",
                    outcome="dropped",
                    external_chat_id=external_chat_id,
                    details={**details, "reason": decision.reason or "unknown"},
                )
                await db.commit()
                return WhatsAppSharedBotRawRelayResult(
                    outcome="dropped",
                    tag=tag,
                    external_chat_id=external_chat_id,
                    reason=decision.reason,
                )

            if self._transport is None:
                try:
                    cloud_relay = await _cloud_raw_relay_from_node(
                        db,
                        account=account,
                        node=decision.node,
                    )
                    if cloud_relay is not None:
                        await _send_whatsapp_cloud_raw_relay(account, cloud_relay)
                        await record_channel_debug_event(
                            db,
                            account=account,
                            user_id=account.user_id,
                            provider=CHANNEL_PROVIDER_WHATSAPP,
                            direction="agent",
                            stage="outbound_relay",
                            outcome="relayed",
                            external_chat_id=external_chat_id,
                            details={
                                **details,
                                "cloudTransport": "relayed",
                                "cloudPayloadKind": cloud_relay.kind,
                                "cloudPayloadCount": len(cloud_relay.payloads),
                            },
                        )
                        await db.commit()
                        return WhatsAppSharedBotRawRelayResult(
                            outcome="relayed",
                            tag=tag,
                            external_chat_id=external_chat_id,
                        )
                except HTTPException as exc:
                    await record_channel_debug_event(
                        db,
                        account=account,
                        user_id=account.user_id,
                        provider=CHANNEL_PROVIDER_WHATSAPP,
                        direction="agent",
                        stage="outbound_relay",
                        outcome="failed",
                        external_chat_id=external_chat_id,
                        status_code=exc.status_code,
                        error=_http_exception_detail(exc),
                        details={
                            **details,
                            "cloudTransport": "failed",
                            "errorType": "HTTPException",
                        },
                    )
                    await db.commit()
                    return WhatsAppSharedBotRawRelayResult(
                        outcome="failed",
                        tag=tag,
                        external_chat_id=external_chat_id,
                        reason=_http_exception_detail(exc),
                    )

                await record_channel_debug_event(
                    db,
                    account=account,
                    user_id=account.user_id,
                    provider=CHANNEL_PROVIDER_WHATSAPP,
                    direction="agent",
                    stage="outbound_relay",
                    outcome="unsupported",
                    external_chat_id=external_chat_id,
                    details={**details, "reason": "shared-bot-transport-unavailable"},
                )
                await db.commit()
                return WhatsAppSharedBotRawRelayResult(
                    outcome="unsupported",
                    tag=tag,
                    external_chat_id=external_chat_id,
                    reason="shared-bot-transport-unavailable",
                )

            try:
                await self._transport.relay_raw_node(decision.node)
            except Exception as exc:
                await record_channel_debug_event(
                    db,
                    account=account,
                    user_id=account.user_id,
                    provider=CHANNEL_PROVIDER_WHATSAPP,
                    direction="agent",
                    stage="outbound_relay",
                    outcome="failed",
                    external_chat_id=external_chat_id,
                    details={**details, "errorType": exc.__class__.__name__},
                )
                await db.commit()
                return WhatsAppSharedBotRawRelayResult(
                    outcome="failed",
                    tag=tag,
                    external_chat_id=external_chat_id,
                    reason=exc.__class__.__name__,
                )

            await record_channel_debug_event(
                db,
                account=account,
                user_id=account.user_id,
                provider=CHANNEL_PROVIDER_WHATSAPP,
                direction="agent",
                stage="outbound_relay",
                outcome="relayed",
                external_chat_id=external_chat_id,
                details=details,
            )
            await db.commit()
            return WhatsAppSharedBotRawRelayResult(
                outcome="relayed",
                tag=tag,
                external_chat_id=external_chat_id,
            )

    async def forward_iq(self, node: BinaryNode, tenant_id: str | None) -> BinaryNode | None:
        del tenant_id
        if self._transport is None:
            return None
        if self._forward_iq_inflight >= 5:
            return None
        self._forward_iq_inflight += 1
        try:
            return await forward_iq_over(_maybe_query_iq(self._transport), node)
        finally:
            self._forward_iq_inflight -= 1


async def _load_active_whatsapp_account(
    db: AsyncSession,
    *,
    account_id: UUID,
) -> ChannelAccount:
    result = await db.execute(
        select(ChannelAccount).where(
            ChannelAccount.id == account_id,
            ChannelAccount.provider == CHANNEL_PROVIDER_WHATSAPP,
            ChannelAccount.archived_at.is_(None),
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
        )
    )
    account = result.scalar_one_or_none()
    if account is None:
        raise ValueError("whatsapp shared runtime account is unavailable")
    return account


def _outbound_debug_details(message: WhatsAppOutboundMessage) -> dict[str, str | int]:
    return {
        "runtime": WHATSAPP_SHARED_RUNTIME_BAILEYS_WEBSOCKET,
        "sharedRuntime": WHATSAPP_SHARED_RUNTIME_CLAWDI_OUTBOX,
        "providerMessageId": message.message_id,
        "protoBytes": len(message.message_proto),
        "protoSha256": hashlib.sha256(message.message_proto).hexdigest(),
        "encType": message.enc_type,
    }


async def _build_bound_jid_resolver(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    node: BinaryNode,
) -> Callable[[str], str | None]:
    attrs = _node_attrs(node)
    candidates = [attrs.get("to"), attrs.get("recipient")]
    resolved: dict[str, str | None] = {}
    for candidate in candidates:
        if not candidate or candidate in resolved:
            continue
        binding = await find_binding(db, account=account, external_chat_id=candidate)
        resolved[candidate] = binding.external_chat_id if binding is not None else None
    return resolved.get


def _raw_relay_debug_details(node: BinaryNode) -> dict[str, Any]:
    attrs = _node_attrs(node)
    return {
        "runtime": WHATSAPP_SHARED_RUNTIME_BAILEYS_WEBSOCKET,
        "sharedRuntime": WHATSAPP_SHARED_RUNTIME_CLAWDI_OUTBOX,
        "tag": str(node.get("tag") or ""),
        "to": attrs.get("to"),
        "recipient": attrs.get("recipient"),
        "id": attrs.get("id"),
        "type": attrs.get("type"),
        "children": _child_tags(node),
    }


def _node_attrs(node: BinaryNode) -> dict[str, str]:
    attrs = node.get("attrs")
    if not isinstance(attrs, dict):
        return {}
    return {str(key): str(value) for key, value in attrs.items()}


def _child_tags(node: BinaryNode) -> list[str]:
    content = node.get("content")
    if not isinstance(content, list):
        return []
    return [
        str(child.get("tag"))
        for child in content
        if isinstance(child, dict) and child.get("tag") is not None
    ]


def _requires_native_outbound_chat(to_jid: str) -> bool:
    return to_jid.endswith("@g.us")


def _native_outbound_attr_reason(attrs: dict[str, str]) -> str | None:
    extra_attrs = {
        key: value
        for key, value in attrs.items()
        if key not in {"id", "to", "from", "type", "recipient", "participant"} and value
    }
    if not extra_attrs:
        return None
    return "baileys-relay-attrs-required"


def _has_whatsapp_cloud_media_reupload_config(account: ChannelAccount) -> bool:
    return (
        account.encrypted_provider_token is not None
        and account.provider_token_nonce is not None
        and _account_config_str(account, "phone_number_id") is not None
    )


def _transport_connected(transport: WhatsAppSharedBotTransport) -> bool:
    try:
        connected = getattr(transport, "connected")
    except AttributeError:
        return True
    except Exception:
        return False
    if isinstance(connected, bool):
        return connected
    return True


def _transport_mode(
    transport: WhatsAppSharedBotTransport,
) -> Literal["in_process", "sidecar"]:
    mode = getattr(transport, "transport_mode", "in_process")
    return "sidecar" if mode == "sidecar" else "in_process"


async def _cloud_raw_relay_from_node(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    node: BinaryNode,
) -> _WhatsAppCloudRawRelay | None:
    attrs = _node_attrs(node)
    tag = str(node.get("tag") or "")
    to_jid = attrs.get("to")

    if tag == "receipt" and attrs.get("type") == "read" and _is_cloud_private_jid(to_jid):
        message_ids = tuple(_receipt_message_ids(node))
        if not message_ids:
            return None
        return _WhatsAppCloudRawRelay(
            kind="receipt_read",
            payloads=tuple(
                {
                    "messaging_product": "whatsapp",
                    "status": "read",
                    "message_id": message_id,
                }
                for message_id in message_ids
            ),
        )

    if tag == "chatstate" and _is_composing_chatstate(node) and _is_cloud_private_jid(to_jid):
        latest_message_id = await _latest_inbound_provider_message_id(
            db,
            account=account,
            external_chat_id=str(to_jid),
        )
        if latest_message_id is None:
            return None
        return _WhatsAppCloudRawRelay(
            kind="typing_indicator",
            payloads=(
                {
                    "messaging_product": "whatsapp",
                    "status": "read",
                    "message_id": latest_message_id,
                    "typing_indicator": {"type": "text"},
                },
            ),
        )

    return None


async def _send_whatsapp_cloud_raw_relay(
    account: ChannelAccount,
    relay: _WhatsAppCloudRawRelay,
) -> None:
    token = decrypt_provider_token(account)
    phone_number_id = _account_config_str(account, "phone_number_id")
    if phone_number_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="whatsapp phone_number_id is required for cloud relay",
        )
    base_url = (
        _account_config_str(account, "graph_api_base_url")
        or settings.channel_whatsapp_graph_api_base_url.strip()
    )
    url = f"{base_url.rstrip('/')}/{phone_number_id}/messages"
    try:
        await validate_channel_http_url(url, label="whatsapp graph relay url")
    except UnsafeOutboundUrlError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            for payload in relay.payloads:
                response = await client.post(
                    url,
                    headers={"Authorization": f"Bearer {token}"},
                    json=payload,
                )
                if response.status_code >= 400:
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail="whatsapp cloud relay rejected node",
                    )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="whatsapp cloud relay unreachable",
        ) from exc


async def _latest_inbound_provider_message_id(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
) -> str | None:
    result = await db.execute(
        select(ChannelMessage.provider_message_id)
        .where(
            ChannelMessage.account_id == account.id,
            ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
            ChannelMessage.external_chat_id == external_chat_id,
            ChannelMessage.provider_message_id.is_not(None),
        )
        .order_by(ChannelMessage.created_at.desc(), ChannelMessage.id.desc())
        .limit(1)
    )
    value = result.scalar_one_or_none()
    return str(value) if value else None


def _receipt_message_ids(node: BinaryNode) -> list[str]:
    ids: list[str] = []
    root_id = _node_attrs(node).get("id")
    if root_id:
        ids.append(root_id)
    content = node.get("content")
    if not isinstance(content, list):
        return ids
    for child in content:
        if not isinstance(child, dict) or child.get("tag") != "list":
            continue
        child_content = child.get("content")
        if not isinstance(child_content, list):
            continue
        for item in child_content:
            if not isinstance(item, dict) or item.get("tag") != "item":
                continue
            item_id = _node_attrs(item).get("id")
            if item_id:
                ids.append(item_id)
    return ids


def _is_composing_chatstate(node: BinaryNode) -> bool:
    if _node_attrs(node).get("type") == "composing":
        return True
    content = node.get("content")
    if not isinstance(content, list):
        return False
    return any(isinstance(child, dict) and child.get("tag") == "composing" for child in content)


def _is_cloud_private_jid(value: str | None) -> bool:
    if value is None:
        return False
    if value.endswith("@g.us") or value.endswith("@lid"):
        return False
    return value.endswith("@s.whatsapp.net") or value.endswith("@c.us")


def _account_config_str(account: ChannelAccount, key: str) -> str | None:
    config = account.config
    if not isinstance(config, dict):
        return None
    value = config.get(key)
    return value if isinstance(value, str) and value else None


def _http_exception_detail(exc: HTTPException) -> str:
    return exc.detail if isinstance(exc.detail, str) else str(exc.detail)


def _maybe_query_iq(
    transport: WhatsAppSharedBotTransport,
) -> Callable[[BinaryNode, int], Awaitable[BinaryNode | None]]:
    async def query(node: BinaryNode, timeout_ms: int) -> BinaryNode | None:
        return await transport.query_iq(node, timeout_ms)

    return query


def _native_outbound_relay(
    transport: WhatsAppSharedBotTransport | None,
) -> Callable[[WhatsAppOutboundMessage], Awaitable[None]] | None:
    if transport is None:
        return None
    relay = getattr(transport, "relay_outbound_message", None)
    if not callable(relay):
        return None
    return relay
