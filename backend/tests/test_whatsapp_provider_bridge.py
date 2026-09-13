from __future__ import annotations

import asyncio
import base64
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import app.services.whatsapp_delivery_transport as delivery_transport_module
import app.services.whatsapp_provider_bridge as bridge_module
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
    _delivery_error_code,
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
from app.services.whatsapp_native_transport import (
    WhatsAppBaileysSidecarClient,
    WhatsAppBaileysSidecarConfig,
    WhatsAppProviderMessageEvent,
)
from app.services.whatsapp_noise import WhatsAppOutboundMessage
from app.services.whatsapp_provider_bridge import (
    WHATSAPP_PROVIDER_PAYLOAD_SCHEMA,
    WhatsAppProviderBridge,
    get_whatsapp_provider_transport,
    persist_whatsapp_provider_event,
    register_whatsapp_provider_transport,
    relay_whatsapp_provider_payload,
    unregister_whatsapp_provider_transport,
    whatsapp_provider_transport_status,
)
from app.services.whatsapp_sidecar_registry import ConfiguredWhatsAppSidecarClientPool

pytestmark = [pytest.mark.usefixtures("channel_agent"), pytest.mark.committed_db]


@asynccontextmanager
async def _sidecar_pool(http_client: httpx.AsyncClient, *, token: str = "sidecar-secret"):
    pool = ConfiguredWhatsAppSidecarClientPool(
        token,
        base_url=str(http_client.base_url).rstrip("/"),
        client_factory=lambda config: WhatsAppBaileysSidecarClient(config, http_client=http_client),
    )
    await pool.start()
    try:
        yield pool
    finally:
        await pool.stop()


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


def _use_delivery_transport(
    monkeypatch: pytest.MonkeyPatch,
    transport: _FakeProviderTransport,
) -> None:
    monkeypatch.setattr(
        delivery_transport_module,
        "resolve_whatsapp_delivery_transport",
        lambda _account: transport,
    )


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
            "to": "@s.whatsapp.net",
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
        assert status.mode == "sidecar"
    finally:
        unregister_whatsapp_provider_transport(account_id)

    assert whatsapp_provider_transport_status(account_id).available is False


@pytest.mark.asyncio
async def test_whatsapp_provider_payload_rejects_non_json_values_before_relay(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    account_id = uuid4()
    transport = _FakeProviderTransport()
    _use_delivery_transport(monkeypatch, transport)

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
    sidecar_url = "http://127.0.0.1:43191"
    sidecar_config = WhatsAppBaileysSidecarConfig(
        api_token="sidecar-secret",
        base_url=sidecar_url,
        account_id=account.id,
    )
    account.config = {
        "connection_mode": "baileys_managed",
        "sidecar_config_revision": sidecar_config.binding_revision,
    }
    lid_jid = "184207372460253@lid"
    await remember_whatsapp_binding_aliases(
        db_session,
        binding=binding,
        remote_jid=binding.external_chat_id,
        alt_jid=lid_jid,
    )
    await db_session.commit()
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    bridge = WhatsAppProviderBridge(sessionmaker, account_id=account.id)
    message_proto = b"\x32\x0c\x0a\x0aexact-edit"
    message = WhatsAppOutboundMessage(
        to_jid=lid_jid,
        message_id="agent-exact-1",
        message_proto=message_proto,
        enc_type="msg",
        attrs={
            "id": "agent-exact-1",
            "to": lid_jid,
            "edit": "8",
            "addressing_mode": "lid",
        },
        conversation="exact edit",
        additional_nodes=({"tag": "meta", "attrs": {"polltype": "creation"}},),
    )
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["authorization"] == "Bearer sidecar-secret"
        assert request.url.path == f"/v1/sessions/{account.id}/relay-message"
        return httpx.Response(200, json={"ok": True, "messageId": "physical-agent-exact-1"})

    http_client = httpx.AsyncClient(
        base_url=sidecar_url,
        transport=httpx.MockTransport(handler),
    )
    async with http_client, _sidecar_pool(http_client):
        assert get_whatsapp_provider_transport(account.id) is None
        queued = await bridge.store_outbound_message(message, bot_agent_link_id=link.id)
        assert queued.outcome == "queued"
        assert requests == []

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

    assert delivered_id == queued.delivery_id
    assert len(requests) == 1
    relayed = json.loads(requests[0].content)
    assert relayed == {
        "jid": binding.external_chat_id,
        "messageId": "agent-exact-1",
        "messageProtoBase64": base64.b64encode(message_proto).decode("ascii"),
        "additionalAttributes": {"edit": "8", "addressing_mode": "lid"},
        "additionalNodes": [{"tag": "meta", "attrs": {"polltype": "creation"}}],
    }

    await db_session.rollback()
    stored = await db_session.get(ChannelMessage, queued.channel_message_id)
    delivery = await db_session.get(ChannelDelivery, queued.delivery_id)
    assert stored is not None
    assert delivery is not None
    assert stored.direction == MESSAGE_DIRECTION_OUTBOUND
    assert stored.external_chat_id == binding.external_chat_id
    assert stored.payload["providerPayload"] == {
        "schemaVersion": WHATSAPP_PROVIDER_PAYLOAD_SCHEMA,
        "messageId": "agent-exact-1",
        "messageProtoBase64": base64.b64encode(message_proto).decode("ascii"),
        "encType": "msg",
        "attrs": {"edit": "8", "addressing_mode": "lid"},
        "additionalNodes": [{"tag": "meta", "attrs": {"polltype": "creation"}}],
    }
    assert stored.provider_message_id == "physical-agent-exact-1"
    assert delivery.status == "succeeded"


@pytest.mark.asyncio
async def test_whatsapp_provider_payload_foreign_target_fails_with_safe_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    account = ChannelAccount(id=uuid4())
    external_chat_id = "15551114444@s.whatsapp.net"
    provider_payload = {
        "schemaVersion": WHATSAPP_PROVIDER_PAYLOAD_SCHEMA,
        "messageId": "agent-foreign-target-1",
        "messageProtoBase64": base64.b64encode(b"foreign target").decode("ascii"),
        "encType": "msg",
        "attrs": {"to": "15559999999@s.whatsapp.net"},
    }
    transport = _FakeProviderTransport()
    _use_delivery_transport(monkeypatch, transport)

    with pytest.raises(HTTPException) as exc_info:
        await relay_whatsapp_provider_payload(
            account=account,
            external_chat_id=external_chat_id,
            text="must fail closed",
            provider_payload=provider_payload,
        )
    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "whatsapp provider payload target mismatch"
    assert _delivery_error_code(exc_info.value.detail) == "channel_provider_rejected"
    assert transport.outbound_messages == []


@pytest.mark.asyncio
async def test_whatsapp_delivery_revision_mismatch_fails_without_sidecar_call(
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    account = build_channel_account(
        owner_user_id=channel_agent.user_id,
        provider=CHANNEL_PROVIDER_WHATSAPP,
        name="wa-stale-delivery-revision",
        visibility=CHANNEL_VISIBILITY_PRIVATE,
        webhook_secret_hash=hash_token("wa-stale-delivery-revision"),
        config={
            "connection_mode": "baileys_managed",
            "sidecar_config_revision": "stale-revision",
        },
    )
    db_session.add(account)
    await db_session.flush()
    _message, delivery = await enqueue_channel_outbound_message(
        db_session,
        account=account,
        external_chat_id="15551114444@s.whatsapp.net",
        text="must fail closed",
    )
    delivery.max_attempts = 1
    await db_session.commit()

    def reject_session(config: WhatsAppBaileysSidecarConfig):
        raise AssertionError("revision mismatch must not construct a session client")

    pool = ConfiguredWhatsAppSidecarClientPool(
        "sidecar-secret", base_url="http://127.0.0.1:43191", client_factory=reject_session
    )
    await pool.start()
    try:
        delivered_id = await ChannelDeliveryWorker(
            async_sessionmaker(db_session.bind, expire_on_commit=False)
        ).run_once()
    finally:
        await pool.stop()

    assert delivered_id == delivery.id
    await db_session.refresh(delivery)
    assert delivery.status == "failed"
    assert delivery.attempts == 1
    assert delivery.last_error == "channel_provider_unreachable"


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
    self_lid_jid = "900000000000004:1@lid"
    self_lid_target = "900000000000004@lid"
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

    transport = _FakeProviderTransport()
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
    mixed = await bridge.forward_iq(
        _stock_usync_device_iq(self_lid_target, binding.external_chat_id),
        tenant_id=str(link.id),
        bot_agent_link_id=link.id,
        self_lid=self_lid_jid,
    )

    assert unbound is None
    assert cross_link is None
    assert transport.iq_queries == []
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
    assert mixed is not None
    mixed_users = mixed["content"][0]["content"][0]["content"]
    assert [user["attrs"]["jid"] for user in mixed_users] == [
        self_lid_target,
        binding.external_chat_id,
    ]
    assert mixed_users[0]["content"][1]["content"][0]["content"] == []
    assert mixed_users[1] == resolved_user


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
    text = "x" * 5_000
    message_proto = whatsapp_text_message_proto(text)
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
    assert messages[0].text == text
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
    monkeypatch: pytest.MonkeyPatch,
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
    _use_delivery_transport(monkeypatch, transport)
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
    monkeypatch: pytest.MonkeyPatch,
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
    _use_delivery_transport(monkeypatch, transport)
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
    monkeypatch: pytest.MonkeyPatch,
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
    _use_delivery_transport(monkeypatch, transport)
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


@pytest.mark.asyncio
async def test_raw_relay_uses_durable_custom_session_without_local_registry(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    account, link, binding = await _seed_whatsapp_link_and_binding(
        client, db_session, channel_agent, name="wa-cross-process-raw-relay"
    )
    session_id = uuid4()
    sidecar_url = "http://127.0.0.1:43191"
    config = WhatsAppBaileysSidecarConfig(
        api_token="sidecar-secret", base_url=sidecar_url, account_id=session_id
    )
    valid_config = {
        "connection_mode": "baileys_custom",
        "sidecar_account_id": str(session_id),
        "sidecar_config_revision": config.binding_revision,
    }
    account.config = valid_config
    await db_session.commit()
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["authorization"] == "Bearer sidecar-secret"
        assert request.url.path == f"/v1/sessions/{session_id}/raw-node"
        assert request.method == "POST"
        assert json.loads(request.content)["node"]["attrs"]["to"] == binding.external_chat_id
        return httpx.Response(200, json={"ok": True})

    async with (
        httpx.AsyncClient(
            base_url=sidecar_url, transport=httpx.MockTransport(handler)
        ) as http_client,
        _sidecar_pool(http_client),
    ):
        bridge = WhatsAppProviderBridge(
            async_sessionmaker(db_session.bind, expire_on_commit=False), account_id=account.id
        )
        node = {
            "tag": "chatstate",
            "attrs": {"to": binding.external_chat_id},
            "content": [{"tag": "composing", "attrs": {}}],
        }
        assert get_whatsapp_provider_transport(account.id) is None
        result = await bridge.relay_raw_node(node, lambda _id: None, bot_agent_link_id=link.id)
        assert result.outcome == "relayed"
        assert len(requests) == 1
        assert get_whatsapp_provider_transport(account.id) is None

        unsafe = await bridge.relay_raw_node(
            {"tag": "presence", "attrs": {"to": "15559999999@s.whatsapp.net"}},
            lambda _id: None,
            bot_agent_link_id=link.id,
        )
        assert unsafe.outcome == "dropped"
        assert len(requests) == 1

        account.config = {**valid_config, "sidecar_config_revision": "stale-revision"}
        await db_session.commit()
        stale = await bridge.relay_raw_node(node, lambda _id: None, bot_agent_link_id=link.id)
        assert stale.outcome == "unsupported"
        assert stale.reason == "provider-transport-unavailable"
        assert len(requests) == 1

        account.config = valid_config
        link.status = "archived"
        link.archived_at = datetime.now(UTC)
        await db_session.commit()
        retired = await bridge.relay_raw_node(node, lambda _id: None, bot_agent_link_id=link.id)
        assert retired.outcome == "dropped"
        assert retired.reason == "link-authority-missing"
        assert len(requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "xmlns,iq_type,child", [("w:m", "set", "media_conn"), ("privacy", "get", "privacy")]
)
@pytest.mark.parametrize("service_jid", ["@s.whatsapp.net", "s.whatsapp.net"])
async def test_provider_iq_uses_control_pool_across_restart_and_token_rotation(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    service_jid: str,
    xmlns: str,
    iq_type: str,
    child: str,
):
    account, link, _binding = await _seed_whatsapp_link_and_binding(
        client, db_session, channel_agent, name="wa-cross-process-iq"
    )
    session_id = uuid4()
    sidecar_url = "http://127.0.0.1:43191"
    revision = WhatsAppBaileysSidecarConfig(
        api_token="first-secret", base_url=sidecar_url, account_id=session_id
    ).binding_revision
    valid_config = {
        "connection_mode": "baileys_custom",
        "sidecar_account_id": str(session_id),
        "sidecar_config_revision": revision,
    }
    account.config = valid_config
    await db_session.commit()
    requests: list[httpx.Request] = []
    node = {
        "tag": "iq",
        "attrs": {"id": "agent-iq", "type": iq_type, "xmlns": xmlns, "to": service_jid},
        "content": [{"tag": child, "attrs": {}}],
    }

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.url.path == f"/v1/sessions/{session_id}/query-iq"
        assert request.method == "POST"
        body = json.loads(request.content)
        assert body["node"]["content"] == node["content"]
        assert body["node"]["attrs"]["to"] == service_jid
        return httpx.Response(
            200,
            json={
                "node": {
                    "tag": "iq",
                    "attrs": {"id": "provider-iq", "type": "result"},
                    "content": [{"tag": child, "attrs": {}}],
                }
            },
        )

    bridge = WhatsAppProviderBridge(
        async_sessionmaker(db_session.bind, expire_on_commit=False), account_id=account.id
    )
    async with httpx.AsyncClient(
        base_url=sidecar_url, transport=httpx.MockTransport(handler)
    ) as http_client:
        for token in ("first-secret", "rotated-secret"):
            async with _sidecar_pool(http_client, token=token):
                result = await bridge.forward_iq(node, str(link.id), bot_agent_link_id=link.id)
                assert result is not None
                assert result["attrs"]["id"] == "agent-iq"
                assert requests[-1].headers["authorization"] == f"Bearer {token}"
                assert get_whatsapp_provider_transport(account.id) is None
                count = len(requests)
                for target in (
                    "@s.whatsapp.net.evil",
                    "s.whatsapp.net@evil.test",
                    "0@s.whatsapp.net",
                    "@broadcast",
                ):
                    denied_node = {**node, "attrs": {**node["attrs"], "to": target}}
                    assert (
                        await bridge.forward_iq(
                            denied_node, str(link.id), bot_agent_link_id=link.id
                        )
                        is None
                    )
                assert len(requests) == count
                assert (
                    await bridge.forward_iq(node, str(uuid4()), bot_agent_link_id=link.id) is None
                )
                account.config = {**valid_config, "sidecar_config_revision": "stale"}
                await db_session.commit()
                assert (
                    await bridge.forward_iq(node, str(link.id), bot_agent_link_id=link.id) is None
                )
                assert len(requests) == count
                account.config = valid_config
                await db_session.commit()
            assert await bridge.forward_iq(node, str(link.id), bot_agent_link_id=link.id) is None
        assert len(requests) == 2


@pytest.mark.asyncio
async def test_channel_health_probes_custom_session_without_ingress_owner(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    account, _link, _binding = await _seed_whatsapp_link_and_binding(
        client, db_session, channel_agent, name="wa-api-worker-health"
    )
    session_id = uuid4()
    sidecar_url = "http://127.0.0.1:43191"
    account.config = {
        "connection_mode": "baileys_custom",
        "sidecar_account_id": str(session_id),
        "sidecar_config_revision": WhatsAppBaileysSidecarConfig(
            api_token="sidecar-secret", base_url=sidecar_url, account_id=session_id
        ).binding_revision,
    }
    await db_session.commit()
    available = True
    now = 0.0
    monkeypatch.setattr(bridge_module, "_transport_clock", lambda: now)
    monkeypatch.setattr(bridge_module, "_WHATSAPP_HEALTH_PROBE_TIMEOUT_SECONDS", 0.05)

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == f"/v1/sessions/{session_id}/health"
        assert request.headers["authorization"] == "Bearer sidecar-secret"
        if available is None:
            await asyncio.Event().wait()
        if not available:
            return httpx.Response(503, text="private upstream error")
        return httpx.Response(
            200,
            json={
                "status": "connected",
                "connected": True,
                "registered": True,
                "sessionId": str(session_id),
                "advertisedRelease": {
                    "packageName": "@whiskeysockets/baileys",
                    "packageVersion": "7.0.0-rc14",
                    "sourceCommit": "7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a",
                    "version": [2, 3000, 1043857760],
                },
            },
        )

    async with (
        httpx.AsyncClient(
            base_url=sidecar_url, transport=httpx.MockTransport(handler)
        ) as http_client,
        _sidecar_pool(http_client) as pool,
    ):
        for available, now, reconnecting in (
            (True, 0.0, False),
            (False, 1.0, True),
            (False, 302.0, False),
            (True, 303.0, False),
            (None, 304.0, True),
            (False, 305.0, True),
        ):
            response = await client.get("/v1/channels/debug/health")
            assert response.status_code == 200
            health = next(
                item for item in response.json()["channels"] if item["accountId"] == str(account.id)
            )
            assert health["nativeTransport"]["available"] is (available is True)
            assert health["nativeTransport"]["mode"] == "sidecar"
            assert health["nativeTransport"]["reconnecting"] is reconnecting
            session_client = pool.session_client(session_id)
            assert session_client is not None and session_client.connected is (available is True)
            assert "private upstream error" not in response.text
            assert get_whatsapp_provider_transport(account.id) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path,items_key,id_key,transport_key",
    [
        ("/v1/channels/health", "items", "account_id", "native_transport"),
        ("/v1/channels/debug/health", "channels", "accountId", "nativeTransport"),
    ],
)
async def test_health_lists_isolate_slow_and_invalid_sessions_without_db_lease(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    items_key: str,
    id_key: str,
    transport_key: str,
):
    sidecar_url = "http://127.0.0.1:43191"
    accounts = []
    for name in ("a-slow", "b-healthy", "c-invalid"):
        account_id = uuid4()
        account = build_channel_account(
            owner_user_id=channel_agent.user_id,
            provider=CHANNEL_PROVIDER_WHATSAPP,
            name=name,
            visibility=CHANNEL_VISIBILITY_PRIVATE,
            webhook_secret_hash=hash_token(name),
            config={
                "connection_mode": "baileys_managed",
                "sidecar_config_revision": WhatsAppBaileysSidecarConfig(
                    api_token="sidecar-secret", base_url=sidecar_url, account_id=account_id
                ).binding_revision,
            },
        )
        account.id = account_id
        db_session.add(account)
        accounts.append(account)
    await db_session.commit()
    monkeypatch.setattr(bridge_module, "_WHATSAPP_HEALTH_PROBE_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(bridge_module, "_WHATSAPP_HEALTH_REQUEST_TIMEOUT_SECONDS", 0.3)
    healthy_seen = asyncio.Event()
    cancelled = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        assert not db_session.in_transaction(), "provider I/O retained a DB transaction"
        session_id = UUID(request.url.path.split("/")[3])
        if session_id == accounts[0].id:
            try:
                await asyncio.Event().wait()
            finally:
                assert healthy_seen.is_set(), "slow account blocked the healthy account"
                cancelled.set()
        healthy_seen.set()
        return httpx.Response(
            200,
            json={
                "sessionId": str(session_id),
                "status": "connected",
                "connected": True,
                "registered": True if session_id == accounts[1].id else "invalid",
                "advertisedRelease": {
                    "packageName": "@whiskeysockets/baileys",
                    "packageVersion": "7.0.0-rc14",
                    "sourceCommit": "7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a",
                    "version": [2, 3000, 1043857760],
                },
            },
        )

    async with (
        httpx.AsyncClient(
            base_url=sidecar_url, transport=httpx.MockTransport(handler)
        ) as http_client,
        _sidecar_pool(http_client) as pool,
    ):
        response = await asyncio.wait_for(client.get(path), timeout=1)
        assert response.status_code == 200, response.text
        by_id = {item[id_key]: item[transport_key] for item in response.json()[items_key]}
        assert [by_id[str(account.id)]["available"] for account in accounts] == [False, True, False]
        assert cancelled.is_set()
        for account in (accounts[0], accounts[2]):
            session_client = pool.session_client(account.id)
            assert session_client is not None and session_client.connected is False


@pytest.mark.asyncio
async def test_health_outage_has_shared_deadline_bounded_workers_and_no_stale_green(
    monkeypatch: pytest.MonkeyPatch,
):
    sidecar_url = "http://127.0.0.1:43191"
    accounts = []
    for _ in range(20):
        account_id = uuid4()
        accounts.append(
            ChannelAccount(
                id=account_id,
                provider=CHANNEL_PROVIDER_WHATSAPP,
                config={
                    "connection_mode": "baileys_managed",
                    "sidecar_config_revision": WhatsAppBaileysSidecarConfig(
                        api_token="sidecar-secret", base_url=sidecar_url, account_id=account_id
                    ).binding_revision,
                },
            )
        )
    monkeypatch.setattr(
        bridge_module,
        "_PROVIDER_TRANSPORTS",
        {account.id: _FakeProviderTransport() for account in accounts},
    )
    monkeypatch.setattr(bridge_module, "_WHATSAPP_HEALTH_CONCURRENCY", 2)
    monkeypatch.setattr(bridge_module, "_WHATSAPP_HEALTH_PROBE_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(bridge_module, "_WHATSAPP_HEALTH_REQUEST_TIMEOUT_SECONDS", 0.15)
    active = 0
    peak = 0
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active, peak, calls
        calls += 1
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.Event().wait()
            raise AssertionError("outage unexpectedly completed")
        finally:
            active -= 1

    async with (
        httpx.AsyncClient(
            base_url=sidecar_url, transport=httpx.MockTransport(handler)
        ) as http_client,
        _sidecar_pool(http_client),
    ):
        statuses = await asyncio.wait_for(
            bridge_module.whatsapp_account_transport_statuses(accounts), timeout=0.5
        )
        assert len(statuses) == len(accounts)
        assert all(not value.available for value in statuses.values())
        assert all(value.reason == "provider-transport-unavailable" for value in statuses.values())
        assert active == 0
        assert peak == 2
        assert 2 <= calls <= 4
