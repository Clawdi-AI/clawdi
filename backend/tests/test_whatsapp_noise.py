from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest
import xeddsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from app.core.database import async_session_factory
from app.models.channel import (
    BOT_AGENT_LINK_STATUS_ARCHIVED,
    MESSAGE_DIRECTION_INBOUND,
    MESSAGE_DIRECTION_OUTBOUND,
    ChannelAccount,
    ChannelAgentCredential,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelDebugEvent,
    ChannelMessage,
)
from app.routes.channel_routers import whatsapp as whatsapp_router_module
from app.routes.channel_routers.whatsapp import router as whatsapp_router
from app.routes.channel_routers.whatsapp import whatsapp_baileys_managed_websocket
from app.services.channels import generate_agent_token, store_agent_link_token
from app.services.vault_crypto import decrypt, encrypt
from app.services.whatsapp_baileys import (
    SignalSender,
    StoredWhatsAppCredential,
    WhatsAppAuthCert,
    decode_buffer_json,
    mint_whatsapp_agent_credential,
    serialize_creds,
    whatsapp_signal_senders_from_config,
    whatsapp_text_message_proto,
)
from app.services.whatsapp_native_transport import WhatsAppSidecarHealth
from app.services.whatsapp_noise import (
    NOISE_MODE,
    NOISE_WA_HEADER,
    ClientFinish,
    ClientHello,
    HandshakeMessage,
    KeyPair,
    NoiseServer,
    TransportState,
    WhatsAppNoiseEmulatorSession,
    WhatsAppNoiseRuntimeEvent,
    WhatsAppNoiseTenant,
    WhatsAppOutboundMessage,
    _bytes_field,
    _hkdf,
    _iv,
    _message_field,
    _pad_random_max16,
    _proto_conversation_text,
    _read_fields,
    _shared_key,
    _unpad_random_max16,
    decode_binary_node_minimal,
    decode_handshake_message,
    encode_binary_node_minimal,
    encode_cert_chain,
    encode_handshake_message,
    generate_key_pair,
    pack_frame,
    unpack_frame,
)
from tests.whatsapp_helpers import encrypt_whatsapp_group_message_for_sender_key

pytestmark = [pytest.mark.usefixtures("channel_agent"), pytest.mark.committed_db]


async def _create_whatsapp_channel_with_existing_link(
    client,
    db_session,
    channel_agent,
    *,
    name: str,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"provider": "whatsapp", "name": name}
    response = await client.post("/v1/channels", json=payload)
    assert response.status_code == 201, response.text
    created = response.json()
    link = ChannelBotAgentLink(
        account_id=UUID(created["id"]),
        user_id=channel_agent.user_id,
        agent_id=channel_agent.id,
    )
    agent_token = generate_agent_token("whatsapp")
    store_agent_link_token(link, agent_token)
    db_session.add(link)
    await db_session.commit()
    await db_session.refresh(link)
    created["agent_id"] = str(link.agent_id)
    created["agent_link_id"] = str(link.id)
    created["agent_token"] = agent_token
    return created


async def _mint_synthetic_credential(
    db_session,
    created: dict[str, Any],
    *,
    link_id: UUID | None = None,
    self_identity: dict[str, str | None] | None = None,
) -> StoredWhatsAppCredential:
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    selected_link_id = link_id or UUID(created["agent_link_id"])
    link = await db_session.get(ChannelBotAgentLink, selected_link_id)
    assert account is not None
    assert link is not None
    stored = await mint_whatsapp_agent_credential(
        db_session,
        account=account,
        bot_agent_link_id=selected_link_id,
        user_id=link.user_id,
        self_identity=self_identity
        or {
            "id": "16693773518:2@s.whatsapp.net",
            "lid": "117901482786828:2@lid",
        },
    )
    await db_session.commit()
    return stored


@pytest.mark.asyncio
async def test_whatsapp_noise_prefers_current_account_identity(
    client,
    db_session,
    channel_agent,
):
    created = await _create_whatsapp_channel_with_existing_link(
        client,
        db_session,
        channel_agent,
        name="wa-current-self-identity",
    )
    stored = await _mint_synthetic_credential(
        db_session,
        created,
        self_identity={
            "id": "15550000001:1@s.whatsapp.net",
            "lid": "900000000000001:1@lid",
        },
    )
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    account.config = {
        "self_identity": {
            "id": "15550000002:1@s.whatsapp.net",
            "lid": "900000000000002:1@lid",
        }
    }
    credential_config = dict(stored.credential.config or {})
    credential_config["self_identity"] = {
        "id": stored.credential.synthetic_jid,
        "lid": "900000000000002:1@lid",
    }
    stored.credential.config = credential_config

    legacy_creds = decode_buffer_json(
        json.loads(
            decrypt(
                stored.credential.encrypted_credentials,
                stored.credential.credential_nonce,
            )
        )
    )
    assert isinstance(legacy_creds, dict)
    legacy_me = legacy_creds.get("me")
    assert isinstance(legacy_me, dict)
    legacy_me.pop("lid")
    preserved_auth_state = {key: value for key, value in legacy_creds.items() if key != "me"}
    ciphertext, nonce = encrypt(serialize_creds(legacy_creds))
    stored.credential.encrypted_credentials = ciphertext
    stored.credential.credential_nonce = nonce
    await db_session.commit()

    lid = await whatsapp_router_module._resolve_whatsapp_noise_lid(
        db_session,
        account=account,
        credential=stored.credential,
    )

    assert lid == "900000000000002:1@lid"
    await db_session.refresh(stored.credential)
    assert stored.credential.config["self_identity"] == {
        "id": stored.credential.synthetic_jid,
        "lid": "900000000000002:1@lid",
    }
    repaired_creds = decode_buffer_json(
        json.loads(
            decrypt(
                stored.credential.encrypted_credentials,
                stored.credential.credential_nonce,
            )
        )
    )
    assert isinstance(repaired_creds, dict)
    assert {key: value for key, value in repaired_creds.items() if key != "me"} == (
        preserved_auth_state
    )
    assert repaired_creds["me"] == {
        **legacy_me,
        "id": stored.credential.synthetic_jid,
        "lid": "900000000000002:1@lid",
    }


def test_whatsapp_noise_pack_unpack_round_trips_partial_frames():
    frame = pack_frame(b"abc")

    assert unpack_frame(frame[:2]) is None
    assert unpack_frame(frame) == (b"abc", b"")
    assert unpack_frame(frame + pack_frame(b"next")) == (b"abc", pack_frame(b"next"))


def test_whatsapp_noise_message_padding_matches_baileys_shape():
    raw = _bytes_field(1, b"hello")
    padded = _pad_random_max16(raw)

    pad_length = padded[-1]
    assert 1 <= pad_length <= 16
    assert padded.endswith(bytes([pad_length]) * pad_length)
    assert _unpad_random_max16(padded) == raw
    assert _proto_conversation_text(padded) == "hello"


def test_whatsapp_wabinary_decodes_baileys_dictionary_tokens():
    frame = bytes([0, 248, 3, 25, 4, 236, 217])

    node = decode_binary_node_minimal(frame)

    assert node == {"tag": "iq", "attrs": {"type": "blocklist"}}


def test_whatsapp_noise_server_handshake_and_transport_round_trip():
    cert = _auth_cert()
    server = NoiseServer(auth_cert=cert)
    server.init()
    client = _MiniNoiseClient()

    client_hello = encode_handshake_message(
        HandshakeMessage(client_hello=ClientHello(ephemeral=client.ephemeral.public))
    )
    accepted = _run(server.handle_client_hello(client_hello))
    finish = client.process_server_hello(accepted.server_hello, payload=b"client-payload")
    completed = _run(server.handle_client_finish(finish))

    assert completed.client_payload == b"client-payload"
    assert completed.client_static_public == client.static.public
    assert server.is_transport() is True

    server_frame = server.encrypt_frame(b"server-payload")
    encrypted, rest = unpack_frame(server_frame) or (b"", b"")
    assert rest == b""
    assert client.transport is not None
    assert client.transport.decrypt(encrypted) == b"server-payload"

    client_ciphertext = client.transport.encrypt(b"client-transport")
    assert server.decrypt_frame(client_ciphertext) == b"client-transport"


def test_whatsapp_noise_cert_chain_has_verifiable_x25519_key_signatures():
    cert = _auth_cert()
    static = generate_key_pair()

    chain = {
        field: value
        for field, wire_type, value in _read_fields(encode_cert_chain(cert, static.public))
        if wire_type == 2
    }
    leaf = {field: value for field, wire_type, value in _read_fields(chain[1]) if wire_type == 2}
    intermediate = {
        field: value for field, wire_type, value in _read_fields(chain[2]) if wire_type == 2
    }

    for signed, public_key in (
        (leaf, cert.intermediate_public_key),
        (intermediate, cert.root_public_key),
    ):
        details = signed[1]
        signature = signed[2]
        assert signature != bytes(64)
        assert signature[63] & 0x80 == 0
        ed25519_public = xeddsa.curve25519_pub_to_ed25519_pub(public_key, False)
        assert xeddsa.ed25519_verify(signature, ed25519_public, details)


def test_whatsapp_minimal_wabinary_encoder_uses_raw_strings():
    encoded = encode_binary_node_minimal(
        {
            "tag": "success",
            "attrs": {
                "lid": "900000000000001:7@lid",
                "t": "1700000000",
                "platform": "s.whatsapp.net",
            },
        }
    )

    assert encoded.startswith(b"\0")
    assert b"success" in encoded
    assert b"900000000000001:7@lid" in encoded


def test_whatsapp_minimal_wabinary_round_trips_iq_nodes():
    node = {
        "tag": "iq",
        "attrs": {"id": "q-1", "xmlns": "encrypt", "type": "get", "to": "s.whatsapp.net"},
        "content": [{"tag": "count", "attrs": {}}],
    }

    assert decode_binary_node_minimal(encode_binary_node_minimal(node)) == {
        "tag": "iq",
        "attrs": {"id": "q-1", "xmlns": "encrypt", "type": "get", "to": "s.whatsapp.net"},
        "content": [{"tag": "count", "attrs": {}}],
    }


def test_whatsapp_wabinary_decoder_reads_baileys_packed_tokens():
    encoded = bytes.fromhex("00f8081908ff03123a4516cb0429f801f80141")

    assert decode_binary_node_minimal(encoded) == {
        "tag": "iq",
        "attrs": {"id": "123-45", "xmlns": "encrypt", "type": "get"},
        "content": [{"tag": "count", "attrs": {}}],
    }


def test_whatsapp_wabinary_decoder_reads_baileys_dictionary_and_device_jids():
    passive = bytes.fromhex("00f8081908fc09706173736976652d3116ec18045af801f801ec01")
    message = bytes.fromhex("00f8061308fc036d2d3111f70007ff8615551234567ff801f8041d0453fc03010203")

    assert decode_binary_node_minimal(passive) == {
        "tag": "iq",
        "attrs": {"id": "passive-1", "xmlns": "passive", "type": "set"},
        "content": [{"tag": "active", "attrs": {}}],
    }
    assert decode_binary_node_minimal(message) == {
        "tag": "message",
        "attrs": {"id": "m-1", "to": "15551234567:7@s.whatsapp.net"},
        "content": [{"tag": "enc", "attrs": {"type": "pkmsg"}, "content": b"\x01\x02\x03"}],
    }


def test_whatsapp_wabinary_decoder_reads_baileys_empty_strings():
    assert decode_binary_node_minimal(bytes([0, 248, 3, 25, 8, 0])) == {
        "tag": "iq",
        "attrs": {"id": ""},
    }


def test_whatsapp_noise_emulator_session_bootstraps_and_answers_iq():
    cert = _auth_cert()
    session = WhatsAppNoiseEmulatorSession(
        auth_cert=cert,
        lid="900000000000001:7@lid",
        pre_key_count=7,
    )
    client = _MiniNoiseClient()

    client_hello = encode_handshake_message(
        HandshakeMessage(client_hello=ClientHello(ephemeral=client.ephemeral.public))
    )
    server_frames = _run(session.handle_inbound(NOISE_WA_HEADER + pack_frame(client_hello)))
    assert len(server_frames) == 1
    server_hello, rest = unpack_frame(server_frames[0]) or (b"", b"")
    assert rest == b""

    client_finish = client.process_server_hello(server_hello, payload=b"client-payload")
    bootstrap_frames = _run(session.handle_inbound(pack_frame(client_finish)))
    assert len(bootstrap_frames) == 2
    assert session.client_static_public == client.static.public

    assert client.transport is not None
    success_ciphertext, _rest = unpack_frame(bootstrap_frames[0]) or (b"", b"")
    success = decode_binary_node_minimal(client.transport.decrypt(success_ciphertext))
    assert success["tag"] == "success"
    assert success["attrs"]["lid"] == "900000000000001:7@lid"
    offline_ciphertext, _rest = unpack_frame(bootstrap_frames[1]) or (b"", b"")
    offline = decode_binary_node_minimal(client.transport.decrypt(offline_ciphertext))
    assert offline == {"tag": "offline", "attrs": {"count": "0"}}

    count_query = encode_binary_node_minimal(
        {
            "tag": "iq",
            "attrs": {"id": "q-1", "xmlns": "encrypt", "type": "get"},
            "content": [{"tag": "count", "attrs": {}}],
        }
    )
    iq_frames = _run(session.handle_inbound(pack_frame(client.transport.encrypt(count_query))))
    assert len(iq_frames) == 1
    iq_ciphertext, _rest = unpack_frame(iq_frames[0]) or (b"", b"")
    iq = decode_binary_node_minimal(client.transport.decrypt(iq_ciphertext))
    assert iq["attrs"]["id"] == "q-1"
    assert iq["content"][0]["attrs"]["value"] == "7"


def test_whatsapp_noise_emulator_session_persists_uploaded_agent_bundle():
    cert = _auth_cert()
    session = WhatsAppNoiseEmulatorSession(
        auth_cert=cert,
        lid="900000000000001:7@lid",
        pre_key_count=0,
    )
    client = _MiniNoiseClient()

    server_frames = _run(
        session.handle_inbound(
            NOISE_WA_HEADER
            + pack_frame(
                encode_handshake_message(
                    HandshakeMessage(client_hello=ClientHello(ephemeral=client.ephemeral.public))
                )
            )
        )
    )
    server_hello, _rest = unpack_frame(server_frames[0]) or (b"", b"")
    client_finish = client.process_server_hello(server_hello, payload=b"")
    bootstrap_frames = _run(session.handle_inbound(pack_frame(client_finish)))
    assert client.transport is not None
    for frame in bootstrap_frames:
        ciphertext, _rest = unpack_frame(frame) or (b"", b"")
        client.transport.decrypt(ciphertext)

    upload = encode_binary_node_minimal(
        {
            "tag": "iq",
            "attrs": {"id": "upload-1", "xmlns": "encrypt", "type": "set"},
            "content": [
                {"tag": "registration", "attrs": {}, "content": (12345).to_bytes(4, "big")},
                {"tag": "identity", "attrs": {}, "content": b"\x05" + bytes(range(32))},
                {
                    "tag": "list",
                    "attrs": {},
                    "content": [
                        {
                            "tag": "key",
                            "attrs": {},
                            "content": [
                                {"tag": "id", "attrs": {}, "content": (1).to_bytes(3, "big")},
                                {"tag": "value", "attrs": {}, "content": bytes(range(32, 64))},
                            ],
                        },
                        {
                            "tag": "key",
                            "attrs": {},
                            "content": [
                                {"tag": "id", "attrs": {}, "content": (2).to_bytes(3, "big")},
                                {"tag": "value", "attrs": {}, "content": bytes(range(64, 96))},
                            ],
                        },
                    ],
                },
                {
                    "tag": "skey",
                    "attrs": {},
                    "content": [
                        {"tag": "id", "attrs": {}, "content": (7).to_bytes(3, "big")},
                        {"tag": "value", "attrs": {}, "content": bytes(range(96, 128))},
                        {"tag": "signature", "attrs": {}, "content": bytes(64)},
                    ],
                },
            ],
        }
    )
    upload_frames = _run(session.handle_inbound(pack_frame(client.transport.encrypt(upload))))

    assert session.bundle is not None
    assert session.bundle.registration_id == 12345
    assert [pre_key.id for pre_key in session.bundle.pre_keys] == [1, 2]
    upload_ciphertext, _rest = unpack_frame(upload_frames[0]) or (b"", b"")
    upload_ack = decode_binary_node_minimal(client.transport.decrypt(upload_ciphertext))
    assert upload_ack["attrs"]["id"] == "upload-1"

    count_query = encode_binary_node_minimal(
        {
            "tag": "iq",
            "attrs": {"id": "q-2", "xmlns": "encrypt", "type": "get"},
            "content": [{"tag": "count", "attrs": {}}],
        }
    )
    count_frames = _run(session.handle_inbound(pack_frame(client.transport.encrypt(count_query))))
    count_ciphertext, _rest = unpack_frame(count_frames[0]) or (b"", b"")
    count = decode_binary_node_minimal(client.transport.decrypt(count_ciphertext))
    assert count["content"][0]["attrs"]["value"] == "2"

    push_frame, push_result = _run(
        session.push_inbound_message(
            from_jid="15551112222@s.whatsapp.net",
            message_id="inbound-1",
            message_proto=b"hello from provider",
            push_name="Alice",
            timestamp=1_700_000_000,
        )
    )
    push_ciphertext, _rest = unpack_frame(push_frame) or (b"", b"")
    pushed = decode_binary_node_minimal(client.transport.decrypt(push_ciphertext))
    assert pushed["tag"] == "message"
    assert pushed["attrs"]["id"] == "inbound-1"
    assert pushed["attrs"]["from"] == "15551112222@s.whatsapp.net"
    assert "sender_lid" not in pushed["attrs"]
    assert pushed["attrs"]["addressing_mode"] == "pn"
    assert pushed["attrs"]["notify"] == "Alice"
    enc = pushed["content"][0]
    assert enc["tag"] == "enc"
    assert enc["attrs"]["type"] == "pkmsg"
    assert isinstance(enc["content"], bytes)
    assert push_result.message_id == "inbound-1"
    assert push_result.signal_jid == "15551112222@s.whatsapp.net"
    assert push_result.enc_type == "pkmsg"


def test_whatsapp_noise_emulator_acks_non_bundle_encrypt_set_iq():
    events: list[WhatsAppNoiseRuntimeEvent] = []
    session = WhatsAppNoiseEmulatorSession(
        auth_cert=_auth_cert(),
        lid="900000000000001:7@lid",
        pre_key_count=0,
        on_event=events.append,
    )
    client = _MiniNoiseClient()
    server_frames = _run(
        session.handle_inbound(
            NOISE_WA_HEADER
            + pack_frame(
                encode_handshake_message(
                    HandshakeMessage(client_hello=ClientHello(ephemeral=client.ephemeral.public))
                )
            )
        )
    )
    server_hello, _rest = unpack_frame(server_frames[0]) or (b"", b"")
    client_finish = client.process_server_hello(server_hello, payload=b"")
    bootstrap_frames = _run(session.handle_inbound(pack_frame(client_finish)))
    assert client.transport is not None
    for frame in bootstrap_frames:
        ciphertext, _rest = unpack_frame(frame) or (b"", b"")
        client.transport.decrypt(ciphertext)

    rotate = encode_binary_node_minimal(
        {
            "tag": "iq",
            "attrs": {"id": "rotate-1", "xmlns": "encrypt", "type": "set"},
            "content": [{"tag": "skey", "attrs": {}, "content": []}],
        }
    )
    frames = _run(session.handle_inbound(pack_frame(client.transport.encrypt(rotate))))

    assert session.bundle is None
    ciphertext, _rest = unpack_frame(frames[0]) or (b"", b"")
    response = decode_binary_node_minimal(client.transport.decrypt(ciphertext))
    assert response["tag"] == "iq"
    assert response["attrs"]["id"] == "rotate-1"
    assert response["attrs"]["type"] == "result"
    assert ("agent_bundle", "ignored") in [(event.stage, event.outcome) for event in events]


def test_whatsapp_noise_emulator_session_accepts_resolved_tenant_identity():
    async def resolve(identity: bytes) -> WhatsAppNoiseTenant | None:
        assert identity == client.static.public
        return WhatsAppNoiseTenant(
            tenant_id="tenant-a",
            lid="900000000000009:4@lid",
            pre_key_count=12,
        )

    cert = _auth_cert()
    client = _MiniNoiseClient()
    session = WhatsAppNoiseEmulatorSession(
        auth_cert=cert,
        lid="fallback:0@lid",
        resolve_client=resolve,
    )

    server_frames = _run(
        session.handle_inbound(
            NOISE_WA_HEADER
            + pack_frame(
                encode_handshake_message(
                    HandshakeMessage(client_hello=ClientHello(ephemeral=client.ephemeral.public))
                )
            )
        )
    )
    server_hello, _rest = unpack_frame(server_frames[0]) or (b"", b"")
    client_finish = client.process_server_hello(server_hello, payload=b"")
    bootstrap_frames = _run(session.handle_inbound(pack_frame(client_finish)))

    assert session.rejected is False
    assert session.tenant == WhatsAppNoiseTenant(
        tenant_id="tenant-a",
        lid="900000000000009:4@lid",
        pre_key_count=12,
    )
    assert client.transport is not None
    success_ciphertext, _rest = unpack_frame(bootstrap_frames[0]) or (b"", b"")
    success = decode_binary_node_minimal(client.transport.decrypt(success_ciphertext))
    assert success["attrs"]["lid"] == "900000000000009:4@lid"


def test_whatsapp_noise_emulator_session_rejects_unknown_identity():
    async def reject(_identity: bytes) -> WhatsAppNoiseTenant | None:
        return None

    cert = _auth_cert()
    session = WhatsAppNoiseEmulatorSession(
        auth_cert=cert,
        lid="900000000000001:7@lid",
        resolve_client=reject,
    )
    client = _MiniNoiseClient()

    server_frames = _run(
        session.handle_inbound(
            NOISE_WA_HEADER
            + pack_frame(
                encode_handshake_message(
                    HandshakeMessage(client_hello=ClientHello(ephemeral=client.ephemeral.public))
                )
            )
        )
    )
    server_hello, _rest = unpack_frame(server_frames[0]) or (b"", b"")
    client_finish = client.process_server_hello(server_hello, payload=b"")
    rejected_frames = _run(session.handle_inbound(pack_frame(client_finish)))

    assert session.rejected is True
    assert client.transport is not None
    ciphertext, _rest = unpack_frame(rejected_frames[0]) or (b"", b"")
    rejected = decode_binary_node_minimal(client.transport.decrypt(ciphertext))
    assert rejected == {"tag": "stream:error", "attrs": {"code": "401"}}


def test_whatsapp_noise_emulator_session_emits_runtime_events():
    cert = _auth_cert()
    events: list[WhatsAppNoiseRuntimeEvent] = []
    session = WhatsAppNoiseEmulatorSession(
        auth_cert=cert,
        lid="900000000000001:7@lid",
        pre_key_count=7,
        on_event=events.append,
    )
    client = _MiniNoiseClient()

    server_frames = _run(
        session.handle_inbound(
            NOISE_WA_HEADER
            + pack_frame(
                encode_handshake_message(
                    HandshakeMessage(client_hello=ClientHello(ephemeral=client.ephemeral.public))
                )
            )
        )
    )
    server_hello, _rest = unpack_frame(server_frames[0]) or (b"", b"")
    client_finish = client.process_server_hello(server_hello, payload=b"")
    bootstrap_frames = _run(session.handle_inbound(pack_frame(client_finish)))
    assert client.transport is not None
    for frame in bootstrap_frames:
        ciphertext, _rest = unpack_frame(frame) or (b"", b"")
        client.transport.decrypt(ciphertext)

    count_query = encode_binary_node_minimal(
        {
            "tag": "iq",
            "attrs": {"id": "q-1", "xmlns": "encrypt", "type": "get"},
            "content": [{"tag": "count", "attrs": {}}],
        }
    )
    _run(session.handle_inbound(pack_frame(client.transport.encrypt(count_query))))

    assert [(event.stage, event.outcome) for event in events] == [
        ("noise_intro", "received"),
        ("noise_client_hello", "accepted"),
        ("tenant_resolution", "resolved"),
        ("bootstrap", "sent"),
        ("iq", "answered"),
    ]
    assert events[3].details == {"preKeyCount": 7, "backlogCount": 0}
    assert events[3].external_chat_id == "900000000000001:7@lid"
    assert events[-1].details["children"] == ["count"]
    assert client.static.public.hex() not in repr([event.details for event in events])


def test_whatsapp_noise_emulator_session_acks_agent_message_stanzas():
    cert = _auth_cert()
    events: list[WhatsAppNoiseRuntimeEvent] = []
    outbound_messages: list[WhatsAppOutboundMessage] = []
    session = WhatsAppNoiseEmulatorSession(
        auth_cert=cert,
        lid="16693773518:2@s.whatsapp.net",
        on_event=events.append,
        on_outbound_message=outbound_messages.append,
        resolve_recipient_lid=lambda jid: (
            "184207372460253@lid" if jid == "15551112222@s.whatsapp.net" else None
        ),
    )
    client = _MiniNoiseClient()

    server_frames = _run(
        session.handle_inbound(
            NOISE_WA_HEADER
            + pack_frame(
                encode_handshake_message(
                    HandshakeMessage(client_hello=ClientHello(ephemeral=client.ephemeral.public))
                )
            )
        )
    )
    server_hello, _rest = unpack_frame(server_frames[0]) or (b"", b"")
    client_finish = client.process_server_hello(server_hello, payload=b"")
    bootstrap_frames = _run(session.handle_inbound(pack_frame(client_finish)))
    assert client.transport is not None
    for frame in bootstrap_frames:
        ciphertext, _rest = unpack_frame(frame) or (b"", b"")
        client.transport.decrypt(ciphertext)

    upload = _agent_bundle_upload_node("upload-outbound")
    upload_frames = _run(session.handle_inbound(pack_frame(client.transport.encrypt(upload))))
    upload_ciphertext, _rest = unpack_frame(upload_frames[0]) or (b"", b"")
    client.transport.decrypt(upload_ciphertext)

    push_frame, push_result = _run(
        session.push_inbound_message(
            from_jid="15551112222@s.whatsapp.net",
            message_id="inbound-before-reply",
            message_proto=_bytes_field(1, b"provider hello"),
            sender_lid_jid="184207372460253@lid",
            sender_pn_jid="15551112222@s.whatsapp.net",
        )
    )
    push_ciphertext, _rest = unpack_frame(push_frame) or (b"", b"")
    pushed = decode_binary_node_minimal(client.transport.decrypt(push_ciphertext))
    assert push_result.signal_jid == "184207372460253@lid"
    assert pushed["attrs"]["from"] == "15551112222@s.whatsapp.net"
    assert pushed["attrs"]["sender_lid"] == "184207372460253@lid"
    assert pushed["attrs"]["addressing_mode"] == "pn"

    sender = session._signal_senders["184207372460253:0@lid"]
    reply_proto = _bytes_field(1, b"agent reply")
    reply = sender.encrypt_from_established_session("184207372460253", 0, reply_proto)
    message = encode_binary_node_minimal(
        {
            "tag": "message",
            "attrs": {"id": "m-1", "to": "15551112222@s.whatsapp.net"},
            "content": [
                {
                    "tag": "participants",
                    "attrs": {},
                    "content": [
                        {
                            "tag": "to",
                            "attrs": {"jid": "15551112222@s.whatsapp.net"},
                            "content": [
                                {
                                    "tag": "enc",
                                    "attrs": {"type": reply.type},
                                    "content": reply.ciphertext,
                                }
                            ],
                        }
                    ],
                },
                {"tag": "meta", "attrs": {"polltype": "creation"}},
                {"tag": "device-identity", "attrs": {}, "content": b"not-forwarded"},
            ],
        }
    )
    ack_frames = _run(session.handle_inbound(pack_frame(client.transport.encrypt(message))))

    assert len(ack_frames) == 1
    ack_ciphertext, _rest = unpack_frame(ack_frames[0]) or (b"", b"")
    ack = decode_binary_node_minimal(client.transport.decrypt(ack_ciphertext))
    assert ack == {
        "tag": "ack",
        "attrs": {
            "id": "m-1",
            "to": "15551112222@s.whatsapp.net",
            "class": "message",
        },
    }
    assert events[-1].stage == "outbound_message"
    assert events[-1].outcome == "decoded"
    assert events[-1].details == {
        "id": "m-1",
        "encType": "msg",
        "protoBytes": len(reply_proto),
        "protoSha256": hashlib.sha256(reply_proto).hexdigest(),
        "conversationPresent": True,
        "children": ["participants", "meta", "device-identity"],
    }
    assert outbound_messages == [
        WhatsAppOutboundMessage(
            to_jid="15551112222@s.whatsapp.net",
            message_id="m-1",
            message_proto=reply_proto,
            enc_type="msg",
            attrs={"id": "m-1", "to": "15551112222@s.whatsapp.net"},
            conversation="agent reply",
            additional_nodes=({"tag": "meta", "attrs": {"polltype": "creation"}},),
        )
    ]


def test_whatsapp_noise_emulator_session_decodes_agent_group_message_stanzas():
    cert = _auth_cert()
    events: list[WhatsAppNoiseRuntimeEvent] = []
    outbound_messages: list[WhatsAppOutboundMessage] = []
    session = WhatsAppNoiseEmulatorSession(
        auth_cert=cert,
        lid="16693773518:2@s.whatsapp.net",
        on_event=events.append,
        on_outbound_message=outbound_messages.append,
    )
    client = _MiniNoiseClient()

    server_frames = _run(
        session.handle_inbound(
            NOISE_WA_HEADER
            + pack_frame(
                encode_handshake_message(
                    HandshakeMessage(client_hello=ClientHello(ephemeral=client.ephemeral.public))
                )
            )
        )
    )
    server_hello, _rest = unpack_frame(server_frames[0]) or (b"", b"")
    client_finish = client.process_server_hello(server_hello, payload=b"")
    bootstrap_frames = _run(session.handle_inbound(pack_frame(client_finish)))
    assert client.transport is not None
    for frame in bootstrap_frames:
        ciphertext, _rest = unpack_frame(frame) or (b"", b"")
        client.transport.decrypt(ciphertext)

    upload = _agent_bundle_upload_node("upload-group-outbound")
    upload_frames = _run(session.handle_inbound(pack_frame(client.transport.encrypt(upload))))
    upload_ciphertext, _rest = unpack_frame(upload_frames[0]) or (b"", b"")
    client.transport.decrypt(upload_ciphertext)

    group_jid = "120363012345678901@g.us"
    participant_jid = "15551112222@s.whatsapp.net"
    push_frame, _push_result = _run(
        session.push_inbound_message(
            from_jid=group_jid,
            participant_jid=participant_jid,
            message_id="group-inbound-before-reply",
            message_proto=_bytes_field(1, b"provider group hello"),
        )
    )
    push_ciphertext, _rest = unpack_frame(push_frame) or (b"", b"")
    client.transport.decrypt(push_ciphertext)

    sender = session._signal_senders["15551112222:0@s.whatsapp.net"]
    axolotl = b"group-sender-key-distribution"
    skdm_proto = _message_field(
        2,
        _bytes_field(1, group_jid.encode("utf-8")) + _bytes_field(2, axolotl),
    )
    skdm = sender.encrypt_from_established_session("15551112222", 0, skdm_proto)
    group_proto = _bytes_field(1, b"group reply")
    skmsg = encrypt_whatsapp_group_message_for_sender_key(
        axolotl_bytes=axolotl,
        plaintext=group_proto,
    )
    message = encode_binary_node_minimal(
        {
            "tag": "message",
            "attrs": {"id": "g-1", "to": group_jid},
            "content": [
                {
                    "tag": "participants",
                    "attrs": {},
                    "content": [
                        {
                            "tag": "to",
                            "attrs": {"jid": participant_jid},
                            "content": [
                                {
                                    "tag": "enc",
                                    "attrs": {"type": skdm.type},
                                    "content": skdm.ciphertext,
                                }
                            ],
                        }
                    ],
                },
                {"tag": "enc", "attrs": {"type": "skmsg"}, "content": skmsg},
            ],
        }
    )
    ack_frames = _run(session.handle_inbound(pack_frame(client.transport.encrypt(message))))

    assert len(ack_frames) == 1
    ack_ciphertext, _rest = unpack_frame(ack_frames[0]) or (b"", b"")
    ack = decode_binary_node_minimal(client.transport.decrypt(ack_ciphertext))
    assert ack == {
        "tag": "ack",
        "attrs": {"id": "g-1", "to": group_jid, "class": "message"},
    }
    assert events[-1].stage == "outbound_message"
    assert events[-1].outcome == "decoded"
    assert events[-1].details["encType"] == "skmsg"
    assert outbound_messages == [
        WhatsAppOutboundMessage(
            to_jid=group_jid,
            message_id="g-1",
            message_proto=group_proto,
            enc_type="skmsg",
            attrs={"id": "g-1", "to": group_jid},
            conversation="group reply",
        )
    ]
    group_snapshots = session.group_sender_key_snapshots()
    assert group_snapshots

    async def resolve(_identity: bytes) -> WhatsAppNoiseTenant | None:
        return WhatsAppNoiseTenant(
            tenant_id="tenant-group-restored",
            lid="16693773518:2@s.whatsapp.net",
            group_sender_keys=group_snapshots,
        )

    restored_events: list[WhatsAppNoiseRuntimeEvent] = []
    restored_outbound: list[WhatsAppOutboundMessage] = []
    restored = WhatsAppNoiseEmulatorSession(
        auth_cert=cert,
        lid="fallback:0@lid",
        resolve_client=resolve,
        on_event=restored_events.append,
        on_outbound_message=restored_outbound.append,
    )
    restored_client = _MiniNoiseClient()
    restored_server_frames = _run(
        restored.handle_inbound(
            NOISE_WA_HEADER
            + pack_frame(
                encode_handshake_message(
                    HandshakeMessage(
                        client_hello=ClientHello(ephemeral=restored_client.ephemeral.public)
                    )
                )
            )
        )
    )
    restored_server_hello, _rest = unpack_frame(restored_server_frames[0]) or (b"", b"")
    restored_finish = restored_client.process_server_hello(restored_server_hello, payload=b"")
    restored_bootstrap = _run(restored.handle_inbound(pack_frame(restored_finish)))
    assert restored_client.transport is not None
    for frame in restored_bootstrap:
        ciphertext, _rest = unpack_frame(frame) or (b"", b"")
        restored_client.transport.decrypt(ciphertext)

    restored_group_proto = _bytes_field(1, b"restored group reply")
    restored_skmsg = encrypt_whatsapp_group_message_for_sender_key(
        axolotl_bytes=axolotl,
        plaintext=restored_group_proto,
    )
    restored_message = encode_binary_node_minimal(
        {
            "tag": "message",
            "attrs": {"id": "g-2", "to": group_jid},
            "content": [{"tag": "enc", "attrs": {"type": "skmsg"}, "content": restored_skmsg}],
        }
    )
    restored_ack_frames = _run(
        restored.handle_inbound(pack_frame(restored_client.transport.encrypt(restored_message)))
    )

    assert any(
        event.stage == "group_signal_state" and event.outcome == "restored"
        for event in restored_events
    )
    assert len(restored_ack_frames) == 1
    assert restored_outbound == [
        WhatsAppOutboundMessage(
            to_jid=group_jid,
            message_id="g-2",
            message_proto=restored_group_proto,
            enc_type="skmsg",
            attrs={"id": "g-2", "to": group_jid},
            conversation="restored group reply",
        )
    ]


def test_whatsapp_noise_emulator_session_restores_signal_sender_snapshots():
    cert = _auth_cert()
    session = WhatsAppNoiseEmulatorSession(
        auth_cert=cert,
        lid="16693773518:2@s.whatsapp.net",
    )
    client = _MiniNoiseClient()

    server_frames = _run(
        session.handle_inbound(
            NOISE_WA_HEADER
            + pack_frame(
                encode_handshake_message(
                    HandshakeMessage(client_hello=ClientHello(ephemeral=client.ephemeral.public))
                )
            )
        )
    )
    server_hello, _rest = unpack_frame(server_frames[0]) or (b"", b"")
    client_finish = client.process_server_hello(server_hello, payload=b"")
    bootstrap_frames = _run(session.handle_inbound(pack_frame(client_finish)))
    assert client.transport is not None
    for frame in bootstrap_frames:
        ciphertext, _rest = unpack_frame(frame) or (b"", b"")
        client.transport.decrypt(ciphertext)

    upload = _agent_bundle_upload_node("upload-snapshot-restore")
    upload_frames = _run(session.handle_inbound(pack_frame(client.transport.encrypt(upload))))
    upload_ciphertext, _rest = unpack_frame(upload_frames[0]) or (b"", b"")
    client.transport.decrypt(upload_ciphertext)
    _push_frame, _push_result = _run(
        session.push_inbound_message(
            from_jid="15551112222@s.whatsapp.net",
            message_id="inbound-before-restore",
            message_proto=_bytes_field(1, b"provider hello"),
        )
    )
    assert session.bundle is not None
    snapshots = session.signal_sender_snapshots()
    restored_events: list[WhatsAppNoiseRuntimeEvent] = []
    restored_outbound: list[WhatsAppOutboundMessage] = []

    async def resolve(_identity: bytes) -> WhatsAppNoiseTenant | None:
        return WhatsAppNoiseTenant(
            tenant_id="tenant-restored",
            lid="16693773518:2@s.whatsapp.net",
            pre_key_count=len(session.bundle.pre_keys),
            bundle=session.bundle,
            signal_senders=snapshots,
        )

    restored = WhatsAppNoiseEmulatorSession(
        auth_cert=cert,
        lid="fallback:0@lid",
        resolve_client=resolve,
        on_event=restored_events.append,
        on_outbound_message=restored_outbound.append,
    )
    restored_client = _MiniNoiseClient()
    restored_server_frames = _run(
        restored.handle_inbound(
            NOISE_WA_HEADER
            + pack_frame(
                encode_handshake_message(
                    HandshakeMessage(
                        client_hello=ClientHello(ephemeral=restored_client.ephemeral.public)
                    )
                )
            )
        )
    )
    restored_server_hello, _rest = unpack_frame(restored_server_frames[0]) or (b"", b"")
    restored_finish = restored_client.process_server_hello(restored_server_hello, payload=b"")
    restored_bootstrap = _run(restored.handle_inbound(pack_frame(restored_finish)))
    assert restored_client.transport is not None
    for frame in restored_bootstrap:
        ciphertext, _rest = unpack_frame(frame) or (b"", b"")
        restored_client.transport.decrypt(ciphertext)

    restored_sender = SignalSender(snapshots["15551112222:0@s.whatsapp.net"])
    reply_proto = _bytes_field(1, b"restored reply")
    reply = restored_sender.encrypt_from_established_session("15551112222", 0, reply_proto)
    message = encode_binary_node_minimal(
        {
            "tag": "message",
            "attrs": {"id": "restored-reply", "to": "15551112222@s.whatsapp.net"},
            "content": [{"tag": "enc", "attrs": {"type": reply.type}, "content": reply.ciphertext}],
        }
    )
    ack_frames = _run(
        restored.handle_inbound(pack_frame(restored_client.transport.encrypt(message)))
    )

    assert any(
        event.stage == "signal_state" and event.outcome == "restored" for event in restored_events
    )
    assert len(ack_frames) == 1
    assert restored_outbound == [
        WhatsAppOutboundMessage(
            to_jid="15551112222@s.whatsapp.net",
            message_id="restored-reply",
            message_proto=reply_proto,
            enc_type="msg",
            attrs={"id": "restored-reply", "to": "15551112222@s.whatsapp.net"},
            conversation="restored reply",
        )
    ]


@pytest.mark.asyncio
async def test_whatsapp_baileys_websocket_closes_and_records_malformed_noise(
    client,
    db_session,
    channel_agent,
):
    created = await _create_whatsapp_channel_with_existing_link(
        client,
        db_session,
        channel_agent,
        name="wa-runtime-error",
    )
    websocket = _BinaryWebSocketProbe(headers={"authorization": f"Bearer {created['agent_token']}"})
    route_task = asyncio.create_task(whatsapp_baileys_managed_websocket(websocket))

    websocket.inbound.put_nowait(b"not-a-noise-header")
    await asyncio.wait_for(route_task, timeout=1)

    assert websocket.accepted is True
    assert websocket.closed == [1011]
    await db_session.rollback()
    result = await db_session.execute(
        select(ChannelDebugEvent)
        .where(ChannelDebugEvent.account_id == UUID(created["id"]))
        .order_by(ChannelDebugEvent.created_at.asc(), ChannelDebugEvent.id.asc())
    )
    stages = [(event.stage, event.outcome) for event in result.scalars().all()]
    assert ("noise_intro", "failure") in stages
    assert ("websocket", "error") in stages


def test_whatsapp_baileys_exposes_no_unauthenticated_account_id_websocket() -> None:
    route_paths = {getattr(route, "path", None) for route in whatsapp_router.routes}

    assert "/channels/whatsapp/baileys" in route_paths
    assert "/channels/whatsapp/{account_id}/baileys" not in route_paths


@pytest.mark.asyncio
async def test_managed_whatsapp_websocket_auth_fails_closed_and_revalidates_rotation(
    client,
    db_session,
    channel_agent,
):
    created = await _create_whatsapp_channel_with_existing_link(
        client,
        db_session,
        channel_agent,
        name="wa-managed-upgrade-auth",
    )

    for authorization in [
        None,
        "Bearer wrong-link-token",
        "Bearer capability-marker-is-not-a-backend-bearer",
        "Basic ignored",
    ]:
        websocket = _BinaryWebSocketProbe(
            headers={"authorization": authorization} if authorization else {}
        )
        await whatsapp_baileys_managed_websocket(websocket)
        assert websocket.accepted is False
        assert websocket.closed == [1008]

    valid = _BinaryWebSocketProbe(headers={"authorization": f"Bearer {created['agent_token']}"})
    valid.inbound.put_nowait(WebSocketDisconnect(code=1000))
    await whatsapp_baileys_managed_websocket(valid)
    assert valid.accepted is True
    assert valid.closed == []

    await db_session.rollback()
    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    rotated_token = generate_agent_token("whatsapp")
    store_agent_link_token(link, rotated_token)
    await db_session.commit()

    stale = _BinaryWebSocketProbe(headers={"authorization": f"Bearer {created['agent_token']}"})
    await whatsapp_baileys_managed_websocket(stale)
    assert stale.accepted is False
    assert stale.closed == [1008]

    rotated = _BinaryWebSocketProbe(headers={"authorization": f"Bearer {rotated_token}"})
    rotated.inbound.put_nowait(WebSocketDisconnect(code=1000))
    await whatsapp_baileys_managed_websocket(rotated)
    assert rotated.accepted is True
    assert rotated.closed == []

    await db_session.rollback()
    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    link.status = BOT_AGENT_LINK_STATUS_ARCHIVED
    link.archived_at = datetime.now(UTC)
    await db_session.commit()

    archived = _BinaryWebSocketProbe(headers={"authorization": f"Bearer {rotated_token}"})
    await whatsapp_baileys_managed_websocket(archived)
    assert archived.accepted is False
    assert archived.closed == [1008]


@pytest.mark.asyncio
async def test_managed_whatsapp_websocket_revokes_established_session_after_token_rotation(
    client,
    db_session,
    channel_agent,
):
    created = await _create_whatsapp_channel_with_existing_link(
        client,
        db_session,
        channel_agent,
        name="wa-managed-session-token-rotation",
    )
    synthetic = await _mint_synthetic_credential(db_session, created)
    creds = synthetic.minted.creds
    client_noise = _MiniNoiseClient(
        static=KeyPair(
            private=creds["noiseKey"]["private"],
            public=creds["noiseKey"]["public"],
        )
    )
    websocket, route_task = await _connect_whatsapp_managed_route(
        agent_token=created["agent_token"],
        client_noise=client_noise,
    )
    assert client_noise.transport is not None
    sent_before_rotation = len(websocket.sent)

    await db_session.rollback()
    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    store_agent_link_token(link, generate_agent_token("whatsapp"))
    await db_session.commit()

    count_query = encode_binary_node_minimal(
        {
            "tag": "iq",
            "attrs": {"id": "after-token-rotation", "xmlns": "encrypt", "type": "get"},
            "content": [{"tag": "count", "attrs": {}}],
        }
    )
    websocket.inbound.put_nowait(pack_frame(client_noise.transport.encrypt(count_query)))
    await asyncio.wait_for(route_task, timeout=1)

    assert websocket.closed == [1008]
    assert len(websocket.sent) == sent_before_rotation


@pytest.mark.asyncio
async def test_managed_whatsapp_websocket_revokes_before_delivery_after_link_archive(
    client,
    db_session,
    channel_agent,
):
    created = await _create_whatsapp_channel_with_existing_link(
        client,
        db_session,
        channel_agent,
        name="wa-managed-session-link-archive",
    )
    synthetic = await _mint_synthetic_credential(db_session, created)
    creds = synthetic.minted.creds
    client_noise = _MiniNoiseClient(
        static=KeyPair(
            private=creds["noiseKey"]["private"],
            public=creds["noiseKey"]["public"],
        )
    )
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    account_id = account.id
    account_user_id = account.user_id
    binding = ChannelBinding(
        account_id=account_id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=account_user_id,
        external_chat_id="15551114444@s.whatsapp.net",
        external_chat_type="private",
        external_chat_name="Archived Link Sender",
    )
    db_session.add(binding)
    await db_session.flush()
    binding_id = binding.id
    await db_session.commit()

    websocket, route_task = await _connect_whatsapp_managed_route(
        agent_token=created["agent_token"],
        client_noise=client_noise,
    )
    assert client_noise.transport is not None
    websocket.inbound.put_nowait(
        pack_frame(client_noise.transport.encrypt(_agent_bundle_upload_node("before-link-archive")))
    )
    await websocket.wait_for_sent(4)
    sent_before_archive = len(websocket.sent)

    await db_session.rollback()
    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    link.status = BOT_AGENT_LINK_STATUS_ARCHIVED
    link.archived_at = datetime.now(UTC)
    pending = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=link.id,
        binding_id=binding_id,
        user_id=account_user_id,
        direction=MESSAGE_DIRECTION_INBOUND,
        external_chat_id=binding.external_chat_id,
        provider_message_id="after-link-archive",
        text="must not reach the archived session",
        payload={
            "schemaVersion": "clawdi.whatsappBaileysProviderEvent.v1",
            "key": {
                "remoteJid": binding.external_chat_id,
                "id": "after-link-archive",
                "fromMe": False,
            },
            "messageProtoBase64": base64.b64encode(
                whatsapp_text_message_proto("must not reach the archived session")
            ).decode("ascii"),
        },
    )
    db_session.add(pending)
    await db_session.flush()
    pending_id = pending.id
    await db_session.commit()

    await websocket.wait_for_closed()
    await asyncio.wait_for(route_task, timeout=1)
    assert websocket.closed == [1008]
    assert len(websocket.sent) == sent_before_archive

    await db_session.rollback()
    stored_pending = await db_session.get(ChannelMessage, pending_id)
    assert stored_pending is not None
    assert stored_pending.delivered_at is None


@pytest.mark.asyncio
async def test_managed_whatsapp_noise_identity_is_bound_to_authenticated_link(
    client,
    db_session,
    channel_agent,
    second_channel_agent,
):
    created = await _create_whatsapp_channel_with_existing_link(
        client,
        db_session,
        channel_agent,
        name="wa-managed-link-scope",
    )
    second_token = generate_agent_token("whatsapp")
    second_link = ChannelBotAgentLink(
        account_id=UUID(created["id"]),
        user_id=second_channel_agent.user_id,
        agent_id=second_channel_agent.id,
    )
    store_agent_link_token(second_link, second_token)
    db_session.add(second_link)
    await db_session.commit()
    await db_session.refresh(second_link)
    second_link_id = second_link.id
    synthetic = await _mint_synthetic_credential(
        db_session,
        created,
        link_id=second_link.id,
    )
    creds = synthetic.minted.creds
    static = KeyPair(
        private=creds["noiseKey"]["private"],
        public=creds["noiseKey"]["public"],
    )

    wrong_link_noise = _MiniNoiseClient(static=static)
    wrong_link_websocket = _BinaryWebSocketProbe(
        headers={"authorization": f"Bearer {created['agent_token']}"}
    )
    wrong_link_task = asyncio.create_task(whatsapp_baileys_managed_websocket(wrong_link_websocket))
    wrong_link_websocket.inbound.put_nowait(
        NOISE_WA_HEADER
        + pack_frame(
            encode_handshake_message(
                HandshakeMessage(
                    client_hello=ClientHello(ephemeral=wrong_link_noise.ephemeral.public)
                )
            )
        )
    )
    await wrong_link_websocket.wait_for_sent(1)
    server_hello, rest = unpack_frame(wrong_link_websocket.sent[0]) or (b"", b"")
    assert rest == b""
    wrong_link_websocket.inbound.put_nowait(
        pack_frame(wrong_link_noise.process_server_hello(server_hello, payload=b""))
    )
    await asyncio.wait_for(wrong_link_task, timeout=1)
    assert wrong_link_websocket.accepted is True
    assert wrong_link_websocket.closed == [1008]

    matching_noise = _MiniNoiseClient(static=static)
    matching_websocket, matching_task = await _connect_whatsapp_managed_route(
        agent_token=second_token,
        client_noise=matching_noise,
    )
    assert matching_noise.transport is not None
    assert matching_websocket.accepted is True
    await _disconnect_whatsapp_route(matching_websocket, matching_task)

    archived_noise = _MiniNoiseClient(static=static)
    archived_websocket = _BinaryWebSocketProbe(headers={"authorization": f"Bearer {second_token}"})
    archived_task = asyncio.create_task(whatsapp_baileys_managed_websocket(archived_websocket))
    archived_websocket.inbound.put_nowait(
        NOISE_WA_HEADER
        + pack_frame(
            encode_handshake_message(
                HandshakeMessage(
                    client_hello=ClientHello(ephemeral=archived_noise.ephemeral.public)
                )
            )
        )
    )
    await archived_websocket.wait_for_sent(1)
    server_hello, rest = unpack_frame(archived_websocket.sent[0]) or (b"", b"")
    assert rest == b""

    await db_session.rollback()
    archived_link = await db_session.get(ChannelBotAgentLink, second_link_id)
    assert archived_link is not None
    archived_link.status = BOT_AGENT_LINK_STATUS_ARCHIVED
    archived_link.archived_at = datetime.now(UTC)
    await db_session.commit()

    archived_websocket.inbound.put_nowait(
        pack_frame(archived_noise.process_server_hello(server_hello, payload=b""))
    )
    await asyncio.wait_for(archived_task, timeout=1)
    assert archived_websocket.accepted is True
    assert archived_websocket.closed == [1008]


@pytest.mark.asyncio
async def test_whatsapp_noise_session_surfaces_raw_transport_nodes_for_provider_bridge():
    relayed: list[dict[str, object]] = []
    events: list[WhatsAppNoiseRuntimeEvent] = []

    def on_relay(node, lookup_inbound_sender):
        relayed.append(
            {
                "node": node,
                "unknownSender": lookup_inbound_sender("unknown-message-id"),
            }
        )

    session = WhatsAppNoiseEmulatorSession(
        auth_cert=_auth_cert(),
        lid="16693773518:2@s.whatsapp.net",
        on_event=events.append,
        on_outbound_relay=on_relay,
    )
    client = _MiniNoiseClient()
    client_hello = encode_handshake_message(
        HandshakeMessage(client_hello=ClientHello(ephemeral=client.ephemeral.public))
    )
    server_frames = _run(session.handle_inbound(NOISE_WA_HEADER + pack_frame(client_hello)))
    server_hello, _rest = unpack_frame(server_frames[0]) or (b"", b"")
    client_finish = client.process_server_hello(server_hello, payload=b"")
    _run(session.handle_inbound(pack_frame(client_finish)))
    assert client.transport is not None

    presence = {
        "tag": "presence",
        "attrs": {"type": "composing", "to": "15551114444@s.whatsapp.net"},
    }
    frames = _run(
        session.handle_inbound(
            pack_frame(client.transport.encrypt(encode_binary_node_minimal(presence)))
        )
    )

    assert frames == []
    assert relayed == [{"node": presence, "unknownSender": None}]
    assert ("outbound_relay", "received") in [(event.stage, event.outcome) for event in events]


@pytest.mark.asyncio
async def test_whatsapp_baileys_websocket_records_noise_runtime_debug_events(
    client,
    db_session,
    channel_agent,
    monkeypatch,
):
    created = await _create_whatsapp_channel_with_existing_link(
        client, db_session, channel_agent, name="wa-runtime-debug"
    )
    synthetic = await _mint_synthetic_credential(
        db_session,
        created,
        self_identity={
            "id": "16693773518:2@s.whatsapp.net",
        },
    )
    credential_id = synthetic.credential.id
    creds = synthetic.minted.creds
    static = KeyPair(
        private=creds["noiseKey"]["private"],
        public=creds["noiseKey"]["public"],
    )
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    sidecar_session_id = uuid4()
    sidecar_revision = "self-heal-lid-revision"
    account.config = {
        "connection_mode": "baileys_custom",
        "sidecar_account_id": str(sidecar_session_id),
        "sidecar_config_revision": sidecar_revision,
    }

    class AuthenticatedSidecar:
        async def health(self) -> WhatsAppSidecarHealth:
            return WhatsAppSidecarHealth(
                status="connected",
                connected=True,
                registered=True,
                account_jid="15551234567:1@s.whatsapp.net",
                account_lid="117901482786828:2@lid",
            )

    class AuthenticatedSidecarRegistry:
        def custom_session_revision(self, session_id: UUID) -> str | None:
            return sidecar_revision if session_id == sidecar_session_id else None

        def get_custom_lifecycle_client(self, session_id: UUID, *, config_revision: str):
            if session_id == sidecar_session_id and config_revision == sidecar_revision:
                return AuthenticatedSidecar()
            return None

    monkeypatch.setattr(
        whatsapp_router_module,
        "get_active_whatsapp_sidecar_registry",
        lambda: AuthenticatedSidecarRegistry(),
    )
    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=account.user_id,
        external_chat_id="15551112222@s.whatsapp.net",
        external_chat_type="private",
        external_chat_name="Alice",
    )
    db_session.add(binding)
    await db_session.flush()
    inbox_message = ChannelMessage(
        account_id=account.id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
        binding_id=binding.id,
        user_id=account.user_id,
        direction=MESSAGE_DIRECTION_INBOUND,
        external_chat_id=binding.external_chat_id,
        provider_message_id="push-1",
        text="hello from provider",
        payload={
            "schemaVersion": "clawdi.whatsappBaileysProviderEvent.v1",
            "key": {"remoteJid": binding.external_chat_id, "id": "push-1", "fromMe": False},
            "messageProtoBase64": base64.b64encode(
                whatsapp_text_message_proto("hello from provider")
            ).decode("ascii"),
        },
    )
    db_session.add(inbox_message)
    await db_session.commit()

    client_noise = _MiniNoiseClient(static=static)
    websocket, route_task = await _connect_whatsapp_managed_route(
        agent_token=created["agent_token"],
        client_noise=client_noise,
    )

    assert client_noise.transport is not None
    assert websocket.accepted is True
    bootstrap_frames = websocket.sent[1:3]
    success_ciphertext, _rest = unpack_frame(bootstrap_frames[0]) or (b"", b"")
    success = decode_binary_node_minimal(client_noise.transport.decrypt(success_ciphertext))
    assert success["tag"] == "success"
    assert success["attrs"]["lid"] == "117901482786828:2@lid"
    offline_ciphertext, _rest = unpack_frame(bootstrap_frames[1]) or (b"", b"")
    offline = decode_binary_node_minimal(client_noise.transport.decrypt(offline_ciphertext))
    assert offline == {"tag": "offline", "attrs": {"count": "0"}}

    upload = _agent_bundle_upload_node("upload-1")
    websocket.inbound.put_nowait(pack_frame(client_noise.transport.encrypt(upload)))
    await websocket.wait_for_sent(4)
    upload_ciphertext, _rest = unpack_frame(websocket.sent[3]) or (b"", b"")
    upload_ack = decode_binary_node_minimal(client_noise.transport.decrypt(upload_ciphertext))
    assert upload_ack["attrs"]["id"] == "upload-1"
    await websocket.wait_for_sent(5)
    pushed_ciphertext, _rest = unpack_frame(websocket.sent[4]) or (b"", b"")
    pushed = decode_binary_node_minimal(client_noise.transport.decrypt(pushed_ciphertext))
    assert pushed["tag"] == "message"
    assert pushed["attrs"]["id"] == "push-1"
    assert pushed["attrs"]["from"] == "15551112222@s.whatsapp.net"
    assert pushed["content"][0]["tag"] == "enc"
    assert pushed["content"][0]["attrs"]["type"] == "pkmsg"
    await _wait_for_delivered_message(db_session, inbox_message.id)

    await db_session.rollback()
    active_credential = await db_session.get(
        ChannelAgentCredential,
        credential_id,
        populate_existing=True,
    )
    assert active_credential is not None
    snapshots = whatsapp_signal_senders_from_config(active_credential.config)
    reply_sender = SignalSender(snapshots["15551112222:0@s.whatsapp.net"])
    reply_proto = _bytes_field(1, b"agent websocket reply")
    reply = reply_sender.encrypt_from_established_session("15551112222", 0, reply_proto)
    reply_node = encode_binary_node_minimal(
        {
            "tag": "message",
            "attrs": {"id": "agent-reply-1", "to": "15551112222@s.whatsapp.net"},
            "content": [{"tag": "enc", "attrs": {"type": reply.type}, "content": reply.ciphertext}],
        }
    )
    websocket.inbound.put_nowait(pack_frame(client_noise.transport.encrypt(reply_node)))
    await websocket.wait_for_sent(6)
    reply_ack_ciphertext, _rest = unpack_frame(websocket.sent[5]) or (b"", b"")
    reply_ack = decode_binary_node_minimal(client_noise.transport.decrypt(reply_ack_ciphertext))
    assert reply_ack["attrs"]["id"] == "agent-reply-1"
    await _wait_for_outbound_message(
        account_id=UUID(created["id"]),
        external_chat_id="15551112222@s.whatsapp.net",
        text="agent websocket reply",
    )
    await _disconnect_whatsapp_route(websocket, route_task)

    await db_session.rollback()
    credential = await db_session.get(
        ChannelAgentCredential,
        credential_id,
        populate_existing=True,
    )
    assert credential is not None
    assert credential.config is not None
    assert credential.config["self_identity"] == {
        "id": "16693773518:2@s.whatsapp.net",
        "lid": "117901482786828:2@lid",
    }
    assert credential.config["agent_bundle"]["registrationId"] == 12345
    assert len(credential.config["agent_bundle"]["preKeys"]) == 1
    assert "15551112222:0@s.whatsapp.net" in credential.config["signal_senders"]

    reconnect_noise = _MiniNoiseClient(static=static)
    reconnect_websocket, reconnect_task = await _connect_whatsapp_managed_route(
        agent_token=created["agent_token"],
        client_noise=reconnect_noise,
    )
    assert reconnect_noise.transport is not None
    for frame in reconnect_websocket.sent[1:3]:
        ciphertext, _rest = unpack_frame(frame) or (b"", b"")
        reconnect_noise.transport.decrypt(ciphertext)
    count_query = encode_binary_node_minimal(
        {
            "tag": "iq",
            "attrs": {"id": "q-reconnect", "xmlns": "encrypt", "type": "get"},
            "content": [{"tag": "count", "attrs": {}}],
        }
    )
    reconnect_websocket.inbound.put_nowait(
        pack_frame(reconnect_noise.transport.encrypt(count_query))
    )
    await reconnect_websocket.wait_for_sent(4)
    count_ciphertext, _rest = unpack_frame(reconnect_websocket.sent[3]) or (b"", b"")
    count = decode_binary_node_minimal(reconnect_noise.transport.decrypt(count_ciphertext))
    assert count["attrs"]["id"] == "q-reconnect"
    assert count["content"][0]["attrs"]["value"] == "1"
    await _disconnect_whatsapp_route(reconnect_websocket, reconnect_task)

    await db_session.rollback()
    result = await db_session.execute(
        select(ChannelDebugEvent)
        .where(ChannelDebugEvent.account_id == UUID(created["id"]))
        .order_by(ChannelDebugEvent.created_at.asc(), ChannelDebugEvent.id.asc())
    )
    events = list(result.scalars().all())
    stages = [(event.stage, event.outcome) for event in events]

    assert ("tenant_resolution", "resolved") in stages
    assert ("bootstrap", "sent") in stages
    assert ("agent_bundle", "restored") in stages
    assert ("signal_state", "restored") in stages
    assert ("outbound_delivery", "queued") in stages
    bootstrap = next(event for event in events if event.stage == "bootstrap")
    assert bootstrap.provider == "whatsapp"
    assert bootstrap.direction == "agent"
    assert bootstrap.external_chat_id == "117901482786828:2@lid"
    assert bootstrap.details["runtime"] == "baileys_websocket"
    assert bootstrap.details["jidDescription"] == "server=lid device=true"
    identity_pub_key_hex = synthetic.minted.identity_pub_key.hex()
    assert identity_pub_key_hex not in repr([event.details for event in events])
    tenant_event = next(event for event in events if event.stage == "tenant_resolution")
    assert (
        tenant_event.details["clientStaticSha256"]
        == hashlib.sha256(synthetic.minted.identity_pub_key).hexdigest()
    )
    restored_event = next(
        event for event in events if event.stage == "agent_bundle" and event.outcome == "restored"
    )
    assert restored_event.details["preCount"] == 1
    signal_state_event = next(
        event for event in events if event.stage == "signal_state" and event.outcome == "restored"
    )
    assert signal_state_event.details["senderCount"] == 1


async def _connect_whatsapp_managed_route(
    *,
    agent_token: str,
    client_noise: _MiniNoiseClient,
) -> tuple[_BinaryWebSocketProbe, asyncio.Task[None]]:
    websocket = _BinaryWebSocketProbe(headers={"authorization": f"Bearer {agent_token}"})
    route_task = asyncio.create_task(whatsapp_baileys_managed_websocket(websocket))
    websocket.inbound.put_nowait(
        NOISE_WA_HEADER
        + pack_frame(
            encode_handshake_message(
                HandshakeMessage(client_hello=ClientHello(ephemeral=client_noise.ephemeral.public))
            )
        )
    )
    await websocket.wait_for_sent(1)
    server_hello, rest = unpack_frame(websocket.sent[0]) or (b"", b"")
    assert rest == b""
    client_finish = client_noise.process_server_hello(server_hello, payload=b"")
    websocket.inbound.put_nowait(pack_frame(client_finish))
    await websocket.wait_for_sent(3)
    return websocket, route_task


async def _disconnect_whatsapp_route(
    websocket: _BinaryWebSocketProbe,
    route_task: asyncio.Task[None],
) -> None:
    websocket.inbound.put_nowait(WebSocketDisconnect(code=1000))
    await asyncio.wait_for(route_task, timeout=1)


async def _wait_for_delivered_message(db_session, message_id: UUID) -> None:
    del db_session
    async with async_session_factory() as fresh_db:
        for _ in range(50):
            result = await fresh_db.execute(
                select(ChannelMessage.delivered_at).where(ChannelMessage.id == message_id)
            )
            if result.scalar_one_or_none() is not None:
                return
            await asyncio.sleep(0.01)
    raise AssertionError("message was not marked delivered")


async def _wait_for_outbound_message(
    *,
    account_id: UUID,
    external_chat_id: str,
    text: str,
) -> ChannelMessage:
    async with async_session_factory() as fresh_db:
        for _ in range(50):
            result = await fresh_db.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == account_id,
                    ChannelMessage.direction == MESSAGE_DIRECTION_OUTBOUND,
                    ChannelMessage.external_chat_id == external_chat_id,
                    ChannelMessage.text == text,
                )
            )
            message = result.scalar_one_or_none()
            if message is not None:
                return message
            await asyncio.sleep(0.01)
    raise AssertionError("outbound message was not queued")


def _agent_bundle_upload_node(iq_id: str) -> bytes:
    return encode_binary_node_minimal(
        {
            "tag": "iq",
            "attrs": {"id": iq_id, "xmlns": "encrypt", "type": "set"},
            "content": [
                {"tag": "registration", "attrs": {}, "content": (12345).to_bytes(4, "big")},
                {"tag": "identity", "attrs": {}, "content": b"\x05" + bytes(range(32))},
                {
                    "tag": "list",
                    "attrs": {},
                    "content": [
                        {
                            "tag": "key",
                            "attrs": {},
                            "content": [
                                {"tag": "id", "attrs": {}, "content": (1).to_bytes(3, "big")},
                                {"tag": "value", "attrs": {}, "content": bytes(range(32, 64))},
                            ],
                        },
                        {
                            "tag": "key",
                            "attrs": {},
                            "content": [
                                {"tag": "id", "attrs": {}, "content": (2).to_bytes(3, "big")},
                                {"tag": "value", "attrs": {}, "content": bytes(range(64, 96))},
                            ],
                        },
                    ],
                },
                {
                    "tag": "skey",
                    "attrs": {},
                    "content": [
                        {"tag": "id", "attrs": {}, "content": (7).to_bytes(3, "big")},
                        {"tag": "value", "attrs": {}, "content": bytes(range(96, 128))},
                        {"tag": "signature", "attrs": {}, "content": bytes(64)},
                    ],
                },
            ],
        }
    )


class _BinaryWebSocketProbe:
    def __init__(self, *, headers: dict[str, str] | None = None) -> None:
        self.inbound: asyncio.Queue[bytes | WebSocketDisconnect] = asyncio.Queue()
        self.sent: list[bytes] = []
        self.accepted = False
        self.closed: list[int] = []
        self._sent = asyncio.Event()
        self._closed = asyncio.Event()
        self.headers = headers or {}

    async def accept(self) -> None:
        self.accepted = True

    async def receive_bytes(self) -> bytes:
        item = await self.inbound.get()
        if isinstance(item, WebSocketDisconnect):
            raise item
        return item

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(data)
        self._sent.set()

    async def close(self, code: int = 1000) -> None:
        self.closed.append(code)
        self._closed.set()

    async def wait_for_sent(self, count: int) -> None:
        while len(self.sent) < count:
            self._sent.clear()
            await asyncio.wait_for(self._sent.wait(), timeout=1)

    async def wait_for_closed(self) -> None:
        await asyncio.wait_for(self._closed.wait(), timeout=1)


class _MiniNoiseClient:
    def __init__(self, *, static: KeyPair | None = None) -> None:
        self.ephemeral = generate_key_pair()
        self.static = static or generate_key_pair()
        h = NOISE_MODE if len(NOISE_MODE) == 32 else hashlib.sha256(NOISE_MODE).digest()
        self._hash = h
        self._salt = h
        self._enc_key = h
        self._dec_key = h
        self._counter = 0
        self.transport: TransportState | None = None
        self._authenticate(NOISE_WA_HEADER)
        self._authenticate(self.ephemeral.public)

    def process_server_hello(self, server_hello_bytes: bytes, *, payload: bytes) -> bytes:
        message = decode_handshake_message(server_hello_bytes)
        assert message.server_hello is not None
        server_hello = message.server_hello
        self._authenticate(server_hello.ephemeral)
        self._mix_into_key(_shared_key(self.ephemeral.private, server_hello.ephemeral))
        server_static_public = self._decrypt(server_hello.static)
        self._mix_into_key(_shared_key(self.ephemeral.private, server_static_public))
        cert_chain = self._decrypt(server_hello.payload)
        assert cert_chain
        encrypted_static = self._encrypt(self.static.public)
        self._mix_into_key(_shared_key(self.static.private, server_hello.ephemeral))
        encrypted_payload = self._encrypt(payload)
        self._finish_init()
        return encode_handshake_message(
            HandshakeMessage(
                client_finish=ClientFinish(
                    static=encrypted_static,
                    payload=encrypted_payload,
                )
            )
        )

    def _authenticate(self, data: bytes) -> None:
        if self.transport is None:
            self._hash = hashlib.sha256(self._hash + data).digest()

    def _encrypt(self, plaintext: bytes) -> bytes:
        ciphertext = AESGCM(self._enc_key).encrypt(_iv(self._counter), plaintext, self._hash)
        self._counter += 1
        self._authenticate(ciphertext)
        return ciphertext

    def _decrypt(self, ciphertext: bytes) -> bytes:
        plaintext = AESGCM(self._dec_key).decrypt(_iv(self._counter), ciphertext, self._hash)
        self._counter += 1
        self._authenticate(ciphertext)
        return plaintext

    def _mix_into_key(self, data: bytes) -> None:
        key = _hkdf(data, salt=self._salt, length=64)
        self._salt = key[:32]
        self._enc_key = key[32:]
        self._dec_key = self._enc_key
        self._counter = 0

    def _finish_init(self) -> None:
        key = _hkdf(b"", salt=self._salt, length=64)
        self.transport = TransportState(enc_key=key[:32], dec_key=key[32:])


def _auth_cert() -> WhatsAppAuthCert:
    root = generate_key_pair()
    intermediate = generate_key_pair()
    return WhatsAppAuthCert(
        serial=0,
        issuer="clawdi",
        root_public_key=root.public,
        root_private_key=root.private,
        intermediate_public_key=intermediate.public,
        intermediate_private_key=intermediate.private,
    )


def _run(coro):
    try:
        return coro.send(None)
    except StopIteration as exc:
        return exc.value
