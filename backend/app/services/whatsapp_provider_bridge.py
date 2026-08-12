from __future__ import annotations

import base64
import hashlib
import secrets
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Literal, Protocol, TypeGuard
from uuid import UUID

from fastapi import HTTPException, status
from pydantic import JsonValue, TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_STATUS_ACTIVE,
    CHANNEL_VISIBILITY_PRIVATE,
    PROVIDER_EVENT_SCOPE_ACCOUNT,
    ChannelAccount,
    ChannelBinding,
    ChannelBindingAlias,
)
from app.services.channel_debug_events import record_channel_debug_event
from app.services.channels import (
    channel_control_command_event_was_handled,
    enqueue_channel_outbound_message,
    find_binding,
    find_existing_inbound_provider_event,
    lock_active_binding_authority,
    lock_active_link_authority,
    parse_channel_control_command,
    record_inbound_messages_for_bindings,
    require_channel_tenant_user_id,
    resolve_inbound_binding,
    send_control_command_reply,
)
from app.services.whatsapp_baileys import (
    BinaryNode,
    choose_whatsapp_route_jid,
    decide_whatsapp_relay,
    forward_iq_over,
    parse_whatsapp_jid,
    parse_whatsapp_usync_device_targets,
    remember_whatsapp_binding_aliases,
    resolve_whatsapp_binding_by_jids,
    strip_whatsapp_device,
    validate_relay_outbound_additional_nodes,
    whatsapp_text_from_message_proto,
    whatsapp_text_message_proto,
    whatsapp_usync_device_result,
)
from app.services.whatsapp_native_transport import WhatsAppProviderMessageEvent
from app.services.whatsapp_runtime_types import WhatsAppOutboundMessage

WHATSAPP_PROVIDER_PAYLOAD_SCHEMA = "clawdi.whatsappBaileysProviderMessage.v1"
_PROVIDER_PAYLOAD_ADAPTER: TypeAdapter[dict[str, JsonValue]] = TypeAdapter(dict[str, JsonValue])


@dataclass(frozen=True)
class WhatsAppProviderRelayResult:
    outcome: Literal["queued", "relayed", "unsupported", "failed"]
    external_chat_id: str
    provider_message_id: str
    channel_message_id: UUID | None = None
    delivery_id: UUID | None = None
    reason: str | None = None


@dataclass(frozen=True)
class WhatsAppProviderNodeRelayResult:
    outcome: Literal["relayed", "dropped", "unsupported", "failed"]
    tag: str
    external_chat_id: str | None = None
    reason: str | None = None


@dataclass(frozen=True)
class WhatsAppProviderTransportStatus:
    available: bool
    mode: Literal["in_process", "sidecar", "none"]
    reason: str | None
    supports_outbound_messages: bool
    supports_raw_relay: bool
    supports_iq_queries: bool

    def as_dict(self) -> dict[str, JsonValue]:
        return {
            "available": self.available,
            "mode": self.mode,
            "reason": self.reason,
            "supportsOutboundMessages": self.supports_outbound_messages,
            "supportsRawRelay": self.supports_raw_relay,
            "supportsIqQueries": self.supports_iq_queries,
        }


class WhatsAppProviderTransport(Protocol):
    async def relay_outbound_message(self, message: WhatsAppOutboundMessage) -> str | None: ...

    async def relay_raw_node(self, node: BinaryNode) -> None: ...

    async def query_iq(
        self,
        node: BinaryNode,
        timeout_ms: int,
    ) -> BinaryNode | None: ...


_PROVIDER_TRANSPORTS: dict[UUID, WhatsAppProviderTransport] = {}


class WhatsAppProviderAccountRetired(Exception):
    """The ingress owner is no longer active; reconciliation may reattach it."""


def register_whatsapp_provider_transport(
    account_id: UUID,
    transport: WhatsAppProviderTransport,
) -> None:
    """Register the one physical upstream transport for an account."""

    if account_id in _PROVIDER_TRANSPORTS:
        raise RuntimeError(f"WhatsApp provider transport already registered for {account_id}")
    _PROVIDER_TRANSPORTS[account_id] = transport


def unregister_whatsapp_provider_transport(account_id: UUID) -> None:
    _PROVIDER_TRANSPORTS.pop(account_id, None)


def get_whatsapp_provider_transport(account_id: UUID) -> WhatsAppProviderTransport | None:
    return _PROVIDER_TRANSPORTS.get(account_id)


def whatsapp_provider_transport_status(account_id: UUID) -> WhatsAppProviderTransportStatus:
    transport = get_whatsapp_provider_transport(account_id)
    if transport is None:
        return WhatsAppProviderTransportStatus(
            available=False,
            mode="none",
            reason="provider-transport-unavailable",
            supports_outbound_messages=False,
            supports_raw_relay=False,
            supports_iq_queries=False,
        )
    connected = _transport_connected(transport)
    return WhatsAppProviderTransportStatus(
        available=connected,
        mode=_transport_mode(transport),
        reason=None if connected else "provider-transport-disconnected",
        supports_outbound_messages=callable(getattr(transport, "relay_outbound_message", None)),
        supports_raw_relay=callable(getattr(transport, "relay_raw_node", None)),
        supports_iq_queries=callable(getattr(transport, "query_iq", None)),
    )


class WhatsAppProviderBridge:
    """Authorize synthetic Noise traffic and hand it to the physical transport."""

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        account_id: UUID,
        transport: WhatsAppProviderTransport | None = None,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._account_id = account_id
        self._transport_override = transport
        self._forward_iq_inflight = 0

    def _transport(self) -> WhatsAppProviderTransport | None:
        return self._transport_override or get_whatsapp_provider_transport(self._account_id)

    async def store_outbound_message(
        self,
        message: WhatsAppOutboundMessage,
        *,
        bot_agent_link_id: UUID,
    ) -> WhatsAppProviderRelayResult:
        async with self._sessionmaker() as db:
            account = await _load_active_whatsapp_account(db, account_id=self._account_id)
            queued, delivery = await enqueue_channel_outbound_message(
                db,
                account=account,
                external_chat_id=message.to_jid,
                text=message.conversation or "",
                bot_agent_link_id=bot_agent_link_id,
            )
            details = _outbound_debug_details(message)
            payload = dict(queued.payload or {})
            payload["providerPayload"] = _provider_payload_from_outbound(message)
            queued.payload = payload
            await record_channel_debug_event(
                db,
                account=account,
                user_id=queued.user_id,
                provider=CHANNEL_PROVIDER_WHATSAPP,
                direction="agent",
                stage="outbound_delivery",
                outcome="queued",
                external_chat_id=message.to_jid,
                details={
                    **details,
                    "deliveryId": str(delivery.id),
                    "channelMessageId": str(queued.id),
                },
            )
            await db.commit()
            return WhatsAppProviderRelayResult(
                outcome="queued",
                external_chat_id=message.to_jid,
                provider_message_id=message.message_id,
                channel_message_id=queued.id,
                delivery_id=delivery.id,
            )

    async def relay_raw_node(
        self,
        node: BinaryNode,
        lookup_inbound_sender: Callable[[str], str | None],
        *,
        bot_agent_link_id: UUID,
    ) -> WhatsAppProviderNodeRelayResult:
        attrs = _node_attrs(node)
        tag = str(node.get("tag") or "")
        external_chat_id = attrs.get("to") or attrs.get("recipient")
        async with self._sessionmaker() as db:
            account = await _load_active_whatsapp_account(db, account_id=self._account_id)
            link = await lock_active_link_authority(
                db,
                account=account,
                bot_agent_link_id=bot_agent_link_id,
            )
            if link is None:
                return WhatsAppProviderNodeRelayResult(
                    outcome="dropped",
                    tag=tag,
                    external_chat_id=external_chat_id,
                    reason="link-authority-missing",
                )
            tenant_user_id = link.user_id
            resolve_jid = await _build_bound_jid_resolver(
                db,
                account=account,
                node=node,
                bot_agent_link_id=bot_agent_link_id,
            )
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
                    user_id=tenant_user_id,
                    provider=CHANNEL_PROVIDER_WHATSAPP,
                    direction="agent",
                    stage="outbound_relay",
                    outcome="dropped",
                    external_chat_id=external_chat_id,
                    details={**details, "reason": decision.reason or "unknown"},
                )
                await db.commit()
                return WhatsAppProviderNodeRelayResult(
                    outcome="dropped",
                    tag=tag,
                    external_chat_id=external_chat_id,
                    reason=decision.reason,
                )

            transport = self._transport()
            if transport is None:
                await record_channel_debug_event(
                    db,
                    account=account,
                    user_id=tenant_user_id,
                    provider=CHANNEL_PROVIDER_WHATSAPP,
                    direction="agent",
                    stage="outbound_relay",
                    outcome="unsupported",
                    external_chat_id=external_chat_id,
                    details={**details, "reason": "provider-transport-unavailable"},
                )
                await db.commit()
                return WhatsAppProviderNodeRelayResult(
                    outcome="unsupported",
                    tag=tag,
                    external_chat_id=external_chat_id,
                    reason="provider-transport-unavailable",
                )

            try:
                await transport.relay_raw_node(decision.node)
            except Exception as exc:
                await record_channel_debug_event(
                    db,
                    account=account,
                    user_id=tenant_user_id,
                    provider=CHANNEL_PROVIDER_WHATSAPP,
                    direction="agent",
                    stage="outbound_relay",
                    outcome="failed",
                    external_chat_id=external_chat_id,
                    details={**details, "errorType": exc.__class__.__name__},
                )
                await db.commit()
                return WhatsAppProviderNodeRelayResult(
                    outcome="failed",
                    tag=tag,
                    external_chat_id=external_chat_id,
                    reason=exc.__class__.__name__,
                )

            await record_channel_debug_event(
                db,
                account=account,
                user_id=tenant_user_id,
                provider=CHANNEL_PROVIDER_WHATSAPP,
                direction="agent",
                stage="outbound_relay",
                outcome="relayed",
                external_chat_id=external_chat_id,
                details=details,
            )
            await db.commit()
            return WhatsAppProviderNodeRelayResult(
                outcome="relayed",
                tag=tag,
                external_chat_id=external_chat_id,
            )

    async def forward_iq(
        self,
        node: BinaryNode,
        tenant_id: str | None,
        *,
        bot_agent_link_id: UUID,
        self_lid: str | None = None,
    ) -> BinaryNode | None:
        if tenant_id != str(bot_agent_link_id):
            return None
        async with self._sessionmaker() as db:
            account = await _load_active_whatsapp_account(db, account_id=self._account_id)
            usync_targets = parse_whatsapp_usync_device_targets(node)
            if usync_targets is not None:
                usync_lids = await _authorized_usync_target_lids(
                    db,
                    account=account,
                    targets=usync_targets,
                    bot_agent_link_id=bot_agent_link_id,
                    self_lid=self_lid,
                )
                if usync_lids is None:
                    return None
                return whatsapp_usync_device_result(
                    node,
                    target_lids=usync_lids,
                    self_lid=self_lid,
                )
            if _is_authorized_provider_service_iq(node):
                if not await _active_link_owns_account(
                    db,
                    account=account,
                    bot_agent_link_id=bot_agent_link_id,
                ):
                    return None
            else:
                resolve_jid = await _build_bound_jid_resolver(
                    db,
                    account=account,
                    node=node,
                    bot_agent_link_id=bot_agent_link_id,
                )
                targets = _node_target_jids(node)
                if not targets or any(resolve_jid(target) is None for target in targets):
                    return None
            transport = self._transport()
            forwarded: BinaryNode | None = None
            if transport is not None and self._forward_iq_inflight < 5:
                self._forward_iq_inflight += 1
                try:
                    forwarded = await forward_iq_over(_query_iq(transport), node)
                finally:
                    self._forward_iq_inflight -= 1
            if forwarded is not None:
                return forwarded
            return None

    async def resolve_recipient_lid(
        self,
        jid: str,
        *,
        bot_agent_link_id: UUID,
    ) -> str | None:
        async with self._sessionmaker() as db:
            account = await _load_active_whatsapp_account(db, account_id=self._account_id)
            recipient_lids = await _authorized_usync_target_lids(
                db,
                account=account,
                targets=(jid,),
                bot_agent_link_id=bot_agent_link_id,
            )
            return recipient_lids.get(jid) if recipient_lids is not None else None


async def relay_whatsapp_provider_payload(
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    provider_payload: object | None,
) -> tuple[str | None, dict[str, JsonValue]]:
    transport = get_whatsapp_provider_transport(account.id)
    if transport is None or not _transport_connected(transport):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="whatsapp provider transport unavailable",
        )
    message = _outbound_from_provider_payload(
        external_chat_id=external_chat_id,
        text=text,
        provider_payload=provider_payload,
    )
    try:
        relayed_message_id = await transport.relay_outbound_message(message)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="whatsapp provider transport rejected message",
        ) from exc
    message_id = relayed_message_id or message.message_id
    return message_id, {
        "transport": "baileys",
        "messageId": message_id,
        "protoSha256": hashlib.sha256(message.message_proto).hexdigest(),
    }


async def persist_whatsapp_provider_event(
    db: AsyncSession,
    *,
    account_id: UUID,
    event: WhatsAppProviderMessageEvent,
) -> None:
    account = await _load_active_whatsapp_account(db, account_id=account_id)
    if (
        await find_existing_inbound_provider_event(
            db,
            account=account,
            external_chat_id=event.remote_jid,
            provider_event_id=event.message_id,
            provider_event_scope=PROVIDER_EVENT_SCOPE_ACCOUNT,
        )
        is not None
    ):
        return
    remote_jid = event.remote_jid
    alt_jid = event.remote_jid_alt
    route_jid = choose_whatsapp_route_jid(remote_jid, alt_jid)
    external_chat_id = route_jid
    external_chat_type = "group" if route_jid.endswith("@g.us") else "dm"
    external_chat_name = event.push_name
    binding_lookup = await resolve_whatsapp_binding_by_jids(
        db,
        account=account,
        remote_jid=remote_jid,
        alt_jid=alt_jid,
    )
    if binding_lookup.conflict:
        if account.visibility == CHANNEL_VISIBILITY_PRIVATE:
            await record_channel_debug_event(
                db,
                account=account,
                user_id=require_channel_tenant_user_id(account),
                provider=CHANNEL_PROVIDER_WHATSAPP,
                direction="inbound",
                stage="provider_ingress",
                outcome="dropped",
                external_chat_id=route_jid,
                details={"reason": "binding-alias-conflict", "messageId": event.message_id},
            )
        await db.commit()
        return
    existing_binding = binding_lookup.binding
    if existing_binding is not None:
        external_chat_id = existing_binding.external_chat_id
        external_chat_type = existing_binding.external_chat_type
        external_chat_name = existing_binding.external_chat_name
    text = whatsapp_text_from_message_proto(event.message_proto)
    command = parse_channel_control_command(text)
    if await channel_control_command_event_was_handled(
        db,
        account=account,
        external_chat_id=external_chat_id,
        provider_event_id=event.message_id,
        provider_event_scope=PROVIDER_EVENT_SCOPE_ACCOUNT,
        command=command,
    ):
        return
    external_user_id = event.participant or event.participant_alt
    if external_user_id is None and external_chat_type == "dm":
        external_user_id = route_jid
    binding_result = await resolve_inbound_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        external_chat_type=external_chat_type,
        external_chat_name=external_chat_name,
        external_user_id=external_user_id,
        text=text,
        command=command,
    )
    payload = _provider_event_payload(event)
    messages = await record_inbound_messages_for_bindings(
        db,
        account=account,
        binding_result=binding_result,
        external_chat_id=external_chat_id,
        provider_message_id=event.message_id,
        text=text,
        payload=payload,
        provider_event_scope=PROVIDER_EVENT_SCOPE_ACCOUNT,
        require_active_authority=not binding_result.command_handled,
    )
    for _message, binding in messages:
        if binding is not None:
            await remember_whatsapp_binding_aliases(
                db,
                binding=binding,
                remote_jid=remote_jid,
                alt_jid=alt_jid,
            )
    await db.commit()
    reply = await send_control_command_reply(
        db,
        account=account,
        external_chat_id=external_chat_id,
        command=command,
        binding_result=binding_result,
    )
    if reply is not None:
        await db.commit()


async def _load_active_whatsapp_account(
    db: AsyncSession,
    *,
    account_id: UUID,
) -> ChannelAccount:
    account = (
        await db.execute(
            select(ChannelAccount).where(
                ChannelAccount.id == account_id,
                ChannelAccount.provider == CHANNEL_PROVIDER_WHATSAPP,
                ChannelAccount.archived_at.is_(None),
                ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            )
        )
    ).scalar_one_or_none()
    if account is None:
        raise WhatsAppProviderAccountRetired
    return account


async def _active_link_owns_account(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
) -> bool:
    return (
        await lock_active_link_authority(db, account=account, bot_agent_link_id=bot_agent_link_id)
        is not None
    )


def _provider_payload_from_outbound(
    message: WhatsAppOutboundMessage,
) -> dict[str, JsonValue]:
    payload: dict[str, JsonValue] = {
        "schemaVersion": WHATSAPP_PROVIDER_PAYLOAD_SCHEMA,
        "messageId": message.message_id,
        "messageProtoBase64": base64.b64encode(message.message_proto).decode("ascii"),
        "encType": message.enc_type,
        "attrs": dict(message.attrs),
    }
    additional_nodes = validate_relay_outbound_additional_nodes(message.additional_nodes)
    if additional_nodes:
        payload["additionalNodes"] = [{"tag": "meta", "attrs": {"polltype": "creation"}}]
    return payload


def _outbound_from_provider_payload(
    *,
    external_chat_id: str,
    text: str,
    provider_payload: object | None,
) -> WhatsAppOutboundMessage:
    if provider_payload is None:
        message_id = secrets.token_hex(10).upper()
        return WhatsAppOutboundMessage(
            to_jid=external_chat_id,
            message_id=message_id,
            message_proto=whatsapp_text_message_proto(text),
            enc_type="msg",
            attrs={"id": message_id, "to": external_chat_id},
            conversation=text,
        )
    try:
        payload = _PROVIDER_PAYLOAD_ADAPTER.validate_python(provider_payload, strict=True)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid whatsapp provider payload",
        ) from exc
    if payload.get("schemaVersion") != WHATSAPP_PROVIDER_PAYLOAD_SCHEMA:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid whatsapp provider payload schema",
        )
    message_id = _required_payload_str(payload, "messageId")
    raw_proto = _required_payload_str(payload, "messageProtoBase64")
    try:
        message_proto = base64.b64decode(raw_proto, validate=True)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid whatsapp provider message proto",
        ) from exc
    if not message_proto:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid whatsapp provider message proto",
        )
    enc_type = payload.get("encType")
    if enc_type == "pkmsg":
        normalized_enc_type: Literal["pkmsg", "msg", "skmsg"] = "pkmsg"
    elif enc_type == "msg":
        normalized_enc_type = "msg"
    elif enc_type == "skmsg":
        normalized_enc_type = "skmsg"
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid whatsapp provider encryption type",
        )
    raw_attrs = payload.get("attrs")
    if not isinstance(raw_attrs, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid whatsapp provider message attributes",
        )
    attrs: dict[str, str] = {}
    for key, value in raw_attrs.items():
        if not isinstance(value, str):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="invalid whatsapp provider message attributes",
            )
        attrs[key] = value
    if attrs.get("to") not in {None, external_chat_id}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="whatsapp provider payload target mismatch",
        )
    attrs["to"] = external_chat_id
    attrs["id"] = message_id
    try:
        additional_nodes = validate_relay_outbound_additional_nodes(payload.get("additionalNodes"))
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid whatsapp provider additional nodes",
        ) from exc
    return WhatsAppOutboundMessage(
        to_jid=external_chat_id,
        message_id=message_id,
        message_proto=message_proto,
        enc_type=normalized_enc_type,
        attrs=attrs,
        conversation=text or None,
        additional_nodes=additional_nodes,
    )


def _provider_event_payload(event: WhatsAppProviderMessageEvent) -> dict[str, JsonValue]:
    key: dict[str, JsonValue] = {
        "id": event.message_id,
        "remoteJid": event.remote_jid,
        "fromMe": False,
    }
    if event.remote_jid_alt:
        key["remoteJidAlt"] = event.remote_jid_alt
    if event.participant:
        key["participant"] = event.participant
    if event.participant_alt:
        key["participantAlt"] = event.participant_alt
    payload: dict[str, JsonValue] = {
        "schemaVersion": "clawdi.whatsappBaileysProviderEvent.v1",
        "key": key,
        "messageProtoBase64": base64.b64encode(event.message_proto).decode("ascii"),
    }
    if event.push_name:
        payload["pushName"] = event.push_name
    if event.message_timestamp:
        payload["messageTimestamp"] = event.message_timestamp
    return payload


def _required_payload_str(payload: Mapping[str, JsonValue], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"invalid whatsapp provider payload {key}",
        )
    return value


def _outbound_debug_details(message: WhatsAppOutboundMessage) -> dict[str, str | int]:
    return {
        "runtime": "baileys_noise",
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
    bot_agent_link_id: UUID,
) -> Callable[[str], str | None]:
    candidate_bindings: dict[str, ChannelBinding | None] = {}
    bindings: dict[UUID, ChannelBinding] = {}
    candidates = _node_target_jids(node)
    for candidate in candidates:
        binding = await find_binding(
            db,
            account=account,
            external_chat_id=candidate,
            bot_agent_link_id=bot_agent_link_id,
        )
        if binding is not None:
            bindings[binding.id] = binding
        candidate_bindings[candidate] = binding
    authorized: dict[UUID, ChannelBinding] = {}
    for binding_id in sorted(bindings, key=str):
        binding = bindings[binding_id]
        leased = await lock_active_binding_authority(
            db,
            account=account,
            binding=binding,
            bot_agent_link_id=bot_agent_link_id,
        )
        if leased is not None:
            authorized[binding_id] = leased
    resolved: dict[str, str | None] = {}
    for candidate, binding in candidate_bindings.items():
        resolved[candidate] = (
            authorized[binding.id].external_chat_id
            if binding is not None and binding.id in authorized
            else None
        )
    return resolved.get


async def _authorized_usync_target_lids(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    targets: tuple[str, ...],
    bot_agent_link_id: UUID,
    self_lid: str | None = None,
) -> dict[str, str] | None:
    normalized_self_lid = strip_whatsapp_device(self_lid) if self_lid is not None else None
    resolved: dict[str, str] = {}
    target_bindings: dict[str, ChannelBinding] = {}
    bindings: dict[UUID, ChannelBinding] = {}
    for target in targets:
        if normalized_self_lid is not None and strip_whatsapp_device(target) == normalized_self_lid:
            resolved[target] = normalized_self_lid
            continue
        binding = await find_binding(
            db,
            account=account,
            external_chat_id=target,
            bot_agent_link_id=bot_agent_link_id,
        )
        if binding is None:
            return None
        target_bindings[target] = binding
        bindings[binding.id] = binding

    if resolved and not await _active_link_owns_account(
        db,
        account=account,
        bot_agent_link_id=bot_agent_link_id,
    ):
        return None

    authorized: dict[UUID, ChannelBinding] = {}
    for binding_id in sorted(bindings, key=str):
        binding = await lock_active_binding_authority(
            db,
            account=account,
            binding=bindings[binding_id],
            bot_agent_link_id=bot_agent_link_id,
        )
        if binding is None:
            return None
        authorized[binding_id] = binding

    aliases_result = await db.execute(
        select(ChannelBindingAlias).where(
            ChannelBindingAlias.account_id == account.id,
            ChannelBindingAlias.bot_agent_link_id == bot_agent_link_id,
            ChannelBindingAlias.binding_id.in_(authorized),
        )
    )
    identifiers: dict[UUID, set[str]] = {
        binding_id: {strip_whatsapp_device(binding.external_chat_id)}
        for binding_id, binding in authorized.items()
    }
    for alias in aliases_result.scalars():
        identifiers[alias.binding_id].add(strip_whatsapp_device(alias.alias_external_chat_id))

    for target, binding in target_bindings.items():
        target_jid = strip_whatsapp_device(target)
        binding_identifiers = identifiers[binding.id]
        if target_jid not in binding_identifiers:
            return None
        lids = {
            identifier
            for identifier in binding_identifiers
            if (parsed := parse_whatsapp_jid(identifier)) is not None and parsed.server == "lid"
        }
        if len(lids) != 1:
            return None
        lid = lids.pop()
        target_parsed = parse_whatsapp_jid(target_jid)
        lid_parsed = parse_whatsapp_jid(lid)
        if target_parsed is None or lid_parsed is None:
            return None
        # A PN inferred by replacing "@lid" with "@s.whatsapp.net" is not an
        # observed alias. Refuse that same-number pair instead of guessing it.
        if target_parsed.server == "s.whatsapp.net" and target_parsed.user == lid_parsed.user:
            return None
        resolved[target] = lid
    return resolved


def _node_target_jids(node: BinaryNode) -> tuple[str, ...]:
    attrs = _node_attrs(node)
    return tuple(
        dict.fromkeys(target for key in ("to", "recipient", "jid") if (target := attrs.get(key)))
    )


def _is_authorized_provider_service_iq(node: BinaryNode) -> bool:
    if node.get("tag") != "iq" or set(node).difference({"tag", "attrs", "content"}):
        return False
    attrs = _strict_string_dict(node.get("attrs"))
    if attrs is None:
        return False
    if set(attrs) != {"id", "type", "xmlns", "to"} or not attrs["id"]:
        return False
    iq_type = attrs.get("type")
    xmlns = attrs.get("xmlns")
    target = attrs.get("to")
    if iq_type is None or xmlns is None or target is None:
        return False
    expected_child = {
        ("set", "w:m", "s.whatsapp.net"): "media_conn",
        ("get", "privacy", "s.whatsapp.net"): "privacy",
    }.get((iq_type, xmlns, target))
    content: object = node.get("content")
    if expected_child is None or not _is_object_list(content) or len(content) != 1:
        return False
    child = content[0]
    return (
        _is_object_dict(child)
        and not set(child).difference({"tag", "attrs", "content"})
        and child.get("tag") == expected_child
        and child.get("attrs") == {}
        and child.get("content") is None
    )


def _raw_relay_debug_details(node: BinaryNode) -> dict[str, JsonValue]:
    attrs = _node_attrs(node)
    return {
        "runtime": "baileys_noise",
        "tag": str(node.get("tag") or ""),
        "to": attrs.get("to"),
        "recipient": attrs.get("recipient"),
        "id": attrs.get("id"),
        "type": attrs.get("type"),
    }


def _node_attrs(node: BinaryNode) -> dict[str, str]:
    attrs: object = node.get("attrs")
    if not _is_object_dict(attrs):
        return {}
    return {str(key): str(value) for key, value in attrs.items()}


def _is_object_dict(value: object) -> TypeGuard[dict[object, object]]:
    return isinstance(value, dict)


def _is_object_list(value: object) -> TypeGuard[list[object]]:
    return isinstance(value, list)


def _strict_string_dict(value: object) -> dict[str, str] | None:
    if not _is_object_dict(value):
        return None
    result: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not isinstance(item, str):
            return None
        result[key] = item
    return result


def _transport_connected(transport: WhatsAppProviderTransport) -> bool:
    try:
        connected = getattr(transport, "connected")
    except AttributeError:
        return True
    except Exception:
        return False
    return connected if isinstance(connected, bool) else True


def _transport_mode(
    transport: WhatsAppProviderTransport,
) -> Literal["in_process", "sidecar"]:
    mode = getattr(transport, "transport_mode", "in_process")
    return "sidecar" if mode == "sidecar" else "in_process"


def _query_iq(
    transport: WhatsAppProviderTransport,
) -> Callable[[BinaryNode, int], Awaitable[BinaryNode | None]]:
    async def query(node: BinaryNode, timeout_ms: int) -> BinaryNode | None:
        return await transport.query_iq(node, timeout_ms)

    return query
