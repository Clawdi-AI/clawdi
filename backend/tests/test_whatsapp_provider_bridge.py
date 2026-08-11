from __future__ import annotations

import asyncio
import base64
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.channel import (
    BINDING_STATUS_ARCHIVED,
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_VISIBILITY_PRIVATE,
    CHANNEL_VISIBILITY_PUBLIC,
    MESSAGE_DIRECTION_INBOUND,
    MESSAGE_DIRECTION_OUTBOUND,
    ChannelAccount,
    ChannelBinding,
    ChannelBindingAlias,
    ChannelBotAgentLink,
    ChannelDelivery,
    ChannelMessage,
    ChannelPairCode,
)
from app.services.channel_delivery_worker import ChannelDeliveryWorker
from app.services.channels import (
    archive_bot_agent_link,
    build_channel_account,
    channel_control_help_reply,
    enqueue_channel_outbound_message,
    generate_agent_token,
    hash_token,
    send_whatsapp_message,
    store_agent_link_token,
)
from app.services.whatsapp_baileys import (
    remember_whatsapp_binding_aliases,
    resolve_whatsapp_binding_by_jids,
    whatsapp_text_message_proto,
)
from app.services.whatsapp_native_transport import WhatsAppProviderMessageEvent
from app.services.whatsapp_noise import WhatsAppOutboundMessage
from app.services.whatsapp_provider_bridge import (
    WHATSAPP_PROVIDER_PAYLOAD_SCHEMA,
    WhatsAppProviderBridge,
    persist_whatsapp_provider_event,
    register_whatsapp_provider_transport,
    relay_whatsapp_provider_payload,
    unregister_whatsapp_provider_transport,
    whatsapp_provider_transport_status,
)

pytestmark = [pytest.mark.usefixtures("channel_agent"), pytest.mark.committed_db]


class _FakeProviderTransport:
    connected = True

    def __init__(self) -> None:
        self.outbound_messages: list[WhatsAppOutboundMessage] = []
        self.raw_nodes: list[dict[str, Any]] = []
        self.iq_queries: list[tuple[dict[str, Any], int]] = []

    async def relay_outbound_message(self, message: WhatsAppOutboundMessage) -> str:
        self.outbound_messages.append(message)
        return f"physical-{message.message_id}"

    async def relay_raw_node(self, node: dict[str, Any]) -> None:
        self.raw_nodes.append(node)

    async def query_iq(
        self,
        node: dict[str, Any],
        timeout_ms: int,
    ) -> dict[str, Any]:
        self.iq_queries.append((node, timeout_ms))
        return {
            "tag": "iq",
            "attrs": {"id": "provider-id", "type": "result", "from": "s.whatsapp.net"},
            "content": [{"tag": "props", "attrs": {"hash": "abc"}}],
        }


async def _seed_whatsapp_link_and_binding(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    *,
    name: str,
    external_chat_id: str = "15551114444@s.whatsapp.net",
) -> tuple[ChannelAccount, ChannelBotAgentLink, ChannelBinding]:
    response = await client.post(
        "/v1/channels",
        json={"provider": "whatsapp", "name": name},
    )
    assert response.status_code == 201, response.text
    account = await db_session.get(ChannelAccount, UUID(response.json()["id"]))
    assert account is not None
    link = ChannelBotAgentLink(
        account_id=account.id,
        user_id=channel_agent.user_id,
        agent_id=channel_agent.id,
    )
    store_agent_link_token(link, generate_agent_token("whatsapp"))
    db_session.add(link)
    await db_session.flush()
    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=link.id,
        user_id=account.user_id,
        external_chat_id=external_chat_id,
        external_chat_type="dm",
        external_chat_name="Alice",
    )
    db_session.add(binding)
    await db_session.commit()
    return account, link, binding


def _stock_usync_device_iq(*jids: str) -> dict[str, Any]:
    return {
        "tag": "iq",
        "attrs": {
            "id": "stock-usync-devices",
            "to": "s.whatsapp.net",
            "type": "get",
            "xmlns": "usync",
        },
        "content": [
            {
                "tag": "usync",
                "attrs": {
                    "context": "message",
                    "mode": "query",
                    "sid": "stock-usync-sid",
                    "last": "true",
                    "index": "0",
                },
                "content": [
                    {
                        "tag": "query",
                        "attrs": {},
                        "content": [
                            {"tag": "devices", "attrs": {"version": "2"}},
                            {"tag": "lid", "attrs": {}},
                        ],
                    },
                    {
                        "tag": "list",
                        "attrs": {},
                        "content": [
                            {"tag": "user", "attrs": {"jid": jid}, "content": []} for jid in jids
                        ],
                    },
                ],
            }
        ],
    }


def test_whatsapp_provider_transport_registration_is_exclusive_per_account():
    account_id = uuid4()
    first = _FakeProviderTransport()
    second = _FakeProviderTransport()

    register_whatsapp_provider_transport(account_id, first)
    try:
        with pytest.raises(RuntimeError, match="already registered"):
            register_whatsapp_provider_transport(account_id, second)
        status = whatsapp_provider_transport_status(account_id)
        assert status.available is True
        assert status.mode == "in_process"
    finally:
        unregister_whatsapp_provider_transport(account_id)

    assert whatsapp_provider_transport_status(account_id).available is False


@pytest.mark.asyncio
async def test_whatsapp_provider_payload_rejects_non_json_values_before_relay():
    account_id = uuid4()
    transport = _FakeProviderTransport()
    register_whatsapp_provider_transport(account_id, transport)
    try:
        with pytest.raises(HTTPException) as exc_info:
            await relay_whatsapp_provider_payload(
                account=ChannelAccount(id=account_id),
                external_chat_id="15551114444@s.whatsapp.net",
                text="hello",
                provider_payload={
                    "schemaVersion": WHATSAPP_PROVIDER_PAYLOAD_SCHEMA,
                    "messageId": object(),
                },
            )
    finally:
        unregister_whatsapp_provider_transport(account_id)

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "invalid whatsapp provider payload"
    assert transport.outbound_messages == []


@pytest.mark.asyncio
async def test_whatsapp_provider_bridge_queues_exact_proto_before_physical_delivery(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    account, link, binding = await _seed_whatsapp_link_and_binding(
        client,
        db_session,
        channel_agent,
        name="wa-provider-durable-outbox",
    )
    transport = _FakeProviderTransport()
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    bridge = WhatsAppProviderBridge(sessionmaker, account_id=account.id)
    message_proto = b"\x32\x0c\x0a\x0aexact-edit"
    message = WhatsAppOutboundMessage(
        to_jid=binding.external_chat_id,
        message_id="agent-exact-1",
        message_proto=message_proto,
        enc_type="msg",
        attrs={
            "id": "agent-exact-1",
            "to": binding.external_chat_id,
            "edit": "8",
            "addressing_mode": "lid",
        },
        conversation="exact edit",
        additional_nodes=({"tag": "meta", "attrs": {"polltype": "creation"}},),
    )

    register_whatsapp_provider_transport(account.id, transport)
    try:
        queued = await bridge.store_outbound_message(message, bot_agent_link_id=link.id)
        assert queued.outcome == "queued"
        assert transport.outbound_messages == []

        async def allow_runtime_authority(
            _db: AsyncSession,
            *,
            link: ChannelBotAgentLink | None,
        ) -> bool:
            assert link is not None
            return True

        async def allow_provider_cardinality(
            _db: AsyncSession,
            *,
            account: ChannelAccount,
            link: ChannelBotAgentLink,
        ) -> bool:
            assert account.id == link.account_id
            return True

        monkeypatch.setattr(
            "app.services.channels.bot_agent_link_has_strict_v2_authority",
            allow_runtime_authority,
        )
        monkeypatch.setattr(
            "app.services.channels.bot_agent_link_has_provider_cardinality_capability",
            allow_provider_cardinality,
        )
        delivered_id = await ChannelDeliveryWorker(sessionmaker).run_once()
    finally:
        unregister_whatsapp_provider_transport(account.id)

    assert delivered_id == queued.delivery_id
    assert len(transport.outbound_messages) == 1
    relayed = transport.outbound_messages[0]
    assert relayed.message_proto == message_proto
    assert relayed.attrs == message.attrs
    assert relayed.additional_nodes == message.additional_nodes

    await db_session.rollback()
    stored = await db_session.get(ChannelMessage, queued.channel_message_id)
    delivery = await db_session.get(ChannelDelivery, queued.delivery_id)
    assert stored is not None
    assert delivery is not None
    assert stored.direction == MESSAGE_DIRECTION_OUTBOUND
    assert stored.payload["providerPayload"] == {
        "schemaVersion": WHATSAPP_PROVIDER_PAYLOAD_SCHEMA,
        "messageId": "agent-exact-1",
        "messageProtoBase64": base64.b64encode(message_proto).decode("ascii"),
        "encType": "msg",
        "attrs": message.attrs,
        "additionalNodes": [{"tag": "meta", "attrs": {"polltype": "creation"}}],
    }
    assert stored.provider_message_id == "physical-agent-exact-1"
    assert delivery.status == "succeeded"


@pytest.mark.asyncio
async def test_whatsapp_provider_bridge_authorizes_raw_nodes_and_bounded_iq(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
):
    account, link, binding = await _seed_whatsapp_link_and_binding(
        client,
        db_session,
        channel_agent,
        name="wa-provider-protocol-bridge",
    )
    other_link = ChannelBotAgentLink(
        account_id=account.id,
        user_id=account.user_id,
        agent_id=second_channel_agent.id,
    )
    store_agent_link_token(other_link, generate_agent_token("whatsapp"))
    db_session.add(other_link)
    await db_session.flush()
    other_binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=other_link.id,
        user_id=account.user_id,
        external_chat_id="15559999999@s.whatsapp.net",
        external_chat_type="dm",
        external_chat_name="Bob",
    )
    db_session.add(other_binding)
    await db_session.commit()
    transport = _FakeProviderTransport()
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    bridge = WhatsAppProviderBridge(
        sessionmaker,
        account_id=account.id,
        transport=transport,
    )

    relayed = await bridge.relay_raw_node(
        {
            "tag": "chatstate",
            "attrs": {"to": binding.external_chat_id, "from": "spoof@s.whatsapp.net"},
            "content": [{"tag": "composing", "attrs": {"name": "spoof"}}],
        },
        lambda _message_id: None,
        bot_agent_link_id=link.id,
    )
    dropped = await bridge.relay_raw_node(
        {"tag": "presence", "attrs": {"to": other_binding.external_chat_id}},
        lambda _message_id: None,
        bot_agent_link_id=link.id,
    )
    iq = await bridge.forward_iq(
        {
            "tag": "iq",
            "attrs": {
                "id": "agent-q-1",
                "xmlns": "w:profile:picture",
                "type": "get",
                "to": binding.external_chat_id,
            },
            "content": [{"tag": "props", "attrs": {}}],
        },
        tenant_id=str(link.id),
        bot_agent_link_id=link.id,
    )
    cross_link_iq = await bridge.forward_iq(
        {
            "tag": "iq",
            "attrs": {
                "id": "agent-q-2",
                "xmlns": "w:profile:picture",
                "type": "get",
                "to": other_binding.external_chat_id,
            },
        },
        tenant_id=str(link.id),
        bot_agent_link_id=link.id,
    )
    mismatched_tenant_iq = await bridge.forward_iq(
        {
            "tag": "iq",
            "attrs": {
                "id": "agent-q-3",
                "xmlns": "w:profile:picture",
                "type": "get",
                "to": binding.external_chat_id,
            },
        },
        tenant_id=str(other_link.id),
        bot_agent_link_id=link.id,
    )
    untargeted_iq = await bridge.forward_iq(
        {"tag": "iq", "attrs": {"id": "agent-q-4", "xmlns": "w", "type": "get"}},
        tenant_id=str(link.id),
        bot_agent_link_id=link.id,
    )
    media_iq = await bridge.forward_iq(
        {
            "tag": "iq",
            "attrs": {
                "id": "media-conn-1",
                "xmlns": "w:m",
                "type": "set",
                "to": "s.whatsapp.net",
            },
            "content": [{"tag": "media_conn", "attrs": {}}],
        },
        tenant_id=str(link.id),
        bot_agent_link_id=link.id,
    )
    privacy_iq = await bridge.forward_iq(
        {
            "tag": "iq",
            "attrs": {
                "id": "privacy-1",
                "xmlns": "privacy",
                "type": "get",
                "to": "s.whatsapp.net",
            },
            "content": [{"tag": "privacy", "attrs": {}}],
        },
        tenant_id=str(link.id),
        bot_agent_link_id=link.id,
    )
    malformed_service_iq = await bridge.forward_iq(
        {
            "tag": "iq",
            "attrs": {
                "id": "unsafe-media-1",
                "xmlns": "w:m",
                "type": "set",
                "to": "s.whatsapp.net",
                "target": other_binding.external_chat_id,
            },
            "content": [{"tag": "media_conn", "attrs": {}}],
        },
        tenant_id=str(link.id),
        bot_agent_link_id=link.id,
    )
    missing_id_service_iq = await bridge.forward_iq(
        {
            "tag": "iq",
            "attrs": {
                "xmlns": "privacy",
                "type": "get",
                "to": "s.whatsapp.net",
            },
            "content": [{"tag": "privacy", "attrs": {}}],
        },
        tenant_id=str(link.id),
        bot_agent_link_id=link.id,
    )
    cross_link_service_iq = await bridge.forward_iq(
        {
            "tag": "iq",
            "attrs": {
                "id": "privacy-cross-link",
                "xmlns": "privacy",
                "type": "get",
                "to": "s.whatsapp.net",
            },
            "content": [{"tag": "privacy", "attrs": {}}],
        },
        tenant_id=str(other_link.id),
        bot_agent_link_id=link.id,
    )
    missing_link_id = uuid4()
    missing_link_service_iq = await bridge.forward_iq(
        {
            "tag": "iq",
            "attrs": {
                "id": "privacy-missing-link",
                "xmlns": "privacy",
                "type": "get",
                "to": "s.whatsapp.net",
            },
            "content": [{"tag": "privacy", "attrs": {}}],
        },
        tenant_id=str(missing_link_id),
        bot_agent_link_id=missing_link_id,
    )

    assert relayed.outcome == "relayed"
    assert dropped.outcome == "dropped"
    assert dropped.reason == "unbound-jid"
    assert transport.raw_nodes == [
        {
            "tag": "chatstate",
            "attrs": {"to": binding.external_chat_id},
            "content": [{"tag": "composing", "attrs": {}}],
        }
    ]
    assert transport.iq_queries[0][0]["attrs"].get("id") is None
    assert transport.iq_queries[0][1] == 15_000
    assert iq is not None
    assert iq["attrs"]["id"] == "agent-q-1"
    assert cross_link_iq is None
    assert mismatched_tenant_iq is None
    assert untargeted_iq is None
    assert media_iq is not None
    assert media_iq["attrs"]["id"] == "media-conn-1"
    assert privacy_iq is not None
    assert privacy_iq["attrs"]["id"] == "privacy-1"
    assert malformed_service_iq is None
    assert missing_id_service_iq is None
    assert cross_link_service_iq is None
    assert missing_link_service_iq is None
    assert len(transport.iq_queries) == 3
    assert transport.iq_queries[1][0] == {
        "tag": "iq",
        "attrs": {"xmlns": "w:m", "type": "set", "to": "s.whatsapp.net"},
        "content": [{"tag": "media_conn", "attrs": {}}],
    }
    assert transport.iq_queries[2][0] == {
        "tag": "iq",
        "attrs": {"xmlns": "privacy", "type": "get", "to": "s.whatsapp.net"},
        "content": [{"tag": "privacy", "attrs": {}}],
    }


@pytest.mark.asyncio
async def test_whatsapp_provider_usync_requires_link_binding_and_uses_durable_lid_alias(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
):
    account, link, binding = await _seed_whatsapp_link_and_binding(
        client,
        db_session,
        channel_agent,
        name="wa-stock-usync-authority",
        external_chat_id="15551112222@s.whatsapp.net",
    )
    lid_jid = "184207372460253@lid"
    await remember_whatsapp_binding_aliases(
        db_session,
        binding=binding,
        remote_jid=binding.external_chat_id,
        alt_jid=lid_jid,
    )
    other_link = ChannelBotAgentLink(
        account_id=account.id,
        user_id=account.user_id,
        agent_id=second_channel_agent.id,
    )
    store_agent_link_token(other_link, generate_agent_token("whatsapp"))
    db_session.add(other_link)
    await db_session.flush()
    other_binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=other_link.id,
        user_id=account.user_id,
        external_chat_id="15559999999@s.whatsapp.net",
        external_chat_type="dm",
        external_chat_name="Bob",
    )
    db_session.add(other_binding)
    await db_session.commit()

    class UnavailableUsyncTransport(_FakeProviderTransport):
        async def query_iq(self, node, timeout_ms):
            self.iq_queries.append((node, timeout_ms))
            return None

    transport = UnavailableUsyncTransport()
    bridge = WhatsAppProviderBridge(
        async_sessionmaker(db_session.bind, expire_on_commit=False),
        account_id=account.id,
        transport=transport,
    )

    unbound = await bridge.forward_iq(
        _stock_usync_device_iq("15550000000@s.whatsapp.net"),
        tenant_id=str(link.id),
        bot_agent_link_id=link.id,
    )
    cross_link = await bridge.forward_iq(
        _stock_usync_device_iq(other_binding.external_chat_id),
        tenant_id=str(link.id),
        bot_agent_link_id=link.id,
    )
    resolved = await bridge.forward_iq(
        _stock_usync_device_iq(binding.external_chat_id),
        tenant_id=str(link.id),
        bot_agent_link_id=link.id,
    )

    assert unbound is None
    assert cross_link is None
    assert len(transport.iq_queries) == 1
    assert transport.iq_queries[0][0]["attrs"] == {
        "to": "s.whatsapp.net",
        "type": "get",
        "xmlns": "usync",
    }
    assert resolved is not None
    assert resolved["attrs"]["id"] == "stock-usync-devices"
    resolved_user = resolved["content"][0]["content"][0]["content"][0]
    assert resolved_user == {
        "tag": "user",
        "attrs": {"jid": binding.external_chat_id},
        "content": [
            {"tag": "lid", "attrs": {"val": lid_jid}},
            {
                "tag": "devices",
                "attrs": {},
                "content": [
                    {
                        "tag": "device-list",
                        "attrs": {},
                        "content": [{"tag": "device", "attrs": {"id": "0"}}],
                    }
                ],
            },
        ],
    }


@pytest.mark.asyncio
async def test_whatsapp_replacement_binding_refreshes_alias_authority_before_io(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    account, old_link, old_binding = await _seed_whatsapp_link_and_binding(
        client,
        db_session,
        channel_agent,
        name="wa-replacement-authority",
    )
    alias_jid = "7826185388106@lid"
    alias = ChannelBindingAlias(
        account_id=account.id,
        bot_agent_link_id=old_link.id,
        binding_id=old_binding.id,
        user_id=old_binding.user_id,
        alias_external_chat_id=alias_jid,
    )
    db_session.add(alias)
    old_binding.status = BINDING_STATUS_ARCHIVED
    new_link = ChannelBotAgentLink(
        account_id=account.id,
        user_id=account.user_id,
        agent_id=second_channel_agent.id,
    )
    store_agent_link_token(new_link, generate_agent_token("whatsapp"))
    db_session.add(new_link)
    await db_session.flush()
    new_binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=new_link.id,
        user_id=account.user_id,
        external_chat_id=old_binding.external_chat_id,
        external_chat_type="dm",
        external_chat_name="Alice",
    )
    db_session.add(new_binding)
    await db_session.flush()
    await remember_whatsapp_binding_aliases(
        db_session,
        binding=new_binding,
        remote_jid=alias_jid,
        alt_jid=new_binding.external_chat_id,
    )
    await db_session.commit()
    await db_session.refresh(alias)
    assert alias.binding_id == new_binding.id
    assert alias.bot_agent_link_id == new_link.id

    transport = _FakeProviderTransport()
    bridge = WhatsAppProviderBridge(
        async_sessionmaker(db_session.bind, expire_on_commit=False),
        account_id=account.id,
        transport=transport,
    )
    raw = {"tag": "presence", "attrs": {"to": alias_jid}}
    old_raw = await bridge.relay_raw_node(raw, lambda _id: None, bot_agent_link_id=old_link.id)
    new_raw = await bridge.relay_raw_node(raw, lambda _id: None, bot_agent_link_id=new_link.id)
    old_iq = await bridge.forward_iq(
        {"tag": "iq", "attrs": {"id": "old", "xmlns": "w", "type": "get", "to": alias_jid}},
        tenant_id=str(old_link.id),
        bot_agent_link_id=old_link.id,
    )
    new_iq = await bridge.forward_iq(
        {"tag": "iq", "attrs": {"id": "new", "xmlns": "w", "type": "get", "to": alias_jid}},
        tenant_id=str(new_link.id),
        bot_agent_link_id=new_link.id,
    )
    assert old_raw.outcome == "dropped"
    assert new_raw.outcome == "relayed"
    assert old_iq is None
    assert new_iq is not None

    queued, _delivery = await enqueue_channel_outbound_message(
        db_session,
        account=account,
        external_chat_id=alias_jid,
        text="queued",
        bot_agent_link_id=new_link.id,
    )
    assert queued.external_chat_id == new_binding.external_chat_id

    provider_calls: list[str] = []

    async def fake_provider_payload(*, account, external_chat_id, text, provider_payload=None):
        provider_calls.append(external_chat_id)
        return "provider-message", {}

    monkeypatch.setattr(
        "app.services.channels._send_whatsapp_provider_payload",
        fake_provider_payload,
    )
    with pytest.raises(HTTPException, match="not paired"):
        await send_whatsapp_message(
            db_session,
            account=account,
            external_chat_id=alias_jid,
            text="denied",
            bot_agent_link_id=old_link.id,
        )
    assert provider_calls == []
    sent = await send_whatsapp_message(
        db_session,
        account=account,
        external_chat_id=alias_jid,
        text="allowed",
        bot_agent_link_id=new_link.id,
    )
    assert provider_calls == [new_binding.external_chat_id]
    assert sent.external_chat_id == new_binding.external_chat_id

    other_response = await client.post(
        "/v1/channels",
        json={"provider": "whatsapp", "name": "wa-cross-account-alias-drift"},
    )
    assert other_response.status_code == 201
    other_account = await db_session.get(ChannelAccount, UUID(other_response.json()["id"]))
    assert other_account is not None
    alias.account_id = other_account.id
    await db_session.commit()
    drifted = await resolve_whatsapp_binding_by_jids(
        db_session,
        account=other_account,
        remote_jid=alias_jid,
    )
    assert drifted.binding is None


@pytest.mark.asyncio
async def test_whatsapp_direct_outbound_holds_authority_until_provider_io_finishes(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    account, link, binding = await _seed_whatsapp_link_and_binding(
        client, db_session, channel_agent, name="wa-direct-authority-barrier"
    )
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    io_started = asyncio.Event()
    release_io = asyncio.Event()

    async def blocked_provider(**_kwargs):
        io_started.set()
        await release_io.wait()
        return "provider-message", {}

    monkeypatch.setattr(
        "app.services.channels._send_whatsapp_provider_payload",
        blocked_provider,
    )

    async def send() -> None:
        async with sessionmaker() as db:
            current_account = await db.get(ChannelAccount, account.id)
            assert current_account is not None
            await send_whatsapp_message(
                db,
                account=current_account,
                external_chat_id=binding.external_chat_id,
                text="leased",
                bot_agent_link_id=link.id,
            )
            await db.commit()

    async def archive() -> None:
        async with sessionmaker() as db:
            current_account = (
                await db.execute(
                    select(ChannelAccount).where(ChannelAccount.id == account.id).with_for_update()
                )
            ).scalar_one()
            current_link = (
                await db.execute(
                    select(ChannelBotAgentLink)
                    .where(ChannelBotAgentLink.id == link.id)
                    .with_for_update()
                )
            ).scalar_one()
            await archive_bot_agent_link(db, link=current_link, account=current_account)
            await db.commit()

    send_task = asyncio.create_task(send())
    await asyncio.wait_for(io_started.wait(), timeout=1)
    archive_task = asyncio.create_task(archive())
    await asyncio.sleep(0.05)
    assert archive_task.done() is False
    release_io.set()
    await asyncio.gather(send_task, archive_task)


@pytest.mark.asyncio
async def test_whatsapp_account_only_send_holds_authority_until_provider_io_finishes(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    account, _link, binding = await _seed_whatsapp_link_and_binding(
        client, db_session, channel_agent, name="wa-account-only-authority-barrier"
    )
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    io_started = asyncio.Event()
    release_io = asyncio.Event()

    async def blocked_provider(**_kwargs):
        io_started.set()
        await release_io.wait()
        return "provider-message", {}

    monkeypatch.setattr("app.services.channels._send_whatsapp_provider_payload", blocked_provider)

    async def send() -> None:
        async with sessionmaker() as db:
            current_account = await db.get(ChannelAccount, account.id)
            assert current_account is not None
            await send_whatsapp_message(
                db,
                account=current_account,
                external_chat_id=binding.external_chat_id,
                text="control reply",
                bind_to_existing=False,
            )
            await db.commit()

    send_task = asyncio.create_task(send())
    await asyncio.wait_for(io_started.wait(), timeout=1)
    async with sessionmaker() as mutation_db:
        mutation = asyncio.create_task(
            mutation_db.execute(
                select(ChannelAccount).where(ChannelAccount.id == account.id).with_for_update()
            )
        )
        await asyncio.sleep(0.05)
        assert mutation.done() is False
        release_io.set()
        await send_task
        locked_account = (await mutation).scalar_one()
        locked_account.status = "disabled"
        await mutation_db.commit()


@pytest.mark.asyncio
async def test_whatsapp_account_retirement_wins_before_account_only_send_io(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    account, _link, binding = await _seed_whatsapp_link_and_binding(
        client, db_session, channel_agent, name="wa-account-retirement-wins"
    )
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    provider_calls = 0

    async def provider(**_kwargs):
        nonlocal provider_calls
        provider_calls += 1
        return "provider-message", {}

    monkeypatch.setattr("app.services.channels._send_whatsapp_provider_payload", provider)
    async with sessionmaker() as mutation_db:
        locked_account = (
            await mutation_db.execute(
                select(ChannelAccount).where(ChannelAccount.id == account.id).with_for_update()
            )
        ).scalar_one()
        locked_account.status = "disabled"

        async def send() -> None:
            async with sessionmaker() as send_db:
                stale_account = await send_db.get(ChannelAccount, account.id)
                assert stale_account is not None
                await send_whatsapp_message(
                    send_db,
                    account=stale_account,
                    external_chat_id=binding.external_chat_id,
                    text="control reply",
                    bind_to_existing=False,
                )

        send_task = asyncio.create_task(send())
        await asyncio.sleep(0.05)
        assert provider_calls == 0
        await mutation_db.commit()
        with pytest.raises(HTTPException, match="channel not found"):
            await send_task
    assert provider_calls == 0


@pytest.mark.asyncio
async def test_whatsapp_link_retirement_wins_before_direct_io_and_provider_is_not_called(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    account, link, binding = await _seed_whatsapp_link_and_binding(
        client, db_session, channel_agent, name="wa-retirement-wins-barrier"
    )
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    provider_calls = 0

    async def provider(**_kwargs):
        nonlocal provider_calls
        provider_calls += 1
        return "provider-message", {}

    monkeypatch.setattr("app.services.channels._send_whatsapp_provider_payload", provider)
    async with sessionmaker() as mutation_db:
        current_account = (
            await mutation_db.execute(
                select(ChannelAccount).where(ChannelAccount.id == account.id).with_for_update()
            )
        ).scalar_one()
        current_link = (
            await mutation_db.execute(
                select(ChannelBotAgentLink)
                .where(ChannelBotAgentLink.id == link.id)
                .with_for_update()
            )
        ).scalar_one()
        await archive_bot_agent_link(
            mutation_db,
            link=current_link,
            account=current_account,
        )

        async def send() -> None:
            async with sessionmaker() as send_db:
                stale_account = await send_db.get(ChannelAccount, account.id)
                assert stale_account is not None
                await send_whatsapp_message(
                    send_db,
                    account=stale_account,
                    external_chat_id=binding.external_chat_id,
                    text="denied",
                    bot_agent_link_id=link.id,
                )

        send_task = asyncio.create_task(send())
        await asyncio.sleep(0.05)
        assert provider_calls == 0
        await mutation_db.commit()
        with pytest.raises(HTTPException, match="not paired"):
            await send_task
    assert provider_calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["raw", "iq", "service_iq"])
async def test_whatsapp_protocol_io_holds_binding_authority_lease(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    operation: str,
):
    account, link, binding = await _seed_whatsapp_link_and_binding(
        client, db_session, channel_agent, name=f"wa-{operation}-authority-barrier"
    )
    io_started = asyncio.Event()
    release_io = asyncio.Event()

    class BlockingTransport(_FakeProviderTransport):
        async def relay_raw_node(self, node):
            io_started.set()
            await release_io.wait()
            await super().relay_raw_node(node)

        async def query_iq(self, node, timeout_ms):
            io_started.set()
            await release_io.wait()
            return await super().query_iq(node, timeout_ms)

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    bridge = WhatsAppProviderBridge(
        sessionmaker,
        account_id=account.id,
        transport=BlockingTransport(),
    )

    async def perform_io() -> None:
        if operation == "raw":
            result = await bridge.relay_raw_node(
                {"tag": "presence", "attrs": {"to": binding.external_chat_id}},
                lambda _id: None,
                bot_agent_link_id=link.id,
            )
            assert result.outcome == "relayed"
        elif operation == "iq":
            result = await bridge.forward_iq(
                {
                    "tag": "iq",
                    "attrs": {
                        "id": "leased-iq",
                        "xmlns": "w",
                        "type": "get",
                        "to": binding.external_chat_id,
                    },
                },
                tenant_id=str(link.id),
                bot_agent_link_id=link.id,
            )
            assert result is not None
        else:
            result = await bridge.forward_iq(
                {
                    "tag": "iq",
                    "attrs": {
                        "id": "leased-service-iq",
                        "xmlns": "privacy",
                        "type": "get",
                        "to": "s.whatsapp.net",
                    },
                    "content": [{"tag": "privacy", "attrs": {}}],
                },
                tenant_id=str(link.id),
                bot_agent_link_id=link.id,
            )
            assert result is not None

    async def archive() -> None:
        async with sessionmaker() as db:
            current_account = (
                await db.execute(
                    select(ChannelAccount).where(ChannelAccount.id == account.id).with_for_update()
                )
            ).scalar_one()
            current_link = (
                await db.execute(
                    select(ChannelBotAgentLink)
                    .where(ChannelBotAgentLink.id == link.id)
                    .with_for_update()
                )
            ).scalar_one()
            await archive_bot_agent_link(db, link=current_link, account=current_account)
            await db.commit()

    io_task = asyncio.create_task(perform_io())
    await asyncio.wait_for(io_started.wait(), timeout=1)
    archive_task = asyncio.create_task(archive())
    await asyncio.sleep(0.05)
    assert archive_task.done() is False
    release_io.set()
    await asyncio.gather(io_task, archive_task)


@pytest.mark.asyncio
async def test_whatsapp_provider_ingress_preserves_proto_aliases_and_account_dedupe(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
):
    account, _link, binding = await _seed_whatsapp_link_and_binding(
        client,
        db_session,
        channel_agent,
        name="wa-provider-ingress",
    )
    lid_jid = "7826185388106@lid"
    message_proto = whatsapp_text_message_proto("hello from physical provider")
    event = WhatsAppProviderMessageEvent(
        sequence=1,
        message_id="physical-inbound-1",
        remote_jid=lid_jid,
        remote_jid_alt=binding.external_chat_id,
        participant=None,
        participant_alt=None,
        push_name="Alice",
        message_timestamp=1_722_000_000,
        message_proto=message_proto,
    )

    await persist_whatsapp_provider_event(db_session, account_id=account.id, event=event)
    await persist_whatsapp_provider_event(db_session, account_id=account.id, event=event)

    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == account.id,
                    ChannelMessage.provider_message_id == event.message_id,
                )
            )
        ).scalars()
    )
    alias = (
        await db_session.execute(
            select(ChannelBindingAlias).where(
                ChannelBindingAlias.binding_id == binding.id,
                ChannelBindingAlias.alias_external_chat_id == lid_jid,
            )
        )
    ).scalar_one()
    assert len(messages) == 1
    assert messages[0].direction == MESSAGE_DIRECTION_INBOUND
    assert messages[0].binding_id == binding.id
    assert messages[0].external_chat_id == binding.external_chat_id
    assert messages[0].text == "hello from physical provider"
    assert messages[0].payload["messageProtoBase64"] == base64.b64encode(message_proto).decode(
        "ascii"
    )
    assert "message" not in messages[0].payload
    assert alias.alias_external_chat_id == lid_jid

    duplicate_count = await db_session.scalar(
        select(func.count(ChannelMessage.id)).where(
            ChannelMessage.account_id == account.id,
            ChannelMessage.provider_message_id == event.message_id,
        )
    )
    assert duplicate_count == 1


@pytest.mark.asyncio
async def test_whatsapp_unpaired_traffic_is_silent_and_replayed_command_replies_once(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
):
    account, _link, binding = await _seed_whatsapp_link_and_binding(
        client,
        db_session,
        channel_agent,
        name="wa-unpaired-command-only-replies",
    )
    binding.status = BINDING_STATUS_ARCHIVED
    await db_session.commit()
    transport = _FakeProviderTransport()
    register_whatsapp_provider_transport(account.id, transport)
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)

    def event(sequence: int, message_id: str, jid: str, text: str) -> WhatsAppProviderMessageEvent:
        return WhatsAppProviderMessageEvent(
            sequence=sequence,
            message_id=message_id,
            remote_jid=jid,
            remote_jid_alt=None,
            participant=None,
            participant_alt=None,
            push_name=None,
            message_timestamp=None,
            message_proto=whatsapp_text_message_proto(text),
        )

    try:
        async with sessionmaker() as db:
            await persist_whatsapp_provider_event(
                db,
                account_id=account.id,
                event=event(1, "ordinary-dm", "15550001111@s.whatsapp.net", "hello"),
            )
            await persist_whatsapp_provider_event(
                db,
                account_id=account.id,
                event=event(2, "ordinary-group", "120363000000000000@g.us", "hello group"),
            )
        assert transport.outbound_messages == []

        command = event(
            3,
            "replayed-unpair",
            "15550001111@s.whatsapp.net",
            "/clawdi_unpair",
        )

        async def consume() -> None:
            async with sessionmaker() as db:
                await persist_whatsapp_provider_event(db, account_id=account.id, event=command)

        await asyncio.gather(consume(), consume())

        for help_event in (
            event(4, "help-dm", "15550001111@s.whatsapp.net", "/clawdi_help"),
            event(5, "help-group", "120363000000000000@g.us", "/clawdi_help"),
        ):

            async def consume_help() -> None:
                async with sessionmaker() as db:
                    await persist_whatsapp_provider_event(
                        db,
                        account_id=account.id,
                        event=help_event,
                    )

            await asyncio.gather(consume_help(), consume_help())

        unknown = event(
            6,
            "unknown-control",
            "15550001111@s.whatsapp.net",
            "/clawdi_unknown",
        )

        async def consume_unknown() -> None:
            async with sessionmaker() as db:
                await persist_whatsapp_provider_event(
                    db,
                    account_id=account.id,
                    event=unknown,
                )

        await asyncio.gather(consume_unknown(), consume_unknown())
    finally:
        unregister_whatsapp_provider_transport(account.id)

    assert len(transport.outbound_messages) == 4
    assert transport.outbound_messages[0].conversation == "This chat is not paired."
    assert [message.conversation for message in transport.outbound_messages[1:3]] == [
        channel_control_help_reply(),
        channel_control_help_reply(),
    ]
    assert transport.outbound_messages[3].conversation == (
        "Unknown command: /clawdi_unknown. Use /clawdi_help for instructions."
    )
    await db_session.rollback()
    command_messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == account.id,
                    ChannelMessage.provider_event_id == "replayed-unpair",
                )
            )
        ).scalars()
    )
    assert len(command_messages) == 1
    assert command_messages[0].delivered_at is not None
    unknown_messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == account.id,
                    ChannelMessage.provider_event_id == "unknown-control",
                )
            )
        ).scalars()
    )
    assert len(unknown_messages) == 1
    assert unknown_messages[0].delivered_at is not None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("visibility", "expect_recorded_outbound"),
    [
        (CHANNEL_VISIBILITY_PUBLIC, False),
        (CHANNEL_VISIBILITY_PRIVATE, True),
    ],
)
async def test_whatsapp_unpair_ack_uses_post_unpair_account_send(
    db_session: AsyncSession,
    channel_agent,
    visibility: str,
    expect_recorded_outbound: bool,
) -> None:
    external_chat_id = "15551114444@s.whatsapp.net"
    account = build_channel_account(
        owner_user_id=(channel_agent.user_id if visibility == CHANNEL_VISIBILITY_PRIVATE else None),
        provider=CHANNEL_PROVIDER_WHATSAPP,
        name=f"wa-{visibility}-unpair-ack",
        visibility=visibility,
        webhook_secret_hash=hash_token(uuid4().hex),
    )
    db_session.add(account)
    await db_session.flush()
    link = ChannelBotAgentLink(
        account_id=account.id,
        user_id=channel_agent.user_id,
        agent_id=channel_agent.id,
    )
    store_agent_link_token(link, generate_agent_token(CHANNEL_PROVIDER_WHATSAPP))
    db_session.add(link)
    await db_session.flush()
    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=link.id,
        user_id=channel_agent.user_id,
        external_chat_id=external_chat_id,
        external_chat_type="dm",
        paired_external_user_id=external_chat_id,
    )
    db_session.add(binding)
    await db_session.commit()
    transport = _FakeProviderTransport()
    register_whatsapp_provider_transport(account.id, transport)

    try:
        await persist_whatsapp_provider_event(
            db_session,
            account_id=account.id,
            event=WhatsAppProviderMessageEvent(
                sequence=1,
                message_id=f"{visibility}-unpair",
                remote_jid=external_chat_id,
                remote_jid_alt=None,
                participant=None,
                participant_alt=None,
                push_name=None,
                message_timestamp=None,
                message_proto=whatsapp_text_message_proto("/clawdi_unpair"),
            ),
        )
    finally:
        unregister_whatsapp_provider_transport(account.id)

    await db_session.refresh(binding)
    assert binding.status == BINDING_STATUS_ARCHIVED
    assert [message.conversation for message in transport.outbound_messages] == [
        "Unpaired. This chat is no longer connected to an agent."
    ]
    outbound_message = (
        await db_session.execute(
            select(ChannelMessage).where(
                ChannelMessage.account_id == account.id,
                ChannelMessage.direction == MESSAGE_DIRECTION_OUTBOUND,
            )
        )
    ).scalar_one_or_none()
    if expect_recorded_outbound:
        assert outbound_message is not None
        assert outbound_message.user_id == channel_agent.user_id
        assert outbound_message.bot_agent_link_id is None
        assert outbound_message.binding_id is None
    else:
        assert outbound_message is None


@pytest.mark.asyncio
async def test_whatsapp_concurrent_replayed_pair_mutates_and_replies_once(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
):
    account, link, binding = await _seed_whatsapp_link_and_binding(
        client,
        db_session,
        channel_agent,
        name="wa-concurrent-pair-fence",
    )
    binding.status = BINDING_STATUS_ARCHIVED
    code = "X7V9Q2M4KC"
    db_session.add(
        ChannelPairCode(
            account_id=account.id,
            bot_agent_link_id=link.id,
            user_id=account.user_id,
            code_hash=hash_token(code),
            expires_at=datetime.now(UTC) + timedelta(minutes=15),
        )
    )
    await db_session.commit()
    transport = _FakeProviderTransport()
    register_whatsapp_provider_transport(account.id, transport)
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    event = WhatsAppProviderMessageEvent(
        sequence=4,
        message_id="replayed-pair",
        remote_jid=binding.external_chat_id,
        remote_jid_alt=None,
        participant=None,
        participant_alt=None,
        push_name="Alice",
        message_timestamp=None,
        message_proto=whatsapp_text_message_proto(f"/clawdi_pair {code}"),
    )

    async def consume() -> None:
        async with sessionmaker() as db:
            await persist_whatsapp_provider_event(db, account_id=account.id, event=event)

    try:
        await asyncio.gather(consume(), consume())
        paired_help = WhatsAppProviderMessageEvent(
            sequence=5,
            message_id="paired-help",
            remote_jid=binding.external_chat_id,
            remote_jid_alt=None,
            participant=None,
            participant_alt=None,
            push_name="Alice",
            message_timestamp=None,
            message_proto=whatsapp_text_message_proto("/clawdi_help"),
        )

        async def consume_help() -> None:
            async with sessionmaker() as db:
                await persist_whatsapp_provider_event(
                    db,
                    account_id=account.id,
                    event=paired_help,
                )

        await asyncio.gather(consume_help(), consume_help())
    finally:
        unregister_whatsapp_provider_transport(account.id)

    assert len(transport.outbound_messages) == 2
    assert transport.outbound_messages[0].conversation == (
        "Paired! This chat is now connected to your agent."
    )
    assert transport.outbound_messages[1].conversation == channel_control_help_reply()
    await db_session.rollback()
    active_bindings = list(
        (
            await db_session.execute(
                select(ChannelBinding).where(
                    ChannelBinding.account_id == account.id,
                    ChannelBinding.external_chat_id == binding.external_chat_id,
                    ChannelBinding.status == "active",
                )
            )
        ).scalars()
    )
    assert len(active_bindings) == 1
    pair_messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == account.id,
                    ChannelMessage.provider_event_id == event.message_id,
                )
            )
        ).scalars()
    )
    assert len(pair_messages) == 1
    assert pair_messages[0].delivered_at is not None
