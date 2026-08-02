from __future__ import annotations

import base64
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.channel import (
    MESSAGE_DIRECTION_INBOUND,
    MESSAGE_DIRECTION_OUTBOUND,
    ChannelAccount,
    ChannelBinding,
    ChannelBindingAlias,
    ChannelBotAgentLink,
    ChannelDelivery,
    ChannelMessage,
)
from app.services.channel_delivery_worker import ChannelDeliveryWorker
from app.services.channels import generate_agent_token, store_agent_link_token
from app.services.whatsapp_baileys import whatsapp_text_message_proto
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
    assert len(transport.iq_queries) == 1


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
