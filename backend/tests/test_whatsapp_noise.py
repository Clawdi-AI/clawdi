from __future__ import annotations

import asyncio
import hashlib
import hmac
from typing import Any
from uuid import UUID

import pytest
from cryptography.hazmat.primitives import hashes, padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker
from starlette.websockets import WebSocketDisconnect

from app.core.database import async_session_factory
from app.models.channel import (
    MESSAGE_DIRECTION_INBOUND,
    MESSAGE_DIRECTION_OUTBOUND,
    ChannelAccount,
    ChannelAgentCredential,
    ChannelBinding,
    ChannelDebugEvent,
    ChannelDelivery,
    ChannelMessage,
)
from app.routes.channel_routers.whatsapp import whatsapp_baileys_agent_websocket
from app.services.channel_delivery_worker import ChannelDeliveryWorker
from app.services.whatsapp_baileys import (
    SignalSender,
    WhatsAppAuthCert,
    decode_buffer_json,
    encrypt_whatsapp_group_message_for_sender_key,
    whatsapp_message_proto_bytes,
    whatsapp_signal_senders_from_config,
)
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
    _shared_key,
    _unpad_random_max16,
    decode_binary_node_minimal,
    decode_handshake_message,
    encode_binary_node_minimal,
    encode_handshake_message,
    generate_key_pair,
    pack_frame,
    unpack_frame,
)
from app.services.whatsapp_shared_runtime import (
    WhatsAppClawdiOutboxSharedBotRuntime,
    register_whatsapp_shared_bot_transport,
    unregister_whatsapp_shared_bot_transport,
)

pytestmark = [pytest.mark.usefixtures("channel_agent"), pytest.mark.committed_db]


class _FakeWhatsAppMediaUploadResponse:
    status_code = 200
    headers: dict[str, str] = {}

    def json(self):
        return {"id": "uploaded-media-id"}


class _FakeWhatsAppMediaDownloadResponse:
    status_code = 200

    def __init__(self, content: bytes):
        self._content = content
        self.headers = {"content-length": str(len(content))}

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def aiter_bytes(self):
        midpoint = max(1, len(self._content) // 2)
        yield self._content[:midpoint]
        yield self._content[midpoint:]


class _FakeWhatsAppMediaReuploadClient:
    encrypted_media = b""
    calls: list[dict[str, Any]] = []
    message_calls: list[dict[str, Any]] = []

    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    def stream(self, method: str, url: str):
        self.calls.append({"method": method, "url": url, "kind": "download"})
        return _FakeWhatsAppMediaDownloadResponse(self.encrypted_media)

    async def post(self, url: str, **kwargs):
        if url.endswith("/messages"):
            self.message_calls.append({"url": url, **kwargs})
            return _FakeWhatsAppCloudMessagesResponse()
        self.calls.append({"method": "POST", "url": url, "kind": "upload", **kwargs})
        return _FakeWhatsAppMediaUploadResponse()


class _FakeWhatsAppCloudMessagesResponse:
    status_code = 200

    def json(self):
        return {"messages": [{"id": "wamid.reuploaded"}]}


def _encrypt_whatsapp_media(
    *,
    kind: str,
    media_key: bytes,
    plaintext: bytes,
) -> bytes:
    info = {
        "image": b"WhatsApp Image Keys",
        "audio": b"WhatsApp Audio Keys",
    }[kind]
    expanded = HKDF(
        algorithm=hashes.SHA256(),
        length=112,
        salt=None,
        info=info,
    ).derive(media_key)
    iv = expanded[:16]
    cipher_key = expanded[16:48]
    mac_key = expanded[48:80]
    padder = padding.PKCS7(128).padder()
    padded = padder.update(plaintext) + padder.finalize()
    encryptor = Cipher(algorithms.AES(cipher_key), modes.CBC(iv)).encryptor()
    ciphertext = encryptor.update(padded) + encryptor.finalize()
    mac = hmac.new(mac_key, iv + ciphertext, hashlib.sha256).digest()[:10]
    return ciphertext + mac


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
    assert pushed["attrs"]["sender_lid"] == "15551112222@lid"
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

    push_frame, _push_result = _run(
        session.push_inbound_message(
            from_jid="15551112222@s.whatsapp.net",
            message_id="inbound-before-reply",
            message_proto=_bytes_field(1, b"provider hello"),
        )
    )
    push_ciphertext, _rest = unpack_frame(push_frame) or (b"", b"")
    client.transport.decrypt(push_ciphertext)

    sender = session._signal_senders["15551112222:0@s.whatsapp.net"]
    reply_proto = _bytes_field(1, b"agent reply")
    reply = sender.encrypt_from_established_session("16693773518", 2, reply_proto)
    message = encode_binary_node_minimal(
        {
            "tag": "message",
            "attrs": {"id": "m-1", "to": "15551112222@s.whatsapp.net"},
            "content": [{"tag": "enc", "attrs": {"type": reply.type}, "content": reply.ciphertext}],
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
        "children": ["enc"],
    }
    assert outbound_messages == [
        WhatsAppOutboundMessage(
            to_jid="15551112222@s.whatsapp.net",
            message_id="m-1",
            message_proto=reply_proto,
            enc_type="msg",
            attrs={"id": "m-1", "to": "15551112222@s.whatsapp.net"},
            conversation="agent reply",
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
    skdm = sender.encrypt_from_established_session("16693773518", 2, skdm_proto)
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
    reply = restored_sender.encrypt_from_established_session("16693773518", 2, reply_proto)
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
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-runtime-error"},
        )
    ).json()
    websocket = _BinaryWebSocketProbe()
    route_task = asyncio.create_task(
        whatsapp_baileys_agent_websocket(websocket, UUID(created["id"]))
    )

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


@pytest.mark.asyncio
async def test_whatsapp_shared_runtime_queues_cloud_sendable_proto_and_records_native_gap(
    client,
    db_session,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-shared-runtime"},
        )
    ).json()
    await db_session.rollback()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=account.user_id,
        external_chat_id="15551114444@s.whatsapp.net",
        external_chat_type="private",
        external_chat_name="Alice",
    )
    db_session.add(binding)
    await db_session.commit()

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    runtime = WhatsAppClawdiOutboxSharedBotRuntime(
        sessionmaker,
        account_id=account.id,
    )

    queued = await runtime.store_outbound_message(
        WhatsAppOutboundMessage(
            to_jid="15551114444@s.whatsapp.net",
            message_id="agent-text-1",
            message_proto=_bytes_field(1, b"shared runtime text"),
            enc_type="msg",
            attrs={},
            conversation="shared runtime text",
        )
    )

    assert queued.outcome == "queued"
    assert queued.channel_message_id is not None
    assert queued.delivery_id is not None
    quoted = await runtime.store_outbound_message(
        WhatsAppOutboundMessage(
            to_jid="15551114444@s.whatsapp.net",
            message_id="agent-quoted-1",
            message_proto=whatsapp_message_proto_bytes(
                {
                    "message": {
                        "extendedTextMessage": {
                            "text": "reply with quote",
                            "contextInfo": {"stanzaId": "wamid.original"},
                        }
                    }
                },
                text=None,
            ),
            enc_type="msg",
            attrs={},
            conversation=None,
        )
    )
    encrypted_image = await runtime.store_outbound_message(
        WhatsAppOutboundMessage(
            to_jid="15551114444@s.whatsapp.net",
            message_id="agent-media-1",
            message_proto=whatsapp_message_proto_bytes(
                {
                    "message": {
                        "imageMessage": {
                            "url": "https://mmg.whatsapp.net/o1/v/test",
                            "caption": "tiny red dot",
                            "mediaKey": "8N6ORZLxSd3MHhbHAnsVAeX4ss4495v05BrZG1scD68=",
                            "directPath": "/o1/v/test",
                        }
                    }
                },
                text=None,
            ),
            enc_type="msg",
            attrs={},
            conversation=None,
        )
    )

    assert quoted.outcome == "queued"
    assert quoted.channel_message_id is not None
    assert quoted.delivery_id is not None
    assert encrypted_image.outcome == "unsupported"
    assert encrypted_image.reason == "media-reupload-required"

    await db_session.rollback()
    channel_message = await db_session.get(ChannelMessage, queued.channel_message_id)
    assert channel_message is not None
    assert channel_message.direction == MESSAGE_DIRECTION_OUTBOUND
    assert channel_message.binding_id == binding.id
    assert channel_message.text == "shared runtime text"
    assert channel_message.payload["source"] == "baileys_websocket"
    assert channel_message.payload["sharedRuntime"] == "clawdi_outbox"
    assert channel_message.payload["providerMessageId"] == "agent-text-1"
    assert channel_message.payload["providerPayload"] == {
        "type": "text",
        "text": {"body": "shared runtime text"},
    }

    quoted_message = await db_session.get(ChannelMessage, quoted.channel_message_id)
    assert quoted_message is not None
    assert quoted_message.text == "reply with quote"
    assert quoted_message.payload["protoKind"] == "extended_text"
    assert quoted_message.payload["providerPayload"] == {
        "type": "text",
        "text": {"body": "reply with quote"},
        "context": {"message_id": "wamid.original"},
    }

    result = await db_session.execute(
        select(ChannelDebugEvent)
        .where(ChannelDebugEvent.account_id == account.id)
        .order_by(ChannelDebugEvent.created_at.asc(), ChannelDebugEvent.id.asc())
    )
    events = list(result.scalars().all())
    assert [(event.stage, event.outcome) for event in events] == [
        ("outbound_delivery", "queued"),
        ("outbound_delivery", "queued"),
        ("outbound_delivery", "unsupported"),
    ]
    assert events[0].details["sharedRuntime"] == "clawdi_outbox"
    assert events[1].details["protoKind"] == "extended_text"
    assert events[2].details["reason"] == "media-reupload-required"


@pytest.mark.asyncio
async def test_whatsapp_shared_runtime_reuploads_encrypted_image_media(
    client,
    db_session,
    monkeypatch,
):
    media_key = bytes(range(32))
    plaintext = b"\x89PNG\r\n\x1a\nclawdi-whatsapp-media"
    encrypted = _encrypt_whatsapp_media(
        kind="image",
        media_key=media_key,
        plaintext=plaintext,
    )
    _FakeWhatsAppMediaReuploadClient.encrypted_media = encrypted
    _FakeWhatsAppMediaReuploadClient.calls = []
    _FakeWhatsAppMediaReuploadClient.message_calls = []
    monkeypatch.setattr(
        "app.services.whatsapp_media_reupload.httpx.AsyncClient",
        _FakeWhatsAppMediaReuploadClient,
    )
    monkeypatch.setattr(
        "app.services.channels.httpx.AsyncClient",
        _FakeWhatsAppMediaReuploadClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-shared-runtime-media-reupload",
                "provider_token": "wa-access-token",
                "config": {
                    "phone_number_id": "phone-123",
                    "graph_api_base_url": "https://graph.example.test/v20.0",
                },
            },
        )
    ).json()
    await db_session.rollback()
    account_id = UUID(created["id"])
    account = await db_session.get(ChannelAccount, account_id)
    assert account is not None

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    runtime = WhatsAppClawdiOutboxSharedBotRuntime(
        sessionmaker,
        account_id=account_id,
    )

    queued = await runtime.store_outbound_message(
        WhatsAppOutboundMessage(
            to_jid="15551114444@s.whatsapp.net",
            message_id="agent-media-reupload-1",
            message_proto=whatsapp_message_proto_bytes(
                {
                    "message": {
                        "imageMessage": {
                            "url": "https://mmg.whatsapp.net/o1/v/test",
                            "mimetype": "image/png",
                            "caption": "tiny red dot",
                            "mediaKey": media_key,
                            "fileSha256": hashlib.sha256(plaintext).digest(),
                            "fileEncSha256": hashlib.sha256(encrypted).digest(),
                            "directPath": "/o1/v/test",
                        }
                    }
                },
                text=None,
            ),
            enc_type="msg",
            attrs={},
            conversation=None,
        )
    )

    assert queued.outcome == "queued"
    assert queued.channel_message_id is not None
    assert queued.delivery_id is not None
    assert _FakeWhatsAppMediaReuploadClient.calls[0] == {
        "method": "GET",
        "url": "https://mmg.whatsapp.net/o1/v/test",
        "kind": "download",
    }
    upload_call = _FakeWhatsAppMediaReuploadClient.calls[1]
    assert upload_call["url"] == "https://graph.example.test/v20.0/phone-123/media"
    assert upload_call["headers"] == {"Authorization": "Bearer wa-access-token"}
    assert upload_call["data"] == {"messaging_product": "whatsapp", "type": "image/png"}
    assert upload_call["files"]["file"] == ("whatsapp-image.png", plaintext, "image/png")

    await db_session.rollback()
    channel_message = await db_session.get(ChannelMessage, queued.channel_message_id)
    assert channel_message is not None
    assert channel_message.direction == MESSAGE_DIRECTION_OUTBOUND
    assert channel_message.text == "tiny red dot"
    assert channel_message.payload["providerPayload"] == {
        "type": "image",
        "image": {"id": "uploaded-media-id", "caption": "tiny red dot"},
    }
    assert "link" not in channel_message.payload["providerPayload"]["image"]

    event = (
        await db_session.execute(
            select(ChannelDebugEvent).where(ChannelDebugEvent.account_id == account_id)
        )
    ).scalar_one()
    assert event.stage == "outbound_delivery"
    assert event.outcome == "queued"
    assert event.details["reason"] == "media-reupload-required"
    assert event.details["mediaKind"] == "image"
    assert event.details["mediaReupload"] == "uploaded"

    delivered_id = await ChannelDeliveryWorker(sessionmaker).run_once()
    assert delivered_id == queued.delivery_id

    await db_session.rollback()
    delivery = (
        await db_session.execute(
            select(ChannelDelivery)
            .where(ChannelDelivery.id == queued.delivery_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert delivery.status == "succeeded"
    assert _FakeWhatsAppMediaReuploadClient.message_calls[0]["url"] == (
        "https://graph.example.test/v20.0/phone-123/messages"
    )
    assert _FakeWhatsAppMediaReuploadClient.message_calls[0]["json"] == {
        "messaging_product": "whatsapp",
        "to": "15551114444",
        "type": "image",
        "image": {"id": "uploaded-media-id", "caption": "tiny red dot"},
    }


@pytest.mark.asyncio
async def test_whatsapp_shared_runtime_relays_native_required_proto_when_transport_exists(
    client,
    db_session,
):
    class FakeNativeTransport:
        def __init__(self):
            self.outbound_messages: list[WhatsAppOutboundMessage] = []

        async def relay_outbound_message(self, message):
            self.outbound_messages.append(message)

        async def relay_raw_node(self, node):
            raise AssertionError("raw relay should not be used")

        async def query_iq(self, node, timeout_ms):
            raise AssertionError("iq forwarding should not be used")

    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-shared-runtime-native"},
        )
    ).json()
    await db_session.rollback()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    account_id = account.id

    transport = FakeNativeTransport()
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    runtime = WhatsAppClawdiOutboxSharedBotRuntime(
        sessionmaker,
        account_id=account_id,
        transport=transport,
    )

    relayed = await runtime.store_outbound_message(
        WhatsAppOutboundMessage(
            to_jid="15551114444@s.whatsapp.net",
            message_id="agent-media-native-1",
            message_proto=whatsapp_message_proto_bytes(
                {
                    "message": {
                        "imageMessage": {
                            "url": "https://mmg.whatsapp.net/o1/v/test",
                            "caption": "tiny red dot",
                            "mediaKey": "8N6ORZLxSd3MHhbHAnsVAeX4ss4495v05BrZG1scD68=",
                            "directPath": "/o1/v/test",
                        }
                    }
                },
                text=None,
            ),
            enc_type="msg",
            attrs={},
            conversation=None,
        )
    )

    assert relayed.outcome == "relayed"
    assert transport.outbound_messages[0].message_id == "agent-media-native-1"

    await db_session.rollback()
    result = await db_session.execute(
        select(ChannelDebugEvent)
        .where(ChannelDebugEvent.account_id == account_id)
        .order_by(ChannelDebugEvent.created_at.asc(), ChannelDebugEvent.id.asc())
    )
    event = result.scalar_one()
    assert event.stage == "outbound_delivery"
    assert event.outcome == "relayed"
    assert event.details["reason"] == "media-reupload-required"
    assert event.details["nativeTransport"] == "relayed"


@pytest.mark.asyncio
async def test_whatsapp_shared_runtime_preserves_baileys_relay_attrs_via_native_transport(
    client,
    db_session,
):
    class FakeNativeTransport:
        def __init__(self):
            self.outbound_messages: list[WhatsAppOutboundMessage] = []

        async def relay_outbound_message(self, message):
            self.outbound_messages.append(message)

        async def relay_raw_node(self, node):
            raise AssertionError("raw relay should not be used")

        async def query_iq(self, node, timeout_ms):
            raise AssertionError("iq forwarding should not be used")

    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-shared-runtime-native-attrs"},
        )
    ).json()
    await db_session.rollback()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    account_id = account.id

    transport = FakeNativeTransport()
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    runtime = WhatsAppClawdiOutboxSharedBotRuntime(
        sessionmaker,
        account_id=account_id,
        transport=transport,
    )

    relayed = await runtime.store_outbound_message(
        WhatsAppOutboundMessage(
            to_jid="15551114444@s.whatsapp.net",
            message_id="agent-edit-1",
            message_proto=_bytes_field(1, b"edited text"),
            enc_type="msg",
            attrs={
                "id": "agent-edit-1",
                "to": "15551114444@s.whatsapp.net",
                "type": "text",
                "edit": "8",
                "addressing_mode": "lid",
                "category": "peer",
            },
            conversation="edited text",
        )
    )

    assert relayed.outcome == "relayed"
    assert transport.outbound_messages[0].attrs == {
        "id": "agent-edit-1",
        "to": "15551114444@s.whatsapp.net",
        "type": "text",
        "edit": "8",
        "addressing_mode": "lid",
        "category": "peer",
    }

    await db_session.rollback()
    result = await db_session.execute(
        select(ChannelDebugEvent)
        .where(ChannelDebugEvent.account_id == account_id)
        .order_by(ChannelDebugEvent.created_at.asc(), ChannelDebugEvent.id.asc())
    )
    event = result.scalar_one()
    assert event.stage == "outbound_delivery"
    assert event.outcome == "relayed"
    assert event.details["reason"] == "baileys-relay-attrs-required"
    assert event.details["nativeTransport"] == "relayed"


@pytest.mark.asyncio
async def test_whatsapp_noise_session_surfaces_raw_transport_nodes_for_shared_runtime():
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
async def test_whatsapp_shared_runtime_relays_raw_nodes_and_forwards_iq(
    client,
    db_session,
):
    class FakeSharedBotTransport:
        def __init__(self):
            self.raw_nodes: list[dict[str, object]] = []
            self.iq_queries: list[tuple[dict[str, object], int]] = []

        async def relay_raw_node(self, node):
            self.raw_nodes.append(node)

        async def query_iq(self, node, timeout_ms):
            self.iq_queries.append((node, timeout_ms))
            return {
                "tag": "iq",
                "attrs": {"id": "upstream-id", "type": "result", "from": "s.whatsapp.net"},
                "content": [{"tag": "props", "attrs": {"hash": "abc"}}],
            }

    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-shared-runtime-raw"},
        )
    ).json()
    await db_session.rollback()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=account.user_id,
        external_chat_id="15551114444@s.whatsapp.net",
        external_chat_type="private",
        external_chat_name="Alice",
    )
    db_session.add(binding)
    await db_session.commit()

    transport = FakeSharedBotTransport()
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    runtime = WhatsAppClawdiOutboxSharedBotRuntime(
        sessionmaker,
        account_id=account.id,
        transport=transport,
    )
    relayed = await runtime.relay_raw_node(
        {
            "tag": "chatstate",
            "attrs": {
                "to": "15551114444@s.whatsapp.net",
                "from": "spoof@s.whatsapp.net",
                "name": "spoof",
            },
            "content": [{"tag": "composing", "attrs": {"name": "nested-spoof"}}],
        },
        lambda _message_id: None,
    )
    dropped = await runtime.relay_raw_node(
        {"tag": "presence", "attrs": {"to": "15559999999@s.whatsapp.net"}},
        lambda _message_id: None,
    )
    forwarded = await runtime.forward_iq(
        {
            "tag": "iq",
            "attrs": {"id": "agent-q-1", "xmlns": "w", "type": "get", "to": "s.whatsapp.net"},
            "content": [{"tag": "props", "attrs": {}}],
        },
        created["agent_link_id"],
    )

    assert relayed.outcome == "relayed"
    assert dropped.outcome == "dropped"
    assert dropped.reason == "unbound-jid"
    assert transport.raw_nodes == [
        {
            "tag": "chatstate",
            "attrs": {"to": "15551114444@s.whatsapp.net"},
            "content": [{"tag": "composing", "attrs": {}}],
        }
    ]
    assert transport.iq_queries[0][0]["attrs"].get("id") is None
    assert transport.iq_queries[0][1] == 15_000
    assert forwarded is not None
    assert forwarded["attrs"]["id"] == "agent-q-1"
    assert forwarded["content"] == [{"tag": "props", "attrs": {"hash": "abc"}}]

    await db_session.rollback()
    result = await db_session.execute(
        select(ChannelDebugEvent)
        .where(ChannelDebugEvent.account_id == account.id)
        .order_by(ChannelDebugEvent.created_at.asc(), ChannelDebugEvent.id.asc())
    )
    events = list(result.scalars().all())
    assert [(event.stage, event.outcome) for event in events] == [
        ("outbound_relay", "relayed"),
        ("outbound_relay", "dropped"),
    ]
    assert events[0].details["tag"] == "chatstate"
    assert events[1].details["reason"] == "unbound-jid"


@pytest.mark.asyncio
async def test_whatsapp_shared_runtime_relays_read_receipt_via_cloud_api_without_native_transport(
    client,
    db_session,
    monkeypatch,
):
    class FakeCloudResponse:
        status_code = 200

    class FakeCloudClient:
        calls: list[dict[str, object]] = []

        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, *, headers=None, json=None):
            self.calls.append({"url": url, "headers": headers, "json": json})
            return FakeCloudResponse()

    monkeypatch.setattr("app.services.whatsapp_shared_runtime.httpx.AsyncClient", FakeCloudClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-cloud-read-relay",
                "provider_token": "wa-access-token",
                "config": {"phone_number_id": "phone-cloud"},
            },
        )
    ).json()
    await db_session.rollback()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=account.user_id,
        external_chat_id="15551114444@s.whatsapp.net",
        external_chat_type="private",
        external_chat_name="Alice",
    )
    db_session.add(binding)
    await db_session.commit()

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    runtime = WhatsAppClawdiOutboxSharedBotRuntime(
        sessionmaker,
        account_id=account.id,
    )
    relayed = await runtime.relay_raw_node(
        {
            "tag": "receipt",
            "attrs": {
                "type": "read",
                "to": "15551114444@s.whatsapp.net",
                "id": "wamid.root",
            },
            "content": [
                {
                    "tag": "list",
                    "attrs": {},
                    "content": [{"tag": "item", "attrs": {"id": "wamid.extra"}}],
                }
            ],
        },
        lambda _message_id: None,
    )

    assert relayed.outcome == "relayed"
    assert [call["json"] for call in FakeCloudClient.calls] == [
        {
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": "wamid.root",
        },
        {
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": "wamid.extra",
        },
    ]
    assert FakeCloudClient.calls[0]["url"].endswith("/phone-cloud/messages")
    assert FakeCloudClient.calls[0]["headers"]["Authorization"] == "Bearer wa-access-token"

    await db_session.rollback()
    result = await db_session.execute(
        select(ChannelDebugEvent)
        .where(ChannelDebugEvent.account_id == account.id)
        .order_by(ChannelDebugEvent.created_at.asc(), ChannelDebugEvent.id.asc())
    )
    event = result.scalar_one()
    assert event.stage == "outbound_relay"
    assert event.outcome == "relayed"
    assert event.details["cloudTransport"] == "relayed"
    assert event.details["cloudPayloadKind"] == "receipt_read"
    assert event.details["cloudPayloadCount"] == 2


@pytest.mark.asyncio
async def test_whatsapp_shared_runtime_relays_typing_indicator_via_cloud_api(
    client,
    db_session,
    monkeypatch,
):
    class FakeCloudResponse:
        status_code = 200

    class FakeCloudClient:
        calls: list[dict[str, object]] = []

        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, *, headers=None, json=None):
            self.calls.append({"url": url, "headers": headers, "json": json})
            return FakeCloudResponse()

    monkeypatch.setattr("app.services.whatsapp_shared_runtime.httpx.AsyncClient", FakeCloudClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-cloud-typing-relay",
                "provider_token": "wa-access-token",
                "config": {"phone_number_id": "phone-cloud"},
            },
        )
    ).json()
    await db_session.rollback()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=account.user_id,
        external_chat_id="15551114444@s.whatsapp.net",
        external_chat_type="private",
        external_chat_name="Alice",
    )
    db_session.add(binding)
    await db_session.flush()
    db_session.add(
        ChannelMessage(
            account_id=account.id,
            bot_agent_link_id=UUID(created["agent_link_id"]),
            binding_id=binding.id,
            user_id=account.user_id,
            direction=MESSAGE_DIRECTION_INBOUND,
            external_chat_id=binding.external_chat_id,
            provider_message_id="wamid.latest",
            text="incoming",
            payload={"message": {"conversation": "incoming"}},
        )
    )
    await db_session.commit()

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    runtime = WhatsAppClawdiOutboxSharedBotRuntime(
        sessionmaker,
        account_id=account.id,
    )
    relayed = await runtime.relay_raw_node(
        {
            "tag": "chatstate",
            "attrs": {"to": "15551114444@s.whatsapp.net"},
            "content": [{"tag": "composing", "attrs": {}}],
        },
        lambda _message_id: None,
    )

    assert relayed.outcome == "relayed"
    assert FakeCloudClient.calls[0]["json"] == {
        "messaging_product": "whatsapp",
        "status": "read",
        "message_id": "wamid.latest",
        "typing_indicator": {"type": "text"},
    }
    assert FakeCloudClient.calls[0]["url"].endswith("/phone-cloud/messages")

    await db_session.rollback()
    result = await db_session.execute(
        select(ChannelDebugEvent)
        .where(ChannelDebugEvent.account_id == account.id)
        .order_by(ChannelDebugEvent.created_at.asc(), ChannelDebugEvent.id.asc())
    )
    event = result.scalar_one()
    assert event.stage == "outbound_relay"
    assert event.outcome == "relayed"
    assert event.details["cloudTransport"] == "relayed"
    assert event.details["cloudPayloadKind"] == "typing_indicator"


@pytest.mark.asyncio
async def test_whatsapp_shared_runtime_forward_iq_caps_inflight_queries(db_session):
    class SlowTransport:
        def __init__(self):
            self.started = 0
            self.started_event = asyncio.Event()
            self.release_event = asyncio.Event()

        async def relay_raw_node(self, node):
            raise AssertionError("raw relay should not be used")

        async def query_iq(self, node, timeout_ms):
            self.started += 1
            if self.started == 5:
                self.started_event.set()
            await self.release_event.wait()
            return {"tag": "iq", "attrs": {"type": "result"}}

    transport = SlowTransport()
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    runtime = WhatsAppClawdiOutboxSharedBotRuntime(
        sessionmaker,
        account_id=UUID("00000000-0000-0000-0000-000000000001"),
        transport=transport,
    )
    node = {"tag": "iq", "attrs": {"id": "q", "xmlns": "w", "type": "get"}}

    tasks = [asyncio.create_task(runtime.forward_iq(node, None)) for _ in range(5)]
    await asyncio.wait_for(transport.started_event.wait(), timeout=1)

    capped = await runtime.forward_iq(node, None)
    assert capped is None

    transport.release_event.set()
    assert [response is not None for response in await asyncio.gather(*tasks)] == [
        True,
        True,
        True,
        True,
        True,
    ]


@pytest.mark.asyncio
async def test_whatsapp_baileys_websocket_records_noise_runtime_debug_events(
    client,
    db_session,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-runtime-debug"},
        )
    ).json()
    minted = (
        await client.post(
            f"/v1/channels/whatsapp/{created['id']}/tenant-creds",
            json={
                "self_identity": {
                    "id": "16693773518:2@s.whatsapp.net",
                    "lid": "117901482786828:2@lid",
                },
            },
        )
    ).json()
    creds = decode_buffer_json(minted["creds"])
    static = KeyPair(
        private=creds["noiseKey"]["private"],
        public=creds["noiseKey"]["public"],
    )
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=UUID(minted["agent_link_id"]),
        user_id=account.user_id,
        external_chat_id="15551112222@s.whatsapp.net",
        external_chat_type="private",
        external_chat_name="Alice",
    )
    db_session.add(binding)
    await db_session.flush()
    inbox_message = ChannelMessage(
        account_id=account.id,
        bot_agent_link_id=UUID(minted["agent_link_id"]),
        binding_id=binding.id,
        user_id=account.user_id,
        direction=MESSAGE_DIRECTION_INBOUND,
        external_chat_id=binding.external_chat_id,
        provider_message_id="push-1",
        text="hello from provider",
        payload={
            "key": {"remoteJid": binding.external_chat_id, "id": "push-1"},
            "message": {"conversation": "hello from provider"},
        },
    )
    db_session.add(inbox_message)
    await db_session.commit()

    client_noise = _MiniNoiseClient(static=static)
    websocket, route_task = await _connect_whatsapp_route(
        account_id=UUID(created["id"]),
        client_noise=client_noise,
    )

    assert client_noise.transport is not None
    assert websocket.accepted is True
    bootstrap_frames = websocket.sent[1:3]
    success_ciphertext, _rest = unpack_frame(bootstrap_frames[0]) or (b"", b"")
    success = decode_binary_node_minimal(client_noise.transport.decrypt(success_ciphertext))
    assert success["tag"] == "success"
    assert success["attrs"]["lid"] == "16693773518:2@s.whatsapp.net"
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
    active_credential = await db_session.get(ChannelAgentCredential, UUID(minted["credential_id"]))
    assert active_credential is not None
    snapshots = whatsapp_signal_senders_from_config(active_credential.config)
    reply_sender = SignalSender(snapshots["15551112222:0@s.whatsapp.net"])
    reply_proto = _bytes_field(1, b"agent websocket reply")
    reply = reply_sender.encrypt_from_established_session("16693773518", 2, reply_proto)
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
    credential = await db_session.get(ChannelAgentCredential, UUID(minted["credential_id"]))
    assert credential is not None
    assert credential.config is not None
    assert credential.config["agent_bundle"]["registrationId"] == 12345
    assert len(credential.config["agent_bundle"]["preKeys"]) == 1
    assert "15551112222:0@s.whatsapp.net" in credential.config["signal_senders"]

    reconnect_noise = _MiniNoiseClient(static=static)
    reconnect_websocket, reconnect_task = await _connect_whatsapp_route(
        account_id=UUID(created["id"]),
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
    assert bootstrap.external_chat_id == "16693773518:2@s.whatsapp.net"
    assert bootstrap.details["runtime"] == "baileys_websocket"
    assert bootstrap.details["jidDescription"] == "server=s.whatsapp.net device=true"
    assert minted["identity_pub_key_hex"] not in repr([event.details for event in events])
    tenant_event = next(event for event in events if event.stage == "tenant_resolution")
    assert (
        tenant_event.details["clientStaticSha256"]
        == hashlib.sha256(bytes.fromhex(minted["identity_pub_key_hex"])).hexdigest()
    )
    restored_event = next(
        event for event in events if event.stage == "agent_bundle" and event.outcome == "restored"
    )
    assert restored_event.details["preCount"] == 1
    signal_state_event = next(
        event for event in events if event.stage == "signal_state" and event.outcome == "restored"
    )
    assert signal_state_event.details["senderCount"] == 1


@pytest.mark.asyncio
async def test_whatsapp_baileys_websocket_uses_registered_native_transport_for_relay_attrs(
    client,
    db_session,
):
    class FakeNativeTransport:
        def __init__(self):
            self.outbound_messages: list[WhatsAppOutboundMessage] = []

        async def relay_outbound_message(self, message):
            self.outbound_messages.append(message)

        async def relay_raw_node(self, node):
            raise AssertionError("raw relay should not be used")

        async def query_iq(self, node, timeout_ms):
            raise AssertionError("iq forwarding should not be used")

    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-route-native-registry"},
        )
    ).json()
    minted = (
        await client.post(
            f"/v1/channels/whatsapp/{created['id']}/tenant-creds",
            json={
                "self_identity": {
                    "id": "16693773518:2@s.whatsapp.net",
                    "lid": "117901482786828:2@lid",
                },
            },
        )
    ).json()
    creds = decode_buffer_json(minted["creds"])
    static = KeyPair(
        private=creds["noiseKey"]["private"],
        public=creds["noiseKey"]["public"],
    )
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=UUID(minted["agent_link_id"]),
        user_id=account.user_id,
        external_chat_id="15551113333@s.whatsapp.net",
        external_chat_type="private",
        external_chat_name="Alice",
    )
    db_session.add(binding)
    await db_session.flush()
    db_session.add(
        ChannelMessage(
            account_id=account.id,
            bot_agent_link_id=UUID(minted["agent_link_id"]),
            binding_id=binding.id,
            user_id=account.user_id,
            direction=MESSAGE_DIRECTION_INBOUND,
            external_chat_id=binding.external_chat_id,
            provider_message_id="native-push-1",
            text="seed signal session",
            payload={
                "key": {"remoteJid": binding.external_chat_id, "id": "native-push-1"},
                "message": {"conversation": "seed signal session"},
            },
        )
    )
    await db_session.commit()

    transport = FakeNativeTransport()
    account_id = UUID(created["id"])
    register_whatsapp_shared_bot_transport(account_id, transport)
    websocket: _BinaryWebSocketProbe | None = None
    route_task: asyncio.Task[None] | None = None
    try:
        client_noise = _MiniNoiseClient(static=static)
        websocket, route_task = await _connect_whatsapp_route(
            account_id=account_id,
            client_noise=client_noise,
        )
        assert client_noise.transport is not None
        websocket.inbound.put_nowait(
            pack_frame(client_noise.transport.encrypt(_agent_bundle_upload_node("upload-native")))
        )
        await websocket.wait_for_sent(5)

        await db_session.rollback()
        credential = await db_session.get(ChannelAgentCredential, UUID(minted["credential_id"]))
        assert credential is not None
        snapshots = whatsapp_signal_senders_from_config(credential.config)
        reply_sender = SignalSender(snapshots["15551113333:0@s.whatsapp.net"])
        reply_proto = _bytes_field(1, b"edited text")
        reply = reply_sender.encrypt_from_established_session("16693773518", 2, reply_proto)
        reply_node = encode_binary_node_minimal(
            {
                "tag": "message",
                "attrs": {
                    "id": "agent-native-edit-1",
                    "to": "15551113333@s.whatsapp.net",
                    "edit": "8",
                    "addressing_mode": "lid",
                },
                "content": [
                    {
                        "tag": "enc",
                        "attrs": {"type": reply.type},
                        "content": reply.ciphertext,
                    }
                ],
            }
        )
        websocket.inbound.put_nowait(pack_frame(client_noise.transport.encrypt(reply_node)))
        await websocket.wait_for_sent(6)
        for _ in range(50):
            if transport.outbound_messages:
                break
            await asyncio.sleep(0.01)

        assert len(transport.outbound_messages) == 1
        relayed = transport.outbound_messages[0]
        assert relayed.message_id == "agent-native-edit-1"
        assert relayed.attrs["edit"] == "8"
        assert relayed.attrs["addressing_mode"] == "lid"

        await db_session.rollback()
        result = await db_session.execute(
            select(ChannelDebugEvent)
            .where(ChannelDebugEvent.account_id == account_id)
            .order_by(ChannelDebugEvent.created_at.asc(), ChannelDebugEvent.id.asc())
        )
        events = list(result.scalars().all())
        native_event = next(
            event
            for event in events
            if event.stage == "outbound_delivery" and event.outcome == "relayed"
        )
        assert native_event.details["reason"] == "baileys-relay-attrs-required"
        assert native_event.details["nativeTransport"] == "relayed"
    finally:
        unregister_whatsapp_shared_bot_transport(account_id)
        if websocket is not None and route_task is not None and not route_task.done():
            await _disconnect_whatsapp_route(websocket, route_task)


async def _connect_whatsapp_route(
    *,
    account_id: UUID,
    client_noise: _MiniNoiseClient,
) -> tuple[_BinaryWebSocketProbe, asyncio.Task[None]]:
    websocket = _BinaryWebSocketProbe()
    route_task = asyncio.create_task(whatsapp_baileys_agent_websocket(websocket, account_id))
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
    def __init__(self) -> None:
        self.inbound: asyncio.Queue[bytes | WebSocketDisconnect] = asyncio.Queue()
        self.sent: list[bytes] = []
        self.accepted = False
        self.closed: list[int] = []
        self._sent = asyncio.Event()

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

    async def wait_for_sent(self, count: int) -> None:
        while len(self.sent) < count:
            self._sent.clear()
            await asyncio.wait_for(self._sent.wait(), timeout=1)


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
