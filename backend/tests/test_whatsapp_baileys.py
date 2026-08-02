from __future__ import annotations

import base64
import json
from typing import Any
from uuid import UUID

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import (
    MESSAGE_DIRECTION_INBOUND,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelMessage,
)
from app.routes.channel_routers.whatsapp import (
    _ack_whatsapp_websocket_inbox,
    _wait_whatsapp_websocket_inbox,
)
from app.services.channels import generate_agent_token, store_agent_link_token
from app.services.whatsapp_baileys import (
    MAX_NODE_COUNT,
    MAX_NODE_DEPTH,
    AgentBundle,
    AgentPreKey,
    AgentSignedPreKey,
    GroupCipherBackend,
    SignalSender,
    WhatsAppGroupParticipantAddress,
    WhatsAppGroupSenderKeyStore,
    WhatsAppInboxPump,
    WhatsAppInboxPumpEvent,
    WhatsAppPreparedInboundDelivery,
    WhatsAppSyntheticDeliveryResult,
    decide_whatsapp_relay,
    describe_whatsapp_jid_for_log,
    encode_buffer_json,
    encrypt_whatsapp_group_message_for_sender_key,
    forward_iq_over,
    mint_whatsapp_synthetic_creds,
    parse_agent_bundle,
    prepare_whatsapp_inbound_delivery,
    relay_outbound_extra_attrs,
    respond_to_iq,
    serialize_creds,
    strip_whatsapp_device,
    whatsapp_jid_candidates,
    whatsapp_message_proto_bytes,
    whatsapp_text_from_message_proto,
    whatsapp_text_message_proto,
)

pytestmark = [pytest.mark.usefixtures("channel_agent"), pytest.mark.committed_db]


def _physical_provider_event_payload(
    *,
    remote_jid: str,
    message_id: str,
    text: str,
    remote_jid_alt: str | None = None,
    participant: str | None = None,
    participant_alt: str | None = None,
    push_name: str | None = None,
    message_timestamp: int | None = None,
) -> dict[str, Any]:
    key: dict[str, Any] = {"remoteJid": remote_jid, "id": message_id, "fromMe": False}
    if remote_jid_alt:
        key["remoteJidAlt"] = remote_jid_alt
    if participant:
        key["participant"] = participant
    if participant_alt:
        key["participantAlt"] = participant_alt
    payload: dict[str, Any] = {
        "schemaVersion": "clawdi.whatsappBaileysProviderEvent.v1",
        "key": key,
        "messageProtoBase64": base64.b64encode(whatsapp_text_message_proto(text)).decode("ascii"),
    }
    if push_name:
        payload["pushName"] = push_name
    if message_timestamp:
        payload["messageTimestamp"] = message_timestamp
    return payload


async def _create_whatsapp_channel_with_existing_links(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    *,
    name: str,
    agents: tuple,
) -> tuple[dict[str, Any], list[ChannelBotAgentLink]]:
    """Seed pre-gate WhatsApp links while exercising current runtime routes."""
    response = await client.post(
        "/v1/channels",
        json={"provider": "whatsapp", "name": name},
    )
    assert response.status_code == 201, response.text
    created = response.json()
    links: list[ChannelBotAgentLink] = []
    for agent in agents:
        link = ChannelBotAgentLink(
            account_id=UUID(created["id"]),
            user_id=agent.user_id,
            agent_id=agent.id,
        )
        store_agent_link_token(link, generate_agent_token("whatsapp"))
        db_session.add(link)
        links.append(link)
    await db_session.commit()
    for link in links:
        await db_session.refresh(link)
    if links:
        created["agent_id"] = str(links[0].agent_id)
        created["agent_link_id"] = str(links[0].id)
    return created, links


def test_whatsapp_synthetic_creds_are_baileys_json_compatible_and_provider_secret_free():
    minted = mint_whatsapp_synthetic_creds(tenant_id="tenant-alpha")
    encoded = encode_buffer_json(minted.creds)
    serialized = serialize_creds(minted.creds)

    assert minted.jid.endswith("@s.whatsapp.net")
    assert len(minted.identity_pub_key) == 32
    assert encoded["noiseKey"]["public"]["type"] == "Buffer"
    assert encoded["me"]["id"] == minted.jid
    assert '"type":"Buffer"' in serialized
    assert "providerToken" not in serialized
    assert "physicalAuthState" not in serialized


def test_whatsapp_jid_helpers_resolve_lid_and_device_aliases():
    assert strip_whatsapp_device("15550000001:12@s.whatsapp.net") == "15550000001@s.whatsapp.net"
    assert whatsapp_jid_candidates("15550000001:0@s.whatsapp.net") == [
        "15550000001:0@s.whatsapp.net",
        "15550000001@s.whatsapp.net",
    ]
    assert whatsapp_jid_candidates("7826185388106@lid") == [
        "7826185388106@lid",
        "7826185388106@s.whatsapp.net",
    ]
    assert describe_whatsapp_jid_for_log("15550000001:12@s.whatsapp.net") == (
        "server=s.whatsapp.net device=true"
    )


def test_parse_agent_bundle_extracts_prekeys():
    identity = bytes(range(32))
    signed_prekey = bytes(range(32, 64))
    prekey = bytes(range(64, 96))
    iq = {
        "tag": "iq",
        "attrs": {"id": "upload-1", "xmlns": "encrypt", "type": "set"},
        "content": [
            {"tag": "registration", "attrs": {}, "content": (12345).to_bytes(4, "big")},
            {"tag": "identity", "attrs": {}, "content": b"\x05" + identity},
            {
                "tag": "list",
                "attrs": {},
                "content": [
                    {
                        "tag": "key",
                        "attrs": {},
                        "content": [
                            {"tag": "id", "attrs": {}, "content": (3).to_bytes(3, "big")},
                            {"tag": "value", "attrs": {}, "content": prekey},
                        ],
                    }
                ],
            },
            {
                "tag": "skey",
                "attrs": {},
                "content": [
                    {"tag": "id", "attrs": {}, "content": (7).to_bytes(3, "big")},
                    {"tag": "value", "attrs": {}, "content": signed_prekey},
                    {"tag": "signature", "attrs": {}, "content": bytes(64)},
                ],
            },
        ],
    }

    bundle = parse_agent_bundle(iq)

    assert bundle.registration_id == 12345
    assert bundle.identity_key == identity
    assert bundle.signed_pre_key.id == 7
    assert bundle.signed_pre_key.public_key == signed_prekey
    assert bundle.pre_keys == [AgentPreKey(id=3, public_key=prekey)]


def test_signal_sender_preserves_session_and_snapshot_contract():
    bundle = AgentBundle(
        registration_id=12345,
        identity_key=bytes(range(32)),
        signed_pre_key=AgentSignedPreKey(
            id=7,
            public_key=bytes(range(32, 64)),
            signature=bytes(range(64)),
        ),
        pre_keys=[
            AgentPreKey(id=3, public_key=bytes(range(64, 96))),
            AgentPreKey(id=4, public_key=bytes(range(96, 128))),
        ],
    )
    sender = SignalSender()

    first = sender.encrypt_for("15551112222", 0, bundle, b"first inbound")
    second = sender.encrypt_for("15551112222", 0, bundle, b"second inbound")

    assert first.type == "pkmsg"
    assert second.type == "pkmsg"
    assert [pre_key.id for pre_key in bundle.pre_keys] == [4]

    sender.mirror_session("15551112222", 0, "15557770000", 1)
    reply = sender.encrypt_from_established_session("15557770000", 1, b"agent reply")
    assert reply.type == "msg"
    assert sender.decrypt_from("15557770000", 1, reply) == b"agent reply"

    restored = SignalSender(sender.snapshot())
    after_restart = restored.encrypt_for("15551112222", 0, bundle, b"after restart")
    assert after_restart.type in {"pkmsg", "msg"}
    assert restored.snapshot().identity == sender.snapshot().identity

    signed_pre_key_only = SignalSender()
    no_prekey_bundle = AgentBundle(
        registration_id=12345,
        identity_key=bytes(range(32)),
        signed_pre_key=AgentSignedPreKey(
            id=7,
            public_key=bytes(range(32, 64)),
            signature=bytes(range(64)),
        ),
        pre_keys=[],
    )
    fallback = signed_pre_key_only.encrypt_for(
        "15551113333",
        0,
        no_prekey_bundle,
        b"signed pre-key fallback",
    )
    assert fallback.type == "pkmsg"


def test_group_cipher_backend_persists_sender_key_state_across_instances():
    class Store(WhatsAppGroupSenderKeyStore):
        def __init__(self) -> None:
            self.records: dict[str, dict[str, Any]] = {}

        def load(self, sender_key_name: str):
            return self.records.get(sender_key_name)

        def save(self, sender_key_name: str, snapshot: dict[str, Any]) -> None:
            self.records[sender_key_name] = dict(snapshot)

    group_jid = "120363012345678901@g.us"
    author_user = "15557770000"
    author_device = 1
    axolotl = b"sender-key-distribution-message"
    store = Store()

    first_backend = GroupCipherBackend(store=store)
    first_backend.process_skdm(
        group_jid=group_jid,
        author_user=author_user,
        author_device=author_device,
        axolotl_bytes=axolotl,
    )
    assert first_backend.has_sender_key(
        group_jid=group_jid,
        author_user=author_user,
        author_device=author_device,
    )
    first_ciphertext = encrypt_whatsapp_group_message_for_sender_key(
        axolotl_bytes=axolotl,
        plaintext=b"first",
    )
    assert (
        first_backend.decrypt_skmsg(
            group_jid=group_jid,
            author_user=author_user,
            author_device=author_device,
            ciphertext=first_ciphertext,
        )
        == b"first"
    )

    second_backend = GroupCipherBackend(store=store)
    assert second_backend.has_sender_key(
        group_jid=group_jid,
        author_user=author_user,
        author_device=author_device,
    )
    second_ciphertext = encrypt_whatsapp_group_message_for_sender_key(
        axolotl_bytes=axolotl,
        plaintext=b"second",
    )
    assert (
        second_backend.decrypt_skmsg(
            group_jid=group_jid,
            author_user=author_user,
            author_device=author_device,
            ciphertext=second_ciphertext,
        )
        == b"second"
    )


@pytest.mark.asyncio
async def test_whatsapp_inbox_pump_keeps_failed_delivery_unacked():
    events = [
        WhatsAppInboxPumpEvent(
            sequence=1,
            external_chat_id="15551234567@s.whatsapp.net",
            provider_message_id="wamid-1",
            text="hello-1",
            payload=_physical_provider_event_payload(
                remote_jid="15551234567@s.whatsapp.net",
                message_id="wamid-1",
                text="hello-1",
            ),
        ),
        WhatsAppInboxPumpEvent(
            sequence=2,
            external_chat_id="15551234567@s.whatsapp.net",
            provider_message_id="wamid-2",
            text="hello-2",
            payload=_physical_provider_event_payload(
                remote_jid="15551234567@s.whatsapp.net",
                message_id="wamid-2",
                text="hello-2",
            ),
        ),
    ]
    acked: list[int] = []
    errors: list[Exception] = []

    async def wait_for_events(_tenant_id: str, _after_sequence: int, _limit: int):
        return events

    async def ack(_tenant_id: str, through_sequence: int):
        acked.append(through_sequence)

    async def deliver(_prepared: WhatsAppPreparedInboundDelivery):
        raise RuntimeError("synthetic signal failure")

    pump = WhatsAppInboxPump(
        tenant_id="tenant-a",
        wait_for_events=wait_for_events,
        ack=ack,
        deliver=deliver,
        on_error=errors.append,
        retry_delay_seconds=0,
    )

    result = await pump.run_once()

    assert result.delivered == 0
    assert result.acked_through is None
    assert result.errors == 1
    assert acked == []
    assert len(errors) == 1


@pytest.mark.asyncio
async def test_whatsapp_inbox_pump_retries_transient_delivery_failure():
    event = WhatsAppInboxPumpEvent(
        sequence=1,
        external_chat_id="15551234567@s.whatsapp.net",
        provider_message_id="wamid-retry",
        text="hello retry",
        payload=_physical_provider_event_payload(
            remote_jid="15551234567@s.whatsapp.net",
            message_id="wamid-retry",
            text="hello retry",
        ),
    )
    acked: list[int] = []
    attempts = 0

    async def wait_for_events(_tenant_id: str, _after_sequence: int, _limit: int):
        return [event]

    async def ack(_tenant_id: str, through_sequence: int):
        acked.append(through_sequence)

    async def deliver(prepared: WhatsAppPreparedInboundDelivery):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("temporary synthetic signal failure")
        return WhatsAppSyntheticDeliveryResult(
            message_id=prepared.message_id,
            signal_jid=prepared.from_jid,
            enc_type="pkmsg",
            attrs={"from": prepared.from_jid},
        )

    pump = WhatsAppInboxPump(
        tenant_id="tenant-a",
        wait_for_events=wait_for_events,
        ack=ack,
        deliver=deliver,
        retry_delay_seconds=0,
    )

    await pump.run(max_iterations=2)

    assert attempts == 2
    assert acked == [1]


@pytest.mark.asyncio
async def test_whatsapp_inbox_pump_can_continue_after_idle_poll():
    wait_calls = 0

    async def wait_for_events(_tenant_id: str, _after_sequence: int, _limit: int):
        nonlocal wait_calls
        wait_calls += 1
        return []

    async def ack(_tenant_id: str, _through_sequence: int):
        raise AssertionError("idle pump should not ack")

    async def deliver(_prepared: WhatsAppPreparedInboundDelivery):
        raise AssertionError("idle pump should not deliver")

    pump = WhatsAppInboxPump(
        tenant_id="tenant-a",
        wait_for_events=wait_for_events,
        ack=ack,
        deliver=deliver,
        retry_delay_seconds=0,
    )

    await pump.run(max_iterations=3, stop_when_idle=False)

    assert wait_calls == 3


@pytest.mark.asyncio
async def test_whatsapp_inbox_pump_acks_malformed_rows_without_blocking():
    events = [
        WhatsAppInboxPumpEvent(
            sequence=1,
            external_chat_id="15551234567@s.whatsapp.net",
            payload={"schemaVersion": "invalid"},
        ),
        WhatsAppInboxPumpEvent(
            sequence=2,
            external_chat_id="15551234567@s.whatsapp.net",
            provider_message_id="wamid-good",
            text="hello good",
            payload=_physical_provider_event_payload(
                remote_jid="15551234567@s.whatsapp.net",
                message_id="wamid-good",
                text="hello good",
            ),
        ),
    ]
    acked: list[int] = []
    pushed: list[str] = []
    errors: list[Exception] = []

    async def wait_for_events(_tenant_id: str, _after_sequence: int, _limit: int):
        return events

    async def ack(_tenant_id: str, through_sequence: int):
        acked.append(through_sequence)

    async def deliver(prepared: WhatsAppPreparedInboundDelivery):
        pushed.append(prepared.message_id)
        return WhatsAppSyntheticDeliveryResult(
            message_id=prepared.message_id,
            signal_jid=prepared.from_jid,
            enc_type="pkmsg",
            attrs={"from": prepared.from_jid},
        )

    pump = WhatsAppInboxPump(
        tenant_id="tenant-a",
        wait_for_events=wait_for_events,
        ack=ack,
        deliver=deliver,
        on_error=errors.append,
    )

    result = await pump.run_once()

    assert result.delivered == 1
    assert result.errors == 1
    assert result.acked_through == 2
    assert acked == [2]
    assert pushed == ["wamid-good"]
    assert len(errors) == 1


@pytest.mark.asyncio
async def test_whatsapp_inbox_pump_records_safe_debug_and_prepares_lid_alias():
    class DebugEvents:
        def __init__(self) -> None:
            self.records: list[dict[str, Any]] = []

        def record(self, payload: dict[str, Any]) -> None:
            self.records.append(payload)

    event = WhatsAppInboxPumpEvent(
        sequence=13,
        external_chat_id="184207372460253@lid",
        provider_message_id="wamid-lid",
        text="hello secret",
        payload=_physical_provider_event_payload(
            remote_jid="184207372460253@lid",
            remote_jid_alt="15551234567@s.whatsapp.net",
            message_id="wamid-lid",
            text="hello secret",
            push_name="Alice",
            message_timestamp=1_700_000_000,
        ),
    )
    debug_events = DebugEvents()
    pushed: list[WhatsAppPreparedInboundDelivery] = []

    async def wait_for_events(_tenant_id: str, _after_sequence: int, _limit: int):
        return [event]

    async def ack(_tenant_id: str, _through_sequence: int):
        return None

    async def deliver(prepared: WhatsAppPreparedInboundDelivery):
        pushed.append(prepared)
        return WhatsAppSyntheticDeliveryResult(
            message_id=prepared.message_id,
            signal_jid=prepared.from_jid,
            enc_type="pkmsg",
            attrs={
                "from": prepared.from_jid,
                "sender_pn": prepared.sender_pn_jid or "",
                "addressing_mode": "lid",
            },
        )

    pump = WhatsAppInboxPump(
        tenant_id="tenant-a",
        wait_for_events=wait_for_events,
        ack=ack,
        deliver=deliver,
        debug_events=debug_events,
    )

    result = await pump.run_once()

    assert result.delivered == 1
    assert pushed[0] == prepare_whatsapp_inbound_delivery(event)
    assert pushed[0].from_jid == "184207372460253@lid"
    assert pushed[0].sender_lid_jid == "184207372460253@lid"
    assert pushed[0].sender_pn_jid == "15551234567@s.whatsapp.net"
    assert pushed[0].push_name == "Alice"
    assert pushed[0].timestamp == 1_700_000_000
    assert debug_events.records[0]["stage"] == "inbox_delivery_prepare"
    assert debug_events.records[0]["details"]["message"]["protoBytes"] > 0
    assert debug_events.records[0]["details"]["message"]["textLength"] == len("hello secret")
    assert "textSha256" in debug_events.records[0]["details"]["message"]
    assert debug_events.records[1]["details"]["encType"] == "pkmsg"
    assert "hello secret" not in json.dumps(debug_events.records)


def test_prepare_whatsapp_inbound_delivery_preserves_group_participant():
    message_proto = whatsapp_text_message_proto("hello group")
    prepared = prepare_whatsapp_inbound_delivery(
        WhatsAppInboxPumpEvent(
            sequence=14,
            external_chat_id="199900000000000001@g.us",
            provider_message_id="group-1",
            text="hello group",
            payload=_physical_provider_event_payload(
                remote_jid="199900000000000001@g.us",
                message_id="group-1",
                text="hello group",
                participant="10000000001@s.whatsapp.net",
                participant_alt="184207372460253@lid",
                push_name="Alice",
                message_timestamp=1_700_000_001,
            ),
        )
    )

    assert prepared.from_jid == "199900000000000001@g.us"
    assert prepared.participant_jid == "10000000001@s.whatsapp.net"
    assert prepared.participant_lid_jid == "184207372460253@lid"
    assert prepared.push_name == "Alice"
    assert prepared.timestamp == 1_700_000_001
    assert whatsapp_message_proto_bytes(prepared.payload, prepared.text) == message_proto
    assert whatsapp_text_from_message_proto(message_proto) == "hello group"


def test_whatsapp_inbox_requires_exact_provider_proto():
    with pytest.raises(ValueError, match="missing exact message proto"):
        whatsapp_message_proto_bytes({"message": {"conversation": "reconstruct me"}}, "fallback")
    with pytest.raises(ValueError, match="invalid message proto"):
        whatsapp_message_proto_bytes({"messageProtoBase64": "not-base64"}, None)


@pytest.mark.asyncio
async def test_respond_to_iq_handles_key_usync_and_group_shapes():
    bundle = AgentBundle(
        registration_id=1,
        identity_key=bytes(range(32)),
        signed_pre_key=AgentSignedPreKey(
            id=2, public_key=bytes(range(32, 64)), signature=bytes(64)
        ),
        pre_keys=[AgentPreKey(id=3, public_key=bytes(range(64, 96)))],
    )
    key_response = await respond_to_iq(
        {
            "tag": "iq",
            "attrs": {"id": "keys", "xmlns": "encrypt", "type": "get"},
            "content": [
                {
                    "tag": "key",
                    "attrs": {},
                    "content": [{"tag": "user", "attrs": {"jid": "15551112222@s.whatsapp.net"}}],
                }
            ],
        },
        pre_key_count=0,
        agent_user=None,
        resolve_recipient_bundle=lambda _jid: bundle,
    )
    assert key_response["attrs"]["id"] == "keys"
    assert key_response["content"][0]["content"][0]["tag"] == "registration"

    group_response = await respond_to_iq(
        {
            "tag": "iq",
            "attrs": {"id": "group", "xmlns": "w:g2", "type": "get", "to": "123@g.us"},
            "content": [{"tag": "query", "attrs": {"request": "interactive"}}],
        },
        pre_key_count=0,
        agent_user="15557770000",
        agent_lid="900000000000004:1@lid",
        resolve_group_participants=lambda _jid: [
            WhatsAppGroupParticipantAddress(
                jid="7826185388106@lid",
                lid_jid="7826185388106@lid",
                pn_jid="15551112222@s.whatsapp.net",
            )
        ],
    )
    group = group_response["content"][0]
    assert group["attrs"]["addressing_mode"] == "lid"
    assert {
        "tag": "participant",
        "attrs": {
            "jid": "900000000000004@lid",
            "phone_number": "15557770000@s.whatsapp.net",
            "type": "superadmin",
        },
    } in group["content"]


def test_decide_whatsapp_relay_bounds_and_receipts():
    bound = {
        "15550000001@s.whatsapp.net": "15550000001@s.whatsapp.net",
        "987654@g.us": "987654@g.us",
    }

    relayed = decide_whatsapp_relay(
        {
            "tag": "chatstate",
            "attrs": {
                "from": "tenant-device@s.whatsapp.net",
                "name": "tenant-name",
                "to": "15550000001@s.whatsapp.net",
            },
            "content": [{"tag": "composing", "attrs": {"name": "nested"}}],
        },
        resolve_jid=bound.get,
        lookup_inbound_sender=lambda _id: None,
    )

    assert relayed.action == "relay"
    assert relayed.node is not None
    assert relayed.node["attrs"] == {"to": "15550000001@s.whatsapp.net"}
    assert relayed.node["content"][0]["attrs"] == {}

    dropped = decide_whatsapp_relay(
        {
            "tag": "receipt",
            "attrs": {
                "type": "read",
                "to": "987654@g.us",
                "id": "MSG-A",
                "participant": "5550999@s.whatsapp.net",
            },
        },
        resolve_jid=bound.get,
        lookup_inbound_sender=lambda _id: "5550001@s.whatsapp.net",
    )
    assert dropped.action == "drop"
    assert dropped.reason == "receipt-participant-mismatch"


def test_decide_whatsapp_relay_matches_msg_router_security_policy():
    bound = {
        "15550000001@s.whatsapp.net": "15550000001@s.whatsapp.net",
        "111122223333@lid": "111122223333@lid",
        "987654@g.us": "987654@g.us",
    }

    assert (
        decide_whatsapp_relay(
            {"tag": "presence", "attrs": {"type": "available"}},
            resolve_jid=bound.get,
            lookup_inbound_sender=lambda _id: None,
        ).reason
        == "no-to-attr"
    )
    assert (
        decide_whatsapp_relay(
            {"tag": "ack", "attrs": {"to": "15550000001@s.whatsapp.net"}},
            resolve_jid=bound.get,
            lookup_inbound_sender=lambda _id: None,
        ).reason
        == "tag-not-allowlisted"
    )
    assert (
        decide_whatsapp_relay(
            {
                "tag": "presence",
                "attrs": {
                    "to": "15550000001@s.whatsapp.net",
                    "recipient": "15550000002@s.whatsapp.net",
                },
            },
            resolve_jid=bound.get,
            lookup_inbound_sender=lambda _id: None,
        ).reason
        == "unbound-jid"
    )

    relayed = decide_whatsapp_relay(
        {
            "tag": "chatstate",
            "attrs": {
                "type": "composing",
                "to": "15550000001@s.whatsapp.net",
                "recipient": "111122223333@lid",
            },
        },
        resolve_jid=bound.get,
        lookup_inbound_sender=lambda _id: None,
    )
    assert relayed.action == "relay"
    assert relayed.node is not None
    assert relayed.node["attrs"]["recipient"] == "111122223333@lid"


def test_decide_whatsapp_relay_validates_group_receipt_batches_strictly():
    bound = {
        "15550000001@s.whatsapp.net": "15550000001@s.whatsapp.net",
        "987654@g.us": "987654@g.us",
    }
    valid_batch = {
        "tag": "receipt",
        "attrs": {
            "type": "read",
            "to": "987654@g.us",
            "id": "MSG-A",
            "participant": "5550001@s.whatsapp.net",
        },
        "content": [
            {
                "tag": "list",
                "attrs": {},
                "content": [
                    {"tag": "item", "attrs": {"id": "MSG-B"}},
                    {"tag": "item", "attrs": {"id": "MSG-C"}},
                ],
            }
        ],
    }
    relayed = decide_whatsapp_relay(
        valid_batch,
        resolve_jid=bound.get,
        lookup_inbound_sender=lambda message_id: (
            "5550001@s.whatsapp.net" if message_id in {"MSG-A", "MSG-B", "MSG-C"} else None
        ),
    )
    assert relayed.action == "relay"

    unknown_sub_id = {
        **valid_batch,
        "content": [
            {
                "tag": "list",
                "attrs": {},
                "content": [
                    {"tag": "item", "attrs": {"id": "MSG-B"}},
                    {"tag": "item", "attrs": {"id": "FAKE-SUB"}},
                ],
            }
        ],
    }
    assert (
        decide_whatsapp_relay(
            unknown_sub_id,
            resolve_jid=bound.get,
            lookup_inbound_sender=lambda message_id: (
                "5550001@s.whatsapp.net" if message_id in {"MSG-A", "MSG-B"} else None
            ),
        ).reason
        == "receipt-id-unknown"
    )

    malformed = {
        **valid_batch,
        "content": [
            {
                "tag": "list",
                "attrs": {},
                "content": [
                    {
                        "tag": "item",
                        "attrs": {"id": "MSG-B"},
                        "content": [{"tag": "extra", "attrs": {"id": "SMUGGLED"}}],
                    }
                ],
            }
        ],
    }
    assert (
        decide_whatsapp_relay(
            malformed,
            resolve_jid=bound.get,
            lookup_inbound_sender=lambda _id: "5550001@s.whatsapp.net",
        ).reason
        == "receipt-malformed"
    )

    recipient_group = {
        "tag": "receipt",
        "attrs": {
            "type": "read",
            "to": "15550000001@s.whatsapp.net",
            "recipient": "987654@g.us",
            "id": "MSG-A",
        },
    }
    assert (
        decide_whatsapp_relay(
            recipient_group,
            resolve_jid=bound.get,
            lookup_inbound_sender=lambda _id: None,
        ).reason
        == "receipt-malformed"
    )


def test_decide_whatsapp_relay_enforces_node_depth_and_width_caps():
    bound = {"15550000001@s.whatsapp.net": "15550000001@s.whatsapp.net"}

    depth_boundary = {
        "tag": "presence",
        "attrs": {"to": "15550000001@s.whatsapp.net"},
        "content": [],
    }
    cursor = depth_boundary
    for _ in range(MAX_NODE_DEPTH):
        child = {"tag": "x", "attrs": {}, "content": []}
        cursor["content"].append(child)
        cursor = child
    assert (
        decide_whatsapp_relay(
            depth_boundary,
            resolve_jid=bound.get,
            lookup_inbound_sender=lambda _id: None,
        ).action
        == "relay"
    )

    too_deep = {
        "tag": "presence",
        "attrs": {"to": "15550000001@s.whatsapp.net"},
        "content": [],
    }
    cursor = too_deep
    for _ in range(MAX_NODE_DEPTH + 1):
        child = {"tag": "x", "attrs": {}, "content": []}
        cursor["content"].append(child)
        cursor = child
    assert (
        decide_whatsapp_relay(
            too_deep,
            resolve_jid=bound.get,
            lookup_inbound_sender=lambda _id: None,
        ).reason
        == "node-too-deep"
    )

    width_boundary = {
        "tag": "presence",
        "attrs": {"to": "15550000001@s.whatsapp.net"},
        "content": [{"tag": "x", "attrs": {}} for _ in range(MAX_NODE_COUNT - 1)],
    }
    assert (
        decide_whatsapp_relay(
            width_boundary,
            resolve_jid=bound.get,
            lookup_inbound_sender=lambda _id: None,
        ).action
        == "relay"
    )

    too_wide = {
        "tag": "presence",
        "attrs": {"to": "15550000001@s.whatsapp.net"},
        "content": [{"tag": "x", "attrs": {}} for _ in range(MAX_NODE_COUNT)],
    }
    assert (
        decide_whatsapp_relay(
            too_wide,
            resolve_jid=bound.get,
            lookup_inbound_sender=lambda _id: None,
        ).reason
        == "node-too-wide"
    )


@pytest.mark.asyncio
async def test_respond_to_iq_forwarding_policy_matches_msg_router():
    forwarded: list[tuple[dict[str, Any], str | None]] = []

    async def forward(req: dict[str, Any], tenant_id: str | None):
        forwarded.append((req, tenant_id))
        if req["attrs"]["id"] == "null-forward":
            return None
        return {
            "tag": "iq",
            "attrs": {"id": req["attrs"]["id"], "type": "result", "from": "s.whatsapp.net"},
            "content": [{"tag": "forwarded", "attrs": {"xmlns": req["attrs"]["xmlns"]}}],
        }

    forwarded_get = await respond_to_iq(
        {
            "tag": "iq",
            "attrs": {"id": "w-get", "xmlns": "w", "type": "get"},
            "content": [{"tag": "props", "attrs": {}}],
        },
        pre_key_count=0,
        agent_user=None,
        tenant_id="tenant-a",
        forward_iq=forward,
    )
    assert forwarded_get["content"][0]["attrs"]["xmlns"] == "w"
    assert forwarded[-1][1] == "tenant-a"

    forwarded_set = await respond_to_iq(
        {
            "tag": "iq",
            "attrs": {"id": "media-set", "xmlns": "w:m", "type": "set"},
            "content": [{"tag": "media_conn", "attrs": {}}],
        },
        pre_key_count=0,
        agent_user=None,
        forward_iq=forward,
    )
    assert forwarded_set["content"][0]["attrs"]["xmlns"] == "w:m"

    forwarded_privacy = await respond_to_iq(
        {
            "tag": "iq",
            "attrs": {"id": "privacy-get", "xmlns": "privacy", "type": "get"},
            "content": [{"tag": "privacy", "attrs": {}}],
        },
        pre_key_count=0,
        agent_user=None,
        forward_iq=forward,
    )
    assert forwarded_privacy["attrs"]["id"] == "privacy-get"
    assert forwarded_privacy["content"][0]["attrs"]["xmlns"] == "privacy"

    null_forward = await respond_to_iq(
        {
            "tag": "iq",
            "attrs": {"id": "null-forward", "xmlns": "w", "type": "get"},
            "content": [{"tag": "props", "attrs": {}}],
        },
        pre_key_count=0,
        agent_user=None,
        forward_iq=forward,
    )
    assert null_forward["attrs"]["id"] == "null-forward"
    assert "content" not in null_forward


@pytest.mark.asyncio
async def test_forward_iq_over_strips_agent_id_and_restores_response_id():
    calls: list[dict[str, Any]] = []

    async def query(node: dict[str, Any], timeout_ms: int):
        calls.append({"node": node, "timeout_ms": timeout_ms})
        return {
            "tag": "iq",
            "attrs": {
                "id": "upstream-generated-id",
                "type": "result",
                "from": "s.whatsapp.net",
            },
            "content": [{"tag": "props", "attrs": {"hash": "xyz"}}],
        }

    original = {
        "tag": "iq",
        "attrs": {"id": "agent-q-7", "xmlns": "w", "type": "get", "to": "s.whatsapp.net"},
        "content": [{"tag": "props", "attrs": {}}],
    }
    response = await forward_iq_over(query, original)

    assert calls[0]["node"]["attrs"].get("id") is None
    assert calls[0]["node"]["attrs"]["xmlns"] == "w"
    assert calls[0]["timeout_ms"] == 15_000
    assert response is not None
    assert response["attrs"]["id"] == "agent-q-7"
    assert response["attrs"]["type"] == "result"
    assert response["content"] == [{"tag": "props", "attrs": {"hash": "xyz"}}]
    assert original["attrs"]["id"] == "agent-q-7"


@pytest.mark.asyncio
async def test_forward_iq_over_returns_none_on_upstream_failure_or_empty_response():
    async def raises(_node: dict[str, Any], _timeout_ms: int):
        raise RuntimeError("upstream timeout")

    async def empty(_node: dict[str, Any], _timeout_ms: int):
        return None

    node = {"tag": "iq", "attrs": {"id": "agent-q", "xmlns": "w", "type": "get"}}
    assert await forward_iq_over(raises, node) is None
    assert await forward_iq_over(empty, node) is None


def test_relay_outbound_extra_attrs_preserves_agent_controlled_attrs():
    assert relay_outbound_extra_attrs(
        {
            "id": "agent-msg-id",
            "to": "5550000@s.whatsapp.net",
            "type": "text",
            "edit": "1",
            "addressing_mode": "lid",
            "category": "peer",
        }
    ) == {
        "edit": "1",
        "addressing_mode": "lid",
        "category": "peer",
    }


def test_relay_outbound_extra_attrs_strips_relay_managed_attrs():
    assert (
        relay_outbound_extra_attrs(
            {
                "id": "x",
                "to": "x@s.whatsapp.net",
                "from": "x@s.whatsapp.net",
                "type": "text",
                "recipient": "y@s.whatsapp.net",
                "participant": "z@s.whatsapp.net",
            }
        )
        == {}
    )
    assert relay_outbound_extra_attrs({"id": "x", "to": "g@g.us", "edit": "8"}) == {"edit": "8"}


@pytest.mark.asyncio
async def test_respond_to_iq_refuses_missing_id():
    with pytest.raises(ValueError, match="attrs.id"):
        await respond_to_iq(
            {
                "tag": "iq",
                "attrs": {"xmlns": "encrypt", "type": "get"},
                "content": [{"tag": "count", "attrs": {}}],
            },
            pre_key_count=0,
            agent_user=None,
        )


@pytest.mark.asyncio
async def test_whatsapp_websocket_inbox_is_scoped_to_agent_link(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
):
    created, links = await _create_whatsapp_channel_with_existing_links(
        client,
        db_session,
        name="wa-link-scoped-inbox",
        agents=(channel_agent, second_channel_agent),
    )
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None

    messages: list[ChannelMessage] = []
    for link, chat_id, text in (
        (links[0], "15551110000@s.whatsapp.net", "default message"),
        (links[1], "15551110001@s.whatsapp.net", "workspace message"),
    ):
        link_id = link.id
        binding = ChannelBinding(
            account_id=account.id,
            bot_agent_link_id=link_id,
            user_id=account.user_id,
            external_chat_id=chat_id,
            external_chat_type="private",
            external_chat_name="Shared Contact",
        )
        db_session.add(binding)
        await db_session.flush()
        message = ChannelMessage(
            account_id=account.id,
            bot_agent_link_id=link_id,
            binding_id=binding.id,
            user_id=account.user_id,
            direction=MESSAGE_DIRECTION_INBOUND,
            external_chat_id=binding.external_chat_id,
            provider_message_id=f"msg-{link_id}",
            text=text,
            payload=_physical_provider_event_payload(
                remote_jid=binding.external_chat_id,
                message_id=f"msg-{link_id}",
                text=text,
            ),
        )
        db_session.add(message)
        messages.append(message)
    await db_session.commit()

    default_events = await _wait_whatsapp_websocket_inbox(
        account_id=account.id,
        bot_agent_link_id=links[0].id,
        after_sequence=0,
        limit=10,
    )
    workspace_events = await _wait_whatsapp_websocket_inbox(
        account_id=account.id,
        bot_agent_link_id=links[1].id,
        after_sequence=0,
        limit=10,
    )

    assert [event.text for event in default_events] == ["default message"]
    assert [event.text for event in workspace_events] == ["workspace message"]

    await _ack_whatsapp_websocket_inbox(
        account_id=account.id,
        bot_agent_link_id=links[0].id,
        through_sequence=messages[0].inbox_sequence,
    )
    await db_session.rollback()
    default_message = (
        await db_session.execute(
            select(ChannelMessage)
            .where(ChannelMessage.id == messages[0].id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    workspace_message = (
        await db_session.execute(
            select(ChannelMessage)
            .where(ChannelMessage.id == messages[1].id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert default_message is not None and default_message.delivered_at is not None
    assert workspace_message is not None and workspace_message.delivered_at is None
