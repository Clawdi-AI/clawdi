from __future__ import annotations

import json
from typing import Any
from uuid import UUID

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import (
    BINDING_STATUS_ARCHIVED,
    MESSAGE_DIRECTION_INBOUND,
    ChannelAccount,
    ChannelAgentCredential,
    ChannelBinding,
    ChannelBindingAlias,
    ChannelMessage,
)
from app.routes.channel_routers.whatsapp import (
    _ack_whatsapp_websocket_inbox,
    _wait_whatsapp_websocket_inbox,
)
from app.services.vault_crypto import decrypt
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
    mint_tenant_creds,
    parse_agent_bundle,
    prepare_whatsapp_inbound_delivery,
    relay_outbound_extra_attrs,
    resolve_whatsapp_credential_by_identity,
    respond_to_iq,
    rewrite_whatsapp_media_to_proxy_url,
    rewrite_whatsapp_media_to_upstream_url,
    serialize_creds,
    strip_whatsapp_device,
    whatsapp_cloud_outbound_payload_from_proto,
    whatsapp_jid_candidates,
    whatsapp_media_reupload_candidate_from_proto,
    whatsapp_message_proto_bytes,
)

pytestmark = pytest.mark.usefixtures("channel_agent")


class _FakeMediaResponse:
    status_code = 206
    content = b"encrypted-media"
    headers = {
        "content-type": "application/octet-stream",
        "content-length": "15",
        "content-range": "bytes 0-14/99",
        "accept-ranges": "bytes",
        "x-private": "drop",
    }


class _FakeMediaClient:
    calls: list[dict[str, Any]] = []

    def __init__(self, *, timeout: float, follow_redirects: bool):
        self.timeout = timeout
        self.follow_redirects = follow_redirects

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def request(self, method: str, url: str, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})
        return _FakeMediaResponse()


def test_whatsapp_tenant_creds_are_baileys_json_compatible():
    minted = mint_tenant_creds(tenant_id="tenant-alpha")
    encoded = encode_buffer_json(minted.creds)
    serialized = serialize_creds(minted.creds)

    assert minted.jid.endswith("@s.whatsapp.net")
    assert len(minted.identity_pub_key) == 32
    assert encoded["noiseKey"]["public"]["type"] == "Buffer"
    assert encoded["me"]["id"] == minted.jid
    assert '"type":"Buffer"' in serialized


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
            payload={"message": {"conversation": "hello-1"}},
        ),
        WhatsAppInboxPumpEvent(
            sequence=2,
            external_chat_id="15551234567@s.whatsapp.net",
            provider_message_id="wamid-2",
            text="hello-2",
            payload={"message": {"conversation": "hello-2"}},
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
        payload={"message": {"conversation": "hello retry"}},
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
            payload={"message": {"conversation": "missing id"}},
        ),
        WhatsAppInboxPumpEvent(
            sequence=2,
            external_chat_id="15551234567@s.whatsapp.net",
            provider_message_id="wamid-good",
            text="hello good",
            payload={"message": {"conversation": "hello good"}},
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
        payload={
            "message": {"conversation": "hello secret"},
            "messageTimestamp": "1700000000",
            "pushName": "Alice",
            "senderPnJid": "15551234567@s.whatsapp.net",
        },
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
    assert debug_events.records[0]["details"]["message"]["topLevelKinds"] == ["conversation"]
    assert debug_events.records[0]["details"]["message"]["textLength"] == len("hello secret")
    assert "textSha256" in debug_events.records[0]["details"]["message"]
    assert debug_events.records[1]["details"]["encType"] == "pkmsg"
    assert "hello secret" not in json.dumps(debug_events.records)


def test_prepare_whatsapp_inbound_delivery_preserves_group_participant():
    prepared = prepare_whatsapp_inbound_delivery(
        WhatsAppInboxPumpEvent(
            sequence=14,
            external_chat_id="199900000000000001@g.us",
            provider_message_id="group-1",
            text="hello group",
            payload={
                "key": {
                    "remoteJid": "199900000000000001@g.us",
                    "participant": "10000000001@s.whatsapp.net",
                    "id": "group-1",
                },
                "message": {"extendedTextMessage": {"text": "hello group"}},
                "participantLidJid": "184207372460253@lid",
                "pushName": "Alice",
                "messageTimestamp": 1_700_000_001,
            },
        )
    )

    assert prepared.from_jid == "199900000000000001@g.us"
    assert prepared.participant_jid == "10000000001@s.whatsapp.net"
    assert prepared.participant_lid_jid == "184207372460253@lid"
    assert prepared.push_name == "Alice"
    assert prepared.timestamp == 1_700_000_001


def test_whatsapp_message_proto_bytes_encodes_common_text_shapes():
    assert (
        whatsapp_message_proto_bytes(
            {"message": {"conversation": "hello"}},
            text=None,
        )
        == b"\x0a\x05hello"
    )
    assert (
        whatsapp_message_proto_bytes(
            {"message": {"extendedTextMessage": {"text": "hi"}}},
            text=None,
        )
        == b"\x32\x04\x0a\x02hi"
    )
    assert whatsapp_message_proto_bytes({}, text="fallback") == b"\x0a\x08fallback"


def test_whatsapp_message_proto_bytes_preserves_quoted_reply_fixture_shape():
    payload = {
        "message": {
            "extendedTextMessage": {
                "text": "reply that quotes the base",
                "contextInfo": {
                    "stanzaId": "3EB0CA8C2FE5219FEA4DF0",
                    "participant": "10000000001@s.whatsapp.net",
                    "quotedMessage": {
                        "extendedTextMessage": {"text": "quoted base message"}
                    },
                },
            },
            "messageContextInfo": {
                "messageSecret": "vKvmc0ZE06OymNK0bXCMwEiS8jo/wWvZsjvfIkPbN5w=",
            },
        },
    }

    assert (
        whatsapp_message_proto_bytes(payload, text=None).hex()
        == "326c0a1a7265706c7920746861742071756f746573207468652062617365"
        "8a014d0a1633454230434138433246453532313946454134444630121a31"
        "3030303030303030303140732e77686174736170702e6e65741a1732150a"
        "1371756f7465642062617365206d6573736167659a02221a20bcabe67346"
        "44d3a3b298d2b46d708cc04892f23a3fc16bd9b23bdf2243db379c"
    )


def test_whatsapp_message_proto_bytes_preserves_image_fixture_shape():
    payload = {
        "message": {
            "imageMessage": {
                "url": "https://mmg.whatsapp.net/o1/v/test",
                "mimetype": "image/jpeg",
                "caption": "tiny red dot",
                "fileSha256": "KdcSnkLwicTqmqTyKjnU8Qfj5AxI6GMpYYddPdftzFk=",
                "fileLength": "70",
                "mediaKey": "8N6ORZLxSd3MHhbHAnsVAeX4ss4495v05BrZG1scD68=",
                "fileEncSha256": "R5OoBhcXEODfbD2lAkxWLsp2r4NBfE3oFE9kfF1h0NU=",
                "directPath": "/o1/v/test",
                "mediaKeyTimestamp": "1776548383",
            },
            "messageContextInfo": {
                "messageSecret": "z48qzbAvo2C1mkyj8C5YlQcKC28Zk8XoygQ+1ikI5Xc=",
            },
        },
    }

    assert (
        whatsapp_message_proto_bytes(payload, text=None).hex()
        == "1ab8010a2268747470733a2f2f6d6d672e77686174736170702e6e65742f"
        "6f312f762f74657374120a696d6167652f6a7065671a0c74696e79207265"
        "6420646f74222029d7129e42f089c4ea9aa4f22a39d4f107e3e40c48e86"
        "32961875d3dd7edcc5928464220f0de8e4592f149ddcc1e16c7027b1501"
        "e5f8b2ce38f79bf4e41ad91b5b1c0faf4a204793a806171710e0df6c3d"
        "a5024c562eca76af83417c4de8144f647c5d61d0d55a0a2f6f312f762f74"
        "657374609ff48fcf069a02221a20cf8f2acdb02fa360b59a4ca3f02e58"
        "95070a0b6f1993c5e8ca043ed62908e577"
    )


def test_whatsapp_message_proto_bytes_preserves_audio_fixture_shape():
    payload = {
        "message": {
            "audioMessage": {
                "mimetype": "audio/ogg; codecs=opus",
                "url": "https://mmg.whatsapp.net/o1/voice",
                "directPath": "/v/t62.7117-24/voice",
                "mediaKey": "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
                "fileSha256": "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=",
                "fileEncSha256": "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=",
                "fileLength": 4,
                "seconds": 1,
                "ptt": True,
            },
        },
    }

    expected = (
        "42bd010a2168747470733a2f2f6d6d672e77686174736170702e6e65742f6f312f766f6963651216"
        "617564696f2f6f67673b20636f646563733d6f7075731a2005050505050505050505050505050505"
        "050505050505050505050505050505052004280130013a2004040404040404040404040404040404"
        "04040404040404040404040404040404422006060606060606060606060606060606060606060606"
        "060606060606060606064a142f762f7436322e373131372d32342f766f696365"
    )

    assert whatsapp_message_proto_bytes(payload, text=None).hex() == expected


def test_whatsapp_message_proto_bytes_preserves_group_sender_key_fixture_shape():
    payload = {
        "message": {
            "senderKeyDistributionMessage": {
                "groupId": "199900000000000001@g.us",
                "axolotlSenderKeyDistributionMessage": (
                    "Mwjx7K+7BRAAGiCmflaKkWoXIi3uwdEz6NS3ILO9YvGs6EY4mFDEVpQ"
                    "BsCIhBa0TbC8zpFxWFBky2egVLSS8+BwXKemF4AZFGlj5ihsU="
                ),
            },
            "extendedTextMessage": {
                "text": "scenario 08 group from alice [1/2]",
            },
            "messageContextInfo": {
                "messageSecret": "GatUnpb8euwrXMEgWQfXdPod+T6z3F0YtfyDcOLU/jw=",
            },
        },
    }

    assert (
        whatsapp_message_proto_bytes(payload, text=None).hex()
        == "12690a1731393939303030303030303030303030303140672e7573124e33"
        "08f1ecafbb0510001a20a67e568a916a17222deec1d133e8d4b720b3bd"
        "62f1ace846389850c4569401b0222105ad136c2f33a45c56141932d9e8"
        "152d24bcf81c1729e985e006451a58f98a1b1432240a227363656e6172"
        "696f2030382067726f75702066726f6d20616c696365205b312f325d9a"
        "02221a2019ab549e96fc7aec2b5cc1205907d774fa1df93eb3dc5d18b"
        "5fc8370e2d4fe3c"
    )


def test_whatsapp_cloud_outbound_payload_maps_quoted_reply_context():
    proto = whatsapp_message_proto_bytes(
        {
            "message": {
                "extendedTextMessage": {
                    "text": "reply that quotes the base",
                    "contextInfo": {
                        "stanzaId": "3EB0CA8C2FE5219FEA4DF0",
                        "participant": "10000000001@s.whatsapp.net",
                    },
                }
            }
        },
        text=None,
    )

    result = whatsapp_cloud_outbound_payload_from_proto(proto)

    assert result.outcome == "sendable"
    assert result.kind == "extended_text"
    assert result.text == "reply that quotes the base"
    assert result.provider_payload == {
        "type": "text",
        "text": {"body": "reply that quotes the base"},
        "context": {"message_id": "3EB0CA8C2FE5219FEA4DF0"},
    }


def test_whatsapp_cloud_outbound_payload_maps_public_image_link():
    proto = whatsapp_message_proto_bytes(
        {
            "message": {
                "imageMessage": {
                    "url": "https://cdn.example.test/red-dot.jpg",
                    "mimetype": "image/jpeg",
                    "caption": "tiny red dot",
                }
            }
        },
        text=None,
    )

    result = whatsapp_cloud_outbound_payload_from_proto(proto)

    assert result.outcome == "sendable"
    assert result.kind == "image"
    assert result.text == "tiny red dot"
    assert result.provider_payload == {
        "type": "image",
        "image": {
            "link": "https://cdn.example.test/red-dot.jpg",
            "caption": "tiny red dot",
        },
    }


def test_whatsapp_cloud_outbound_payload_requires_native_for_encrypted_image():
    media_key = bytes(range(32))
    proto = whatsapp_message_proto_bytes(
        {
            "message": {
                "imageMessage": {
                    "url": "https://mmg.whatsapp.net/o1/v/test",
                    "mimetype": "image/png",
                    "caption": "tiny red dot",
                    "mediaKey": media_key,
                    "fileSha256": b"plain-sha",
                    "fileEncSha256": b"encrypted-sha",
                    "directPath": "/o1/v/test",
                }
            }
        },
        text=None,
    )

    result = whatsapp_cloud_outbound_payload_from_proto(proto)

    assert result.outcome == "native_required"
    assert result.kind == "image"
    assert result.text == "tiny red dot"
    assert result.reason == "media-reupload-required"

    candidate = whatsapp_media_reupload_candidate_from_proto(proto)
    assert candidate is not None
    assert candidate.kind == "image"
    assert candidate.source_url == "https://mmg.whatsapp.net/o1/v/test"
    assert candidate.mimetype == "image/png"
    assert candidate.media_key == media_key
    assert candidate.file_sha256 == b"plain-sha"
    assert candidate.file_enc_sha256 == b"encrypted-sha"
    assert candidate.text == "tiny red dot"


def test_whatsapp_cloud_outbound_payload_maps_public_audio_link():
    proto = whatsapp_message_proto_bytes(
        {
            "message": {
                "audioMessage": {
                    "url": "https://cdn.example.test/voice.ogg",
                    "mimetype": "audio/ogg; codecs=opus",
                }
            }
        },
        text=None,
    )

    result = whatsapp_cloud_outbound_payload_from_proto(proto)

    assert result.outcome == "sendable"
    assert result.kind == "audio"
    assert result.provider_payload == {
        "type": "audio",
        "audio": {"link": "https://cdn.example.test/voice.ogg"},
    }


def test_whatsapp_media_reupload_candidate_maps_encrypted_audio():
    media_key = bytes(range(32, 64))
    proto = whatsapp_message_proto_bytes(
        {
            "message": {
                "audioMessage": {
                    "url": "https://mmg.whatsapp.net/o1/audio",
                    "directPath": "/v/t62.7117-24/audio",
                    "mediaKey": media_key,
                    "fileSha256": b"plain-audio-sha",
                    "fileEncSha256": b"encrypted-audio-sha",
                    "mimetype": "audio/ogg; codecs=opus",
                    "ptt": False,
                }
            }
        },
        text=None,
    )

    result = whatsapp_cloud_outbound_payload_from_proto(proto)
    candidate = whatsapp_media_reupload_candidate_from_proto(proto)

    assert result.outcome == "native_required"
    assert result.kind == "audio"
    assert result.reason == "media-reupload-required"
    assert candidate is not None
    assert candidate.kind == "audio"
    assert candidate.source_url == "https://mmg.whatsapp.net/o1/audio"
    assert candidate.mimetype == "audio/ogg; codecs=opus"
    assert candidate.media_key == media_key
    assert candidate.file_sha256 == b"plain-audio-sha"
    assert candidate.file_enc_sha256 == b"encrypted-audio-sha"


def test_whatsapp_cloud_outbound_payload_requires_native_for_voice_note():
    proto = whatsapp_message_proto_bytes(
        {
            "message": {
                "audioMessage": {
                    "url": "https://mmg.whatsapp.net/o1/voice",
                    "directPath": "/v/t62.7117-24/voice",
                    "mediaKey": "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
                    "mimetype": "audio/ogg; codecs=opus",
                    "ptt": True,
                }
            }
        },
        text=None,
    )

    result = whatsapp_cloud_outbound_payload_from_proto(proto)

    assert result.outcome == "native_required"
    assert result.kind == "audio"
    assert result.reason == "audio-ptt-native-required"


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

    before = len(forwarded)
    blocked = await respond_to_iq(
        {
            "tag": "iq",
            "attrs": {"id": "privacy-get", "xmlns": "privacy", "type": "get"},
            "content": [{"tag": "privacy", "attrs": {}}],
        },
        pre_key_count=0,
        agent_user=None,
        forward_iq=forward,
    )
    assert len(forwarded) == before
    assert blocked["attrs"]["id"] == "privacy-get"
    assert "content" not in blocked

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
    assert relay_outbound_extra_attrs({"id": "x", "to": "g@g.us", "edit": "8"}) == {
        "edit": "8"
    }


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


def test_whatsapp_media_url_rewrites():
    upstream = rewrite_whatsapp_media_to_upstream_url(
        "http://clawdi.local/v1/channels/whatsapp/media/v/t62/blob.enc?ccb=11-4&oh=abc"
    )
    assert upstream == "https://mmg.whatsapp.net/v/t62/blob.enc?ccb=11-4&oh=abc"
    # Proxy URLs minted before the /v1 migration are persisted in message
    # payloads and must keep parsing.
    legacy = rewrite_whatsapp_media_to_upstream_url(
        "http://clawdi.local/api/channels/whatsapp/media/v/t62/blob.enc?ccb=11-4&oh=abc"
    )
    assert legacy == "https://mmg.whatsapp.net/v/t62/blob.enc?ccb=11-4&oh=abc"
    assert (
        rewrite_whatsapp_media_to_upstream_url(
            "http://clawdi.local/api/channels/whatsapp/media/v/t62/blob.enc",
            upstream_host="regional.mmg.whatsapp.net",
        )
        == "https://regional.mmg.whatsapp.net/v/t62/blob.enc"
    )
    assert rewrite_whatsapp_media_to_upstream_url("http://clawdi.local/other") is None
    assert (
        rewrite_whatsapp_media_to_proxy_url(
            "https://mmg.whatsapp.net/v/t62/blob.enc?ccb=11-4",
            "https://clawdi.example",
        )
        == "https://clawdi.example/v1/channels/whatsapp/media/v/t62/blob.enc?ccb=11-4"
    )
    with pytest.raises(ValueError, match="non-WA url"):
        rewrite_whatsapp_media_to_proxy_url("https://evil.example/v/t62/blob.enc", "https://proxy")


@pytest.mark.asyncio
async def test_whatsapp_media_proxy_forwards_head_without_body(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _FakeMediaClient.calls = []
    monkeypatch.setattr("app.routes.channel_routers.whatsapp.httpx.AsyncClient", _FakeMediaClient)

    response = await client.head(
        "/v1/channels/whatsapp/media/v/t62/blob.enc",
        params={"ccb": "11-4"},
        headers={"Range": "bytes=0-14"},
    )

    assert response.status_code == 206
    assert response.content == b""
    assert response.headers["content-range"] == "bytes 0-14/99"
    assert _FakeMediaClient.calls[0]["method"] == "HEAD"


@pytest.mark.asyncio
async def test_whatsapp_tenant_creds_route_persists_auth_cert(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-baileys"},
        )
    ).json()

    first = await client.post(f"/v1/channels/whatsapp/{created['id']}/tenant-creds", json={})
    second = await client.post(f"/v1/channels/whatsapp/{created['id']}/tenant-creds", json={})

    assert first.status_code == 201
    assert second.status_code == 201
    first_body = first.json()
    second_body = second.json()
    assert first_body["channel"] == "whatsapp"
    assert first_body["jid"].endswith("@s.whatsapp.net")
    assert len(first_body["identity_pub_key_hex"]) == 64
    assert first_body["creds"]["noiseKey"]["public"]["type"] == "Buffer"
    assert first_body["auth_cert"]["ISSUER"] == "clawdi"
    assert first_body["websocket_url"].endswith(f"/v1/channels/whatsapp/{created['id']}/baileys")
    assert second_body["auth_cert"] == first_body["auth_cert"]


@pytest.mark.asyncio
async def test_whatsapp_tenant_creds_route_lists_metadata_and_resolves_identity(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-creds-metadata",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    shared_self = {
        "id": "16693773518:2@s.whatsapp.net",
        "lid": "117901482786828:2@lid",
    }

    minted_response = await client.post(
        f"/v1/channels/whatsapp/{created['id']}/tenant-creds",
        json={
            "agent_id": str(second_channel_agent.id),
            "phone_user": "15550007777",
            "device": 2,
            "name": "Shared WA",
            "self_identity": shared_self,
        },
    )

    assert minted_response.status_code == 201
    minted = minted_response.json()
    assert minted["jid"] == shared_self["id"]
    assert minted["creds"]["me"]["id"] == shared_self["id"]
    assert minted["creds"]["me"]["lid"] == shared_self["lid"]

    credential = (
        await db_session.execute(
            select(ChannelAgentCredential).where(
                ChannelAgentCredential.id == UUID(minted["credential_id"])
            )
        )
    ).scalar_one()
    assert str(credential.bot_agent_link_id) == minted["agent_link_id"]
    assert credential.synthetic_jid == shared_self["id"]
    assert credential.identity_public_key.hex() == minted["identity_pub_key_hex"]
    assert credential.identity_pub_key_hash != minted["identity_pub_key_hex"]
    decrypted_creds = decrypt(credential.encrypted_credentials, credential.credential_nonce)
    assert '"noiseKey"' in decrypted_creds
    assert credential.encrypted_credentials != decrypted_creds.encode()

    found = await resolve_whatsapp_credential_by_identity(
        db_session,
        identity_public_key=bytes.fromhex(minted["identity_pub_key_hex"]),
    )
    assert found is not None
    assert found.id == credential.id

    listed_response = await client.get(f"/v1/channels/whatsapp/{created['id']}/tenant-creds")
    assert listed_response.status_code == 200
    listed = listed_response.json()
    assert listed == [
        {
            "credential_id": minted["credential_id"],
            "agent_link_id": minted["agent_link_id"],
            "agent_id": str(second_channel_agent.id),
            "jid": shared_self["id"],
            "identity_pub_key_hex": minted["identity_pub_key_hex"],
            "created_at": listed[0]["created_at"],
        }
    ]
    assert "creds" not in listed[0]
    assert "auth_cert" not in listed[0]


@pytest.mark.asyncio
async def test_whatsapp_tenant_creds_route_resolves_same_self_jid_by_noise_identity(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-shared-self-identity"},
        )
    ).json()
    shared_self = {
        "id": "16693773518:2@s.whatsapp.net",
        "lid": "117901482786828:2@lid",
    }

    first_response = await client.post(
        f"/v1/channels/whatsapp/{created['id']}/tenant-creds",
        json={"name": "tenant-a", "self_identity": shared_self},
    )
    second_response = await client.post(
        f"/v1/channels/whatsapp/{created['id']}/tenant-creds",
        json={"name": "tenant-b", "self_identity": shared_self},
    )

    assert first_response.status_code == 201
    assert second_response.status_code == 201
    first = first_response.json()
    second = second_response.json()
    assert first["jid"] == second["jid"] == shared_self["id"]
    assert first["identity_pub_key_hex"] != second["identity_pub_key_hex"]

    first_found = await resolve_whatsapp_credential_by_identity(
        db_session,
        identity_public_key=bytes.fromhex(first["identity_pub_key_hex"]),
    )
    second_found = await resolve_whatsapp_credential_by_identity(
        db_session,
        identity_public_key=bytes.fromhex(second["identity_pub_key_hex"]),
    )
    assert first_found is not None
    assert second_found is not None
    assert first_found.id == UUID(first["credential_id"])
    assert second_found.id == UUID(second["credential_id"])

    listed = (
        await client.get(f"/v1/channels/whatsapp/{created['id']}/tenant-creds")
    ).json()
    assert {item["identity_pub_key_hex"] for item in listed} == {
        first["identity_pub_key_hex"],
        second["identity_pub_key_hex"],
    }
    assert {item["jid"] for item in listed} == {shared_self["id"]}


@pytest.mark.asyncio
async def test_whatsapp_tenant_creds_revoke_removes_identity_lookup_and_allows_remint(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-creds-revoke"},
        )
    ).json()
    first_response = await client.post(
        f"/v1/channels/whatsapp/{created['id']}/tenant-creds",
        json={},
    )
    assert first_response.status_code == 201
    first = first_response.json()

    deleted = await client.delete(
        f"/v1/channels/whatsapp/{created['id']}/tenant-creds/{first['credential_id']}"
    )
    assert deleted.status_code == 204
    credential = await db_session.get(ChannelAgentCredential, UUID(first["credential_id"]))
    assert credential is not None
    assert credential.revoked_at is not None
    assert (
        await resolve_whatsapp_credential_by_identity(
            db_session,
            identity_public_key=bytes.fromhex(first["identity_pub_key_hex"]),
        )
        is None
    )

    listed = await client.get(f"/v1/channels/whatsapp/{created['id']}/tenant-creds")
    second_delete = await client.delete(
        f"/v1/channels/whatsapp/{created['id']}/tenant-creds/{first['credential_id']}"
    )
    second_response = await client.post(
        f"/v1/channels/whatsapp/{created['id']}/tenant-creds",
        json={},
    )

    assert listed.status_code == 200
    assert listed.json() == []
    assert second_delete.status_code == 404
    assert second_response.status_code == 201
    second = second_response.json()
    assert second["identity_pub_key_hex"] != first["identity_pub_key_hex"]


@pytest.mark.asyncio
async def test_channel_delete_revokes_whatsapp_tenant_credentials(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-creds-channel-delete"},
        )
    ).json()
    minted = (
        await client.post(
            f"/v1/channels/whatsapp/{created['id']}/tenant-creds",
            json={},
        )
    ).json()

    deleted = await client.delete(f"/v1/channels/{created['id']}")

    credential = await db_session.get(ChannelAgentCredential, UUID(minted["credential_id"]))
    assert deleted.status_code == 204
    assert credential is not None
    assert credential.revoked_at is not None
    assert (
        await resolve_whatsapp_credential_by_identity(
            db_session,
            identity_public_key=bytes.fromhex(minted["identity_pub_key_hex"]),
        )
        is None
    )


@pytest.mark.asyncio
async def test_channel_agent_link_delete_revokes_whatsapp_tenant_credentials(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-creds-link-delete"},
        )
    ).json()
    minted = (
        await client.post(
            f"/v1/channels/whatsapp/{created['id']}/tenant-creds",
            json={},
        )
    ).json()

    deleted = await client.delete(
        f"/v1/channels/{created['id']}/agent-links/{minted['agent_link_id']}"
    )

    credential = await db_session.get(ChannelAgentCredential, UUID(minted["credential_id"]))
    assert deleted.status_code == 204
    assert credential is not None
    assert credential.revoked_at is not None
    assert (
        await resolve_whatsapp_credential_by_identity(
            db_session,
            identity_public_key=bytes.fromhex(minted["identity_pub_key_hex"]),
        )
        is None
    )


@pytest.mark.asyncio
async def test_whatsapp_websocket_inbox_is_scoped_to_agent_link(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-link-scoped-inbox",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    default_credential = (
        await client.post(
            f"/v1/channels/whatsapp/{created['id']}/tenant-creds",
            json={"name": "default"},
        )
    ).json()
    workspace_credential = (
        await client.post(
            f"/v1/channels/whatsapp/{created['id']}/tenant-creds",
            json={"agent_id": str(second_channel_agent.id), "name": "workspace"},
        )
    ).json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None

    messages: list[ChannelMessage] = []
    for credential, chat_id, text in (
        (default_credential, "15551110000@s.whatsapp.net", "default message"),
        (workspace_credential, "15551110001@s.whatsapp.net", "workspace message"),
    ):
        link_id = UUID(credential["agent_link_id"])
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
            payload={"key": {"remoteJid": binding.external_chat_id, "id": f"msg-{link_id}"}},
        )
        db_session.add(message)
        messages.append(message)
    await db_session.commit()

    default_events = await _wait_whatsapp_websocket_inbox(
        account_id=account.id,
        bot_agent_link_id=UUID(default_credential["agent_link_id"]),
        after_sequence=0,
        limit=10,
    )
    workspace_events = await _wait_whatsapp_websocket_inbox(
        account_id=account.id,
        bot_agent_link_id=UUID(workspace_credential["agent_link_id"]),
        after_sequence=0,
        limit=10,
    )

    assert [event.text for event in default_events] == ["default message"]
    assert [event.text for event in workspace_events] == ["workspace message"]

    await _ack_whatsapp_websocket_inbox(
        account_id=account.id,
        bot_agent_link_id=UUID(default_credential["agent_link_id"]),
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


@pytest.mark.asyncio
async def test_whatsapp_lid_pairing_remembers_alias(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-lid-alias"},
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    lid_jid = "7826185388106@lid"
    phone_jid = "15551112222@s.whatsapp.net"

    paired = await client.post(
        f"/v1/channels/whatsapp/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "message": {
                "key": {"remoteJid": lid_jid, "remoteJidAlt": phone_jid, "id": "PAIR"},
                "message": {"conversation": f"/bot_pair {pair['code']}"},
            }
        },
    )
    assert paired.status_code == 200

    inbound = await client.post(
        f"/v1/channels/whatsapp/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "message": {
                "key": {"remoteJid": lid_jid, "id": "MSG1"},
                "message": {"conversation": "hello via lid"},
            }
        },
    )
    assert inbound.status_code == 200

    binding = (
        await db_session.execute(
            select(ChannelBinding).where(ChannelBinding.external_chat_id == phone_jid)
        )
    ).scalar_one()
    alias = (
        await db_session.execute(
            select(ChannelBindingAlias).where(ChannelBindingAlias.alias_external_chat_id == lid_jid)
        )
    ).scalar_one()
    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "MSG1")
        )
    ).scalar_one()
    assert alias.binding_id == binding.id
    assert message.binding_id == binding.id
    assert message.external_chat_id == phone_jid


@pytest.mark.asyncio
async def test_whatsapp_lid_alias_unpair_archives_phone_binding(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-lid-unpair"},
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    lid_jid = "7826185388106@lid"
    phone_jid = "15551112222@s.whatsapp.net"

    await client.post(
        f"/v1/channels/whatsapp/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "message": {
                "key": {"remoteJid": lid_jid, "remoteJidAlt": phone_jid, "id": "PAIR"},
                "message": {"conversation": f"/bot_pair {pair['code']}"},
            }
        },
    )
    unpaired = await client.post(
        f"/v1/channels/whatsapp/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "message": {
                "key": {"remoteJid": lid_jid, "id": "UNPAIR"},
                "message": {"conversation": "/bot_unpair"},
            }
        },
    )
    after_unpair = await client.post(
        f"/v1/channels/whatsapp/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "message": {
                "key": {"remoteJid": lid_jid, "id": "AFTER"},
                "message": {"conversation": "should not route"},
            }
        },
    )

    binding = (
        await db_session.execute(
            select(ChannelBinding).where(ChannelBinding.external_chat_id == phone_jid)
        )
    ).scalar_one()
    routed_after = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "AFTER")
        )
    ).scalar_one()
    assert unpaired.status_code == 200
    assert unpaired.json()["unpaired"] is True
    assert after_unpair.status_code == 200
    assert binding.status == BINDING_STATUS_ARCHIVED
    assert routed_after.binding_id is None


@pytest.mark.asyncio
async def test_whatsapp_lid_phone_conflicts_across_agent_links_drop_inbound(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-lid-conflict",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    second_link = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    account = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.id == UUID(created["id"]))
        )
    ).scalar_one()
    lid_jid = "7826185388106@lid"
    phone_jid = "15551112222@s.whatsapp.net"
    db_session.add(
        ChannelBinding(
            account_id=account.id,
            bot_agent_link_id=UUID(created["agent_link_id"]),
            user_id=account.user_id,
            external_chat_id=lid_jid,
            external_chat_type="dm",
        )
    )
    db_session.add(
        ChannelBinding(
            account_id=account.id,
            bot_agent_link_id=UUID(second_link["id"]),
            user_id=account.user_id,
            external_chat_id=phone_jid,
            external_chat_type="dm",
        )
    )
    await db_session.commit()

    inbound = await client.post(
        f"/v1/channels/whatsapp/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "message": {
                "key": {"remoteJid": lid_jid, "remoteJidAlt": phone_jid, "id": "CONFLICT"},
                "message": {"conversation": "must not leak"},
            }
        },
    )

    assert inbound.status_code == 200
    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "CONFLICT")
        )
    ).scalar_one_or_none()
    assert message is None


@pytest.mark.asyncio
async def test_whatsapp_media_proxy_forwards_range(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _FakeMediaClient.calls = []
    monkeypatch.setattr("app.routes.channel_routers.whatsapp.httpx.AsyncClient", _FakeMediaClient)

    response = await client.get(
        "/v1/channels/whatsapp/media/v/t62/blob.enc",
        params={"ccb": "11-4"},
        headers={"Range": "bytes=0-14"},
    )

    assert response.status_code == 206
    assert response.content == b"encrypted-media"
    assert response.headers["content-range"] == "bytes 0-14/99"
    assert _FakeMediaClient.calls[0]["url"] == "https://mmg.whatsapp.net/v/t62/blob.enc?ccb=11-4"
    assert _FakeMediaClient.calls[0]["headers"]["Range"] == "bytes=0-14"
