from __future__ import annotations

import hashlib
import inspect
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.services.whatsapp_baileys import (
    AgentBundle,
    BinaryNode,
    EncryptedSignalEnvelope,
    GroupCipherBackend,
    SenderKeyRecordSnapshot,
    SignalSender,
    SignalSenderSnapshot,
    WhatsAppAuthCert,
    WhatsAppSyntheticDeliveryResult,
    parse_agent_bundle,
    parse_whatsapp_jid,
    respond_to_iq,
)
from app.services.whatsapp_runtime_types import WhatsAppOutboundMessage
from app.services.whatsapp_wabinary_tokens import (
    DOUBLE_BYTE_TOKEN_MAP,
    SINGLE_BYTE_TOKEN_MAP,
)

NOISE_MODE = b"Noise_XX_25519_AESGCM_SHA256\0\0\0\0"
NOISE_WA_HEADER = bytes([87, 65, 6, 3])
IV_LENGTH = 12
GCM_TAG_LENGTH = 16


@dataclass(frozen=True)
class KeyPair:
    private: bytes
    public: bytes


@dataclass(frozen=True)
class ServerHello:
    ephemeral: bytes
    static: bytes
    payload: bytes


@dataclass(frozen=True)
class ClientHello:
    ephemeral: bytes


@dataclass(frozen=True)
class ClientFinish:
    static: bytes
    payload: bytes


@dataclass(frozen=True)
class HandshakeMessage:
    client_hello: ClientHello | None = None
    server_hello: ServerHello | None = None
    client_finish: ClientFinish | None = None


@dataclass(frozen=True)
class HandshakeAccepted:
    server_hello: bytes


@dataclass(frozen=True)
class HandshakeCompleted:
    client_payload: bytes
    client_static_public: bytes


@dataclass(frozen=True)
class WhatsAppNoiseTenant:
    tenant_id: str | None = None
    lid: str | None = None
    pre_key_count: int = 0
    credential_id: str | None = None
    bot_agent_link_id: str | None = None
    bundle: AgentBundle | None = None
    signal_senders: dict[str, SignalSenderSnapshot] | None = None
    group_sender_keys: dict[str, SenderKeyRecordSnapshot] | None = None


@dataclass(frozen=True)
class WhatsAppNoiseRuntimeEvent:
    stage: str
    outcome: str
    details: dict[str, Any]
    tenant_id: str | None = None
    external_chat_id: str | None = None


WhatsAppNoiseRuntimeEventCallback = Callable[
    [WhatsAppNoiseRuntimeEvent],
    Awaitable[None] | None,
]
WhatsAppOutboundMessageCallback = Callable[
    [WhatsAppOutboundMessage],
    Awaitable[None] | None,
]
WhatsAppOutboundRelayCallback = Callable[
    [BinaryNode, Callable[[str], str | None]],
    Awaitable[None] | None,
]
WhatsAppForwardIqCallback = Callable[
    [BinaryNode, str | None],
    Awaitable[BinaryNode | None] | BinaryNode | None,
]


class TransportState:
    def __init__(self, *, enc_key: bytes, dec_key: bytes) -> None:
        self._enc_key = enc_key
        self._dec_key = dec_key
        self._read_counter = 0
        self._write_counter = 0

    def encrypt(self, plaintext: bytes) -> bytes:
        ciphertext = AESGCM(self._enc_key).encrypt(_iv(self._write_counter), plaintext, b"")
        self._write_counter += 1
        return ciphertext

    def decrypt(self, ciphertext: bytes) -> bytes:
        plaintext = AESGCM(self._dec_key).decrypt(_iv(self._read_counter), ciphertext, b"")
        self._read_counter += 1
        return plaintext


class NoiseServer:
    def __init__(
        self,
        *,
        auth_cert: WhatsAppAuthCert,
        static_key_pair: KeyPair | None = None,
    ) -> None:
        self._auth_cert = auth_cert
        self.static_key_pair = static_key_pair or generate_key_pair()
        h = NOISE_MODE if len(NOISE_MODE) == 32 else hashlib.sha256(NOISE_MODE).digest()
        self._hash = h
        self._salt = h
        self._enc_key = h
        self._dec_key = h
        self._counter = 0
        self._transport: TransportState | None = None
        self._client_ephemeral_public: bytes | None = None
        self._server_ephemeral: KeyPair | None = None

    def init(self) -> None:
        self._authenticate(NOISE_WA_HEADER)

    async def handle_client_hello(self, frame: bytes) -> HandshakeAccepted:
        message = decode_handshake_message(frame)
        if message.client_hello is None or len(message.client_hello.ephemeral) != 32:
            raise ValueError("noise-server: missing or invalid clientHello.ephemeral")
        self._client_ephemeral_public = message.client_hello.ephemeral
        self._authenticate(self._client_ephemeral_public)

        self._server_ephemeral = generate_key_pair()
        self._authenticate(self._server_ephemeral.public)
        self._mix_into_key(
            _shared_key(self._server_ephemeral.private, self._client_ephemeral_public)
        )

        encrypted_static = self._handshake_encrypt(self.static_key_pair.public)
        self._mix_into_key(_shared_key(self.static_key_pair.private, self._client_ephemeral_public))

        cert_chain = encode_cert_chain(self._auth_cert, self.static_key_pair.public)
        encrypted_payload = self._handshake_encrypt(cert_chain)
        return HandshakeAccepted(
            server_hello=encode_handshake_message(
                HandshakeMessage(
                    server_hello=ServerHello(
                        ephemeral=self._server_ephemeral.public,
                        static=encrypted_static,
                        payload=encrypted_payload,
                    )
                )
            )
        )

    async def handle_client_finish(self, frame: bytes) -> HandshakeCompleted:
        if self._server_ephemeral is None:
            raise ValueError("noise-server: handleClientFinish called before handleClientHello")
        message = decode_handshake_message(frame)
        if message.client_finish is None:
            raise ValueError("noise-server: missing clientFinish fields")
        client_static_public = self._handshake_decrypt(message.client_finish.static)
        self._mix_into_key(_shared_key(self._server_ephemeral.private, client_static_public))
        client_payload = self._handshake_decrypt(message.client_finish.payload)
        self._finish_init()
        return HandshakeCompleted(
            client_payload=client_payload,
            client_static_public=client_static_public,
        )

    def encrypt_frame(self, plaintext: bytes) -> bytes:
        if self._transport is None:
            raise ValueError("noise-server: not in transport state")
        return pack_frame(self._transport.encrypt(plaintext))

    def decrypt_frame(self, ciphertext: bytes) -> bytes:
        if self._transport is None:
            raise ValueError("noise-server: not in transport state")
        return self._transport.decrypt(ciphertext)

    def is_transport(self) -> bool:
        return self._transport is not None

    def _authenticate(self, data: bytes) -> None:
        if self._transport is None:
            self._hash = hashlib.sha256(self._hash + data).digest()

    def _handshake_encrypt(self, plaintext: bytes) -> bytes:
        ciphertext = AESGCM(self._enc_key).encrypt(_iv(self._counter), plaintext, self._hash)
        self._counter += 1
        self._authenticate(ciphertext)
        return ciphertext

    def _handshake_decrypt(self, ciphertext: bytes) -> bytes:
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
        client_write_key = key[:32]
        server_write_key = key[32:]
        self._transport = TransportState(enc_key=server_write_key, dec_key=client_write_key)


def generate_key_pair() -> KeyPair:
    private = x25519.X25519PrivateKey.generate()
    public = private.public_key()
    return KeyPair(
        private=private.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        ),
        public=public.public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        ),
    )


def pack_frame(data: bytes) -> bytes:
    length = len(data)
    return bytes([(length >> 16) & 0xFF, (length >> 8) & 0xFF, length & 0xFF]) + data


def unpack_frame(data: bytes) -> tuple[bytes, bytes] | None:
    if len(data) < 3:
        return None
    length = (data[0] << 16) | (data[1] << 8) | data[2]
    if len(data) < length + 3:
        return None
    return data[3 : 3 + length], data[3 + length :]


def encode_handshake_message(message: HandshakeMessage) -> bytes:
    fields: list[bytes] = []
    if message.client_hello is not None:
        payload = _bytes_field(1, message.client_hello.ephemeral)
        fields.append(_message_field(2, payload))
    if message.server_hello is not None:
        payload = (
            _bytes_field(1, message.server_hello.ephemeral)
            + _bytes_field(2, message.server_hello.static)
            + _bytes_field(3, message.server_hello.payload)
        )
        fields.append(_message_field(3, payload))
    if message.client_finish is not None:
        payload = _bytes_field(1, message.client_finish.static) + _bytes_field(
            2,
            message.client_finish.payload,
        )
        fields.append(_message_field(4, payload))
    return b"".join(fields)


def decode_handshake_message(data: bytes) -> HandshakeMessage:
    client_hello: ClientHello | None = None
    server_hello: ServerHello | None = None
    client_finish: ClientFinish | None = None
    for field, wire_type, value in _read_fields(data):
        if wire_type != 2 or not isinstance(value, bytes):
            continue
        nested = {
            nested_field: nested_value for nested_field, _, nested_value in _read_fields(value)
        }
        if field == 2:
            ephemeral = nested.get(1)
            client_hello = ClientHello(ephemeral=ephemeral if isinstance(ephemeral, bytes) else b"")
        elif field == 3:
            ephemeral = nested.get(1)
            static = nested.get(2)
            payload = nested.get(3)
            server_hello = ServerHello(
                ephemeral=ephemeral if isinstance(ephemeral, bytes) else b"",
                static=static if isinstance(static, bytes) else b"",
                payload=payload if isinstance(payload, bytes) else b"",
            )
        elif field == 4:
            static = nested.get(1)
            payload = nested.get(2)
            client_finish = ClientFinish(
                static=static if isinstance(static, bytes) else b"",
                payload=payload if isinstance(payload, bytes) else b"",
            )
    return HandshakeMessage(
        client_hello=client_hello,
        server_hello=server_hello,
        client_finish=client_finish,
    )


def encode_cert_chain(cert: WhatsAppAuthCert, static_public_key: bytes) -> bytes:
    serial = cert.serial
    intermediate_details = _cert_details(
        serial=serial,
        issuer_serial=serial,
        key=cert.intermediate_public_key,
    )
    leaf_details = _cert_details(
        serial=serial,
        issuer_serial=serial,
        key=static_public_key,
    )
    intermediate = _message_field(1, intermediate_details) + _bytes_field(2, b"\0" * 64)
    leaf = _message_field(1, leaf_details) + _bytes_field(2, b"\0" * 64)
    return _message_field(1, leaf) + _message_field(2, intermediate)


def encode_binary_node_minimal(node: dict[str, object]) -> bytes:
    out = bytearray([0])
    _write_binary_node(node, out)
    return bytes(out)


def decode_binary_node_minimal(data: bytes) -> BinaryNode:
    decoder = _BinaryNodeDecoder(data)
    return decoder.decode()


class WhatsAppNoiseEmulatorSession:
    def __init__(
        self,
        *,
        auth_cert: WhatsAppAuthCert,
        lid: str,
        pre_key_count: int = 0,
        backlog_count: int = 0,
        resolve_client: Callable[[bytes], Awaitable[WhatsAppNoiseTenant | None]] | None = None,
        on_event: WhatsAppNoiseRuntimeEventCallback | None = None,
        on_outbound_message: WhatsAppOutboundMessageCallback | None = None,
        on_outbound_relay: WhatsAppOutboundRelayCallback | None = None,
        forward_iq: WhatsAppForwardIqCallback | None = None,
    ) -> None:
        self._noise = NoiseServer(auth_cert=auth_cert)
        self._noise.init()
        self._lid = lid
        self._pre_key_count = pre_key_count
        self._backlog_count = backlog_count
        self._resolve_client = resolve_client
        self._on_event = on_event
        self._on_outbound_message = on_outbound_message
        self._on_outbound_relay = on_outbound_relay
        self._forward_iq = forward_iq
        self._buffer = b""
        self._intro_consumed = False
        self._hello_handled = False
        self._transport_started = False
        self.client_static_public: bytes | None = None
        self.tenant: WhatsAppNoiseTenant | None = None
        self.bundle: AgentBundle | None = None
        self.rejected = False
        self._signal_senders: dict[str, SignalSender] = {}
        self._group_cipher = GroupCipherBackend()
        self._agent_user, self._agent_device = _signal_identity_from_jid(lid)
        self._inbound_sender_by_message_id: dict[str, str] = {}

    async def handle_inbound(self, chunk: bytes) -> list[bytes]:
        self._buffer += chunk
        out: list[bytes] = []
        if not self._intro_consumed:
            if not await self._consume_intro():
                return out
        while True:
            unpacked = unpack_frame(self._buffer)
            if unpacked is None:
                break
            frame, self._buffer = unpacked
            out.extend(await self._dispatch_frame(frame))
        return out

    async def _consume_intro(self) -> bool:
        noise_offset = 0
        routing_info_length = 0
        if len(self._buffer) >= 2 and self._buffer[:2] == b"ED":
            if len(self._buffer) < 7:
                return False
            routing_info_length = (self._buffer[4] << 16) | (self._buffer[5] << 8) | self._buffer[6]
            noise_offset = 7 + routing_info_length
        end = noise_offset + len(NOISE_WA_HEADER)
        if len(self._buffer) < end:
            return False
        if self._buffer[noise_offset:end] != NOISE_WA_HEADER:
            await self._emit_event(
                "noise_intro",
                "failure",
                {"receivedBytes": len(self._buffer), "routingInfoBytes": routing_info_length},
            )
            raise ValueError("whatsapp-emulator: expected Noise WA header")
        self._buffer = self._buffer[end:]
        self._intro_consumed = True
        await self._emit_event(
            "noise_intro",
            "received",
            {"receivedBytes": end, "routingInfoBytes": routing_info_length},
        )
        return True

    async def _dispatch_frame(self, frame: bytes) -> list[bytes]:
        if not self._transport_started:
            if not self._hello_handled:
                try:
                    accepted = await self._noise.handle_client_hello(frame)
                except Exception as exc:
                    await self._emit_event(
                        "noise_client_hello",
                        "failure",
                        {"frameBytes": len(frame), "errorType": exc.__class__.__name__},
                    )
                    raise
                self._hello_handled = True
                await self._emit_event(
                    "noise_client_hello",
                    "accepted",
                    {"frameBytes": len(frame), "serverHelloBytes": len(accepted.server_hello)},
                )
                return [pack_frame(accepted.server_hello)]

            try:
                completed = await self._noise.handle_client_finish(frame)
            except Exception as exc:
                await self._emit_event(
                    "noise_client_finish",
                    "failure",
                    {"frameBytes": len(frame), "errorType": exc.__class__.__name__},
                )
                raise
            self.client_static_public = completed.client_static_public
            client_static_sha256 = hashlib.sha256(completed.client_static_public).hexdigest()
            if self._resolve_client is not None:
                self.tenant = await self._resolve_client(completed.client_static_public)
                if self.tenant is None:
                    self.rejected = True
                    await self._emit_event(
                        "tenant_resolution",
                        "rejected",
                        {"clientStaticSha256": client_static_sha256},
                    )
                    return [
                        self._noise.encrypt_frame(
                            encode_binary_node_minimal(
                                {"tag": "stream:error", "attrs": {"code": "401"}}
                            )
                        )
                    ]
                if self.tenant.lid:
                    self._lid = self.tenant.lid
                    self._agent_user, self._agent_device = _signal_identity_from_jid(self._lid)
                self._pre_key_count = self.tenant.pre_key_count
                if self.tenant.bundle is not None:
                    self.bundle = self.tenant.bundle
                    await self._emit_event(
                        "agent_bundle",
                        "restored",
                        {
                            "registrationId": self.bundle.registration_id,
                            "signedPreKeyId": self.bundle.signed_pre_key.id,
                            "preKeyCount": len(self.bundle.pre_keys),
                        },
                        tenant_id=self.tenant.tenant_id,
                        external_chat_id=self._lid,
                    )
                if self.tenant.signal_senders:
                    self._signal_senders = {
                        key: SignalSender(snapshot)
                        for key, snapshot in self.tenant.signal_senders.items()
                    }
                    await self._emit_event(
                        "signal_state",
                        "restored",
                        {"senderCount": len(self._signal_senders)},
                        tenant_id=self.tenant.tenant_id,
                        external_chat_id=self._lid,
                    )
                if self.tenant.group_sender_keys:
                    self._group_cipher.load_snapshot(self.tenant.group_sender_keys)
                    await self._emit_event(
                        "group_signal_state",
                        "restored",
                        {"senderKeyCount": len(self.tenant.group_sender_keys)},
                        tenant_id=self.tenant.tenant_id,
                        external_chat_id=self._lid,
                    )
            await self._emit_event(
                "tenant_resolution",
                "resolved",
                {
                    "clientStaticSha256": client_static_sha256,
                    "preKeyCount": self._pre_key_count,
                },
                tenant_id=self.tenant.tenant_id if self.tenant else None,
                external_chat_id=self._lid,
            )
            self._transport_started = True
            await self._emit_event(
                "bootstrap",
                "sent",
                {"preKeyCount": self._pre_key_count, "backlogCount": self._backlog_count},
                tenant_id=self.tenant.tenant_id if self.tenant else None,
                external_chat_id=self._lid,
            )
            return [
                self._noise.encrypt_frame(
                    encode_binary_node_minimal(
                        {
                            "tag": "success",
                            "attrs": {
                                "lid": self._lid,
                                "t": str(int(time.time())),
                                "platform": "s.whatsapp.net",
                                "locale": "en-US",
                            },
                        }
                    )
                ),
                self._noise.encrypt_frame(
                    encode_binary_node_minimal(
                        {"tag": "offline", "attrs": {"count": str(self._backlog_count)}}
                    )
                ),
            ]

        try:
            plaintext = self._noise.decrypt_frame(frame)
        except Exception as exc:
            await self._emit_event(
                "frame",
                "decrypt_failed",
                {"frameBytes": len(frame), "errorType": exc.__class__.__name__},
                tenant_id=self.tenant.tenant_id if self.tenant else None,
                external_chat_id=self._lid,
            )
            raise
        try:
            node = decode_binary_node_minimal(plaintext)
        except Exception as exc:
            await self._emit_event(
                "frame",
                "decode_failed",
                {
                    "frameBytes": len(frame),
                    "plainBytes": len(plaintext),
                    "errorType": exc.__class__.__name__,
                    "reason": _safe_error_reason(exc),
                },
                tenant_id=self.tenant.tenant_id if self.tenant else None,
                external_chat_id=self._lid,
            )
            raise
        if node.get("tag") == "message":
            outbound = await self._extract_outbound_message(node)
            if outbound is None:
                return []
            await self._emit_event(
                "outbound_message",
                "decoded",
                {
                    "id": outbound.message_id,
                    "encType": outbound.enc_type,
                    "protoBytes": len(outbound.message_proto),
                    "protoSha256": hashlib.sha256(outbound.message_proto).hexdigest(),
                    "conversationPresent": outbound.conversation is not None,
                    "children": _child_tags(node),
                },
                tenant_id=self.tenant.tenant_id if self.tenant else None,
                external_chat_id=outbound.to_jid,
            )
            await self._emit_outbound_message(outbound)
            return [
                self._noise.encrypt_frame(
                    encode_binary_node_minimal(
                        {
                            "tag": "ack",
                            "attrs": {
                                "id": outbound.message_id,
                                "to": outbound.to_jid,
                                "class": "message",
                            },
                        }
                    )
                )
            ]
        if node.get("tag") != "iq":
            await self._emit_event(
                "outbound_relay",
                "received",
                {"tag": str(node.get("tag") or ""), "frameBytes": len(frame)},
                tenant_id=self.tenant.tenant_id if self.tenant else None,
                external_chat_id=_attrs(node).get("to") or self._lid,
            )
            await self._emit_outbound_relay(node)
            return []
        attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
        children = _child_tags(node)
        if attrs.get("xmlns") == "encrypt" and attrs.get("type") == "set":
            try:
                self.bundle = parse_agent_bundle(node)
            except ValueError:
                await self._emit_event(
                    "agent_bundle",
                    "ignored",
                    {"reason": "not-prekey-bundle", "children": children},
                    tenant_id=self.tenant.tenant_id if self.tenant else None,
                    external_chat_id=self._lid,
                )
            else:
                self._pre_key_count = len(self.bundle.pre_keys)
                await self._emit_event(
                    "agent_bundle",
                    "captured",
                    {
                        "registrationId": self.bundle.registration_id,
                        "signedPreKeyId": self.bundle.signed_pre_key.id,
                        "preKeyCount": len(self.bundle.pre_keys),
                    },
                    tenant_id=self.tenant.tenant_id if self.tenant else None,
                    external_chat_id=self._lid,
                )
        try:
            response = await respond_to_iq(
                node,
                pre_key_count=self._pre_key_count,
                agent_user=self._agent_user,
                agent_lid=self._lid,
                tenant_id=self.tenant.tenant_id if self.tenant else None,
                resolve_recipient_bundle=self._resolve_recipient_bundle,
                forward_iq=self._forward_iq,
            )
        except Exception as exc:
            await self._emit_event(
                "iq",
                "failure",
                {
                    "id": str(attrs.get("id") or ""),
                    "xmlns": str(attrs.get("xmlns") or ""),
                    "type": str(attrs.get("type") or ""),
                    "children": children,
                    "errorType": exc.__class__.__name__,
                    "reason": _safe_error_reason(exc),
                },
                tenant_id=self.tenant.tenant_id if self.tenant else None,
                external_chat_id=self._lid,
            )
            raise
        await self._emit_event(
            "iq",
            "answered",
            {
                "id": str(attrs.get("id") or ""),
                "xmlns": str(attrs.get("xmlns") or ""),
                "type": str(attrs.get("type") or ""),
                "children": children,
            },
            tenant_id=self.tenant.tenant_id if self.tenant else None,
            external_chat_id=self._lid,
        )
        return [self._noise.encrypt_frame(encode_binary_node_minimal(response))]

    async def _extract_outbound_message(self, node: BinaryNode) -> WhatsAppOutboundMessage | None:
        attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
        message_id = str(attrs.get("id") or "")
        to_jid = str(attrs.get("to") or "")
        if not message_id or not to_jid:
            await self._emit_outbound_drop(
                reason="missing-address",
                node=node,
                to_jid=to_jid,
                message_id=message_id,
            )
            return None
        parsed = parse_whatsapp_jid(to_jid)
        if parsed is None:
            await self._emit_outbound_drop(
                reason="invalid-jid",
                node=node,
                to_jid=to_jid,
                message_id=message_id,
            )
            return None
        if parsed.server == "g.us":
            return await self._extract_outbound_group_message(node, to_jid, message_id)
        enc = _find_outbound_enc(node, [to_jid])
        if enc is None or not isinstance(enc.get("content"), bytes):
            await self._emit_outbound_drop(
                reason="missing-enc",
                node=node,
                to_jid=to_jid,
                message_id=message_id,
            )
            return None
        enc_attrs = enc.get("attrs") if isinstance(enc.get("attrs"), dict) else {}
        enc_type = enc_attrs.get("type")
        if enc_type not in {"pkmsg", "msg"}:
            await self._emit_outbound_drop(
                reason="unsupported-enc-type",
                node=node,
                to_jid=to_jid,
                message_id=message_id,
            )
            return None
        if self._agent_user is None:
            await self._emit_outbound_drop(
                reason="missing-agent-identity",
                node=node,
                to_jid=to_jid,
                message_id=message_id,
            )
            return None
        sender = self._signal_senders.get(_signal_sender_key(to_jid))
        if sender is None:
            await self._emit_outbound_drop(
                reason="missing-sender-session",
                node=node,
                to_jid=to_jid,
                message_id=message_id,
            )
            return None
        try:
            message_proto = sender.decrypt_from(
                self._agent_user,
                self._agent_device,
                EncryptedSignalEnvelope(
                    type=enc_type,
                    ciphertext=enc["content"],
                ),
            )
        except Exception:
            await self._emit_outbound_drop(
                reason="decrypt-failed",
                node=node,
                to_jid=to_jid,
                message_id=message_id,
            )
            return None
        return WhatsAppOutboundMessage(
            to_jid=to_jid,
            message_id=message_id,
            message_proto=message_proto,
            enc_type=enc_type,
            attrs={str(key): str(value) for key, value in attrs.items()},
            conversation=_proto_conversation_text(message_proto),
        )

    async def _extract_outbound_group_message(
        self,
        node: BinaryNode,
        group_jid: str,
        message_id: str,
    ) -> WhatsAppOutboundMessage | None:
        if self._agent_user is None:
            await self._emit_outbound_drop(
                reason="missing-agent-identity",
                node=node,
                to_jid=group_jid,
                message_id=message_id,
            )
            return None
        skmsg = _find_top_level_enc_by_type(node, "skmsg")
        if skmsg is None or not isinstance(skmsg.get("content"), bytes):
            await self._emit_outbound_drop(
                reason="missing-enc",
                node=node,
                to_jid=group_jid,
                message_id=message_id,
            )
            return None
        participants = next(
            (child for child in _children(node) if child.get("tag") == "participants"),
            None,
        )
        if participants is not None:
            processed = await self._process_group_sender_key_distribution(
                participants=participants,
                group_jid=group_jid,
                message_id=message_id,
                node=node,
            )
            if not processed:
                return None
        try:
            message_proto = self._group_cipher.decrypt_skmsg(
                group_jid=group_jid,
                author_user=self._agent_user,
                author_device=self._agent_device,
                ciphertext=skmsg["content"],
            )
        except Exception:
            await self._emit_outbound_drop(
                reason="skmsg-decrypt-failed",
                node=node,
                to_jid=group_jid,
                message_id=message_id,
            )
            return None
        attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
        return WhatsAppOutboundMessage(
            to_jid=group_jid,
            message_id=message_id,
            message_proto=message_proto,
            enc_type="skmsg",
            attrs={str(key): str(value) for key, value in attrs.items()},
            conversation=_proto_conversation_text(message_proto),
        )

    async def _process_group_sender_key_distribution(
        self,
        *,
        participants: BinaryNode,
        group_jid: str,
        message_id: str,
        node: BinaryNode,
    ) -> bool:
        for to_node in _children(participants):
            if to_node.get("tag") != "to":
                continue
            participant_jid = _attrs(to_node).get("jid")
            if participant_jid is None:
                continue
            sender = self._signal_senders.get(_signal_sender_key(participant_jid))
            if sender is None:
                continue
            enc = next((child for child in _children(to_node) if child.get("tag") == "enc"), None)
            if enc is None or not isinstance(enc.get("content"), bytes):
                continue
            enc_type = _attrs(enc).get("type")
            if enc_type not in {"pkmsg", "msg"}:
                continue
            try:
                skdm_proto = sender.decrypt_from(
                    self._agent_user or "",
                    self._agent_device,
                    EncryptedSignalEnvelope(type=enc_type, ciphertext=enc["content"]),
                )
                parsed = _parse_sender_key_distribution_message(skdm_proto)
            except Exception:
                continue
            if parsed is None:
                continue
            skdm_group_jid, axolotl_bytes = parsed
            self._group_cipher.process_skdm(
                group_jid=skdm_group_jid,
                author_user=self._agent_user or "",
                author_device=self._agent_device,
                axolotl_bytes=axolotl_bytes,
            )
            return True
        await self._emit_outbound_drop(
            reason="missing-sender-session",
            node=node,
            to_jid=group_jid,
            message_id=message_id,
        )
        return False

    async def _emit_outbound_drop(
        self,
        *,
        reason: str,
        node: BinaryNode,
        to_jid: str,
        message_id: str,
    ) -> None:
        await self._emit_event(
            "outbound_message",
            "dropped",
            {
                "reason": reason,
                "id": message_id,
                "children": _child_tags(node),
            },
            tenant_id=self.tenant.tenant_id if self.tenant else None,
            external_chat_id=to_jid or self._lid,
        )

    async def _emit_outbound_message(self, outbound: WhatsAppOutboundMessage) -> None:
        if self._on_outbound_message is None:
            return
        try:
            maybe_result = self._on_outbound_message(outbound)
            if inspect.isawaitable(maybe_result):
                await maybe_result
        except Exception as exc:  # noqa: BLE001 - outbound hook failures should not corrupt WA state.
            await self._emit_event(
                "outbound_message",
                "hook_error",
                {"id": outbound.message_id, "errorType": exc.__class__.__name__},
                tenant_id=self.tenant.tenant_id if self.tenant else None,
                external_chat_id=outbound.to_jid,
            )

    async def _emit_outbound_relay(self, node: BinaryNode) -> None:
        if self._on_outbound_relay is None:
            return
        try:
            maybe_result = self._on_outbound_relay(node, self.lookup_inbound_sender)
            if inspect.isawaitable(maybe_result):
                await maybe_result
        except Exception as exc:  # noqa: BLE001 - relay hook failures should not corrupt WA state.
            await self._emit_event(
                "outbound_relay",
                "hook_error",
                {"tag": str(node.get("tag") or ""), "errorType": exc.__class__.__name__},
                tenant_id=self.tenant.tenant_id if self.tenant else None,
                external_chat_id=_attrs(node).get("to") or self._lid,
            )

    def lookup_inbound_sender(self, message_id: str) -> str | None:
        return self._inbound_sender_by_message_id.get(message_id)

    def _record_inbound_sender(self, message_id: str, sender_jid: str) -> None:
        if message_id in self._inbound_sender_by_message_id:
            del self._inbound_sender_by_message_id[message_id]
        elif len(self._inbound_sender_by_message_id) >= 512:
            oldest = next(iter(self._inbound_sender_by_message_id), None)
            if oldest is not None:
                del self._inbound_sender_by_message_id[oldest]
        self._inbound_sender_by_message_id[message_id] = sender_jid

    async def _emit_event(
        self,
        stage: str,
        outcome: str,
        details: dict[str, Any],
        *,
        tenant_id: str | None = None,
        external_chat_id: str | None = None,
    ) -> None:
        if self._on_event is None:
            return
        maybe_result = self._on_event(
            WhatsAppNoiseRuntimeEvent(
                stage=stage,
                outcome=outcome,
                details=details,
                tenant_id=tenant_id,
                external_chat_id=external_chat_id,
            )
        )
        if inspect.isawaitable(maybe_result):
            await maybe_result

    def _resolve_recipient_bundle(self, jid: str) -> AgentBundle | None:
        if parse_whatsapp_jid(jid) is None:
            return None
        sender_key = _signal_sender_key(jid)
        sender = self._signal_senders.get(sender_key)
        if sender is None:
            sender = SignalSender()
            self._signal_senders[sender_key] = sender
        return sender.get_bundle()

    async def push_inbound_message(
        self,
        *,
        from_jid: str,
        message_id: str,
        message_proto: bytes,
        participant_jid: str | None = None,
        push_name: str | None = None,
        timestamp: int | None = None,
        sender_lid_jid: str | None = None,
        sender_pn_jid: str | None = None,
        participant_lid_jid: str | None = None,
        participant_pn_jid: str | None = None,
    ) -> tuple[bytes, WhatsAppSyntheticDeliveryResult]:
        if not self._transport_started:
            raise ValueError("whatsapp-emulator: push_inbound_message before transport start")
        if self.bundle is None:
            raise ValueError("whatsapp-emulator: no agent bundle captured")
        signal_jid = participant_jid or from_jid
        parsed = parse_whatsapp_jid(signal_jid)
        if parsed is None:
            raise ValueError(f"whatsapp-emulator: invalid sender jid {signal_jid}")
        sender_key = _signal_sender_key(signal_jid)
        sender = self._signal_senders.get(sender_key)
        if sender is None:
            sender = SignalSender()
            self._signal_senders[sender_key] = sender

        pre_key_count = len(self.bundle.pre_keys)
        envelope = sender.encrypt_for(
            parsed.user,
            parsed.device or 0,
            self.bundle,
            _pad_random_max16(message_proto),
        )
        if self._agent_user is not None:
            sender.mirror_session(
                parsed.user,
                parsed.device or 0,
                self._agent_user,
                self._agent_device,
            )
        if len(self.bundle.pre_keys) != pre_key_count:
            await self._emit_event(
                "agent_bundle",
                "updated",
                {
                    "registrationId": self.bundle.registration_id,
                    "signedPreKeyId": self.bundle.signed_pre_key.id,
                    "preKeyCount": len(self.bundle.pre_keys),
                },
                tenant_id=self.tenant.tenant_id if self.tenant else None,
                external_chat_id=self._lid,
            )

        attrs = _inbound_message_attrs(
            from_jid=from_jid,
            message_id=message_id,
            signal_jid=signal_jid,
            signal_server=parsed.server,
            participant_jid=participant_jid,
            push_name=push_name,
            timestamp=timestamp,
            sender_lid_jid=sender_lid_jid,
            sender_pn_jid=sender_pn_jid,
            participant_lid_jid=participant_lid_jid,
            participant_pn_jid=participant_pn_jid,
        )
        frame = self._noise.encrypt_frame(
            encode_binary_node_minimal(
                {
                    "tag": "message",
                    "attrs": attrs,
                    "content": [
                        {
                            "tag": "enc",
                            "attrs": {"v": "2", "type": envelope.type},
                            "content": envelope.ciphertext,
                        }
                    ],
                }
            )
        )
        await self._emit_event(
            "inbound_message",
            "pushed",
            {
                "id": message_id,
                "encType": envelope.type,
                "hasParticipant": participant_jid is not None,
            },
            tenant_id=self.tenant.tenant_id if self.tenant else None,
            external_chat_id=from_jid,
        )
        self._record_inbound_sender(message_id, participant_jid or from_jid)
        return frame, WhatsAppSyntheticDeliveryResult(
            message_id=message_id,
            signal_jid=signal_jid,
            enc_type=envelope.type,
            attrs=attrs,
        )

    def signal_sender_snapshots(self) -> dict[str, SignalSenderSnapshot]:
        return {
            key: sender.snapshot()
            for key, sender in sorted(self._signal_senders.items())
        }

    def group_sender_key_snapshots(self) -> dict[str, SenderKeyRecordSnapshot]:
        return self._group_cipher.snapshot()


def _child_tags(node: BinaryNode) -> list[str]:
    content = node.get("content")
    if not isinstance(content, list):
        return []
    return [
        str(child.get("tag"))
        for child in content
        if isinstance(child, dict) and child.get("tag") is not None
    ]


def _children(node: BinaryNode) -> list[BinaryNode]:
    content = node.get("content")
    if not isinstance(content, list):
        return []
    return [child for child in content if isinstance(child, dict)]


def _attrs(node: BinaryNode) -> dict[str, str]:
    attrs = node.get("attrs")
    if not isinstance(attrs, dict):
        return {}
    return {str(key): str(value) for key, value in attrs.items()}


def _safe_error_reason(exc: Exception) -> str:
    reason = str(exc).strip()
    if not reason:
        return exc.__class__.__name__
    return reason[:160]


def _has_child_tag(node: BinaryNode, tag: str) -> bool:
    for child in _children(node):
        if child.get("tag") == tag:
            return True
        if _has_child_tag(child, tag):
            return True
    return False


def _find_outbound_enc(node: BinaryNode, recipient_candidates: list[str]) -> BinaryNode | None:
    for child in _children(node):
        if child.get("tag") == "enc":
            return child
    candidates = set(recipient_candidates)
    for participants in _children(node):
        if participants.get("tag") != "participants":
            continue
        fallback: BinaryNode | None = None
        for to_node in _children(participants):
            if to_node.get("tag") != "to":
                continue
            to_attrs = _attrs(to_node)
            enc = next((child for child in _children(to_node) if child.get("tag") == "enc"), None)
            if enc is None:
                continue
            if to_attrs.get("jid") in candidates:
                return enc
            fallback = fallback or enc
        if fallback is not None:
            return fallback
    return None


def _find_top_level_enc_by_type(node: BinaryNode, enc_type: str) -> BinaryNode | None:
    for child in _children(node):
        if child.get("tag") != "enc":
            continue
        if _attrs(child).get("type") == enc_type:
            return child
    return None


def _signal_identity_from_jid(jid: str) -> tuple[str | None, int]:
    parsed = parse_whatsapp_jid(jid)
    if parsed is None:
        return None, 0
    return parsed.user, parsed.device or 0


def _signal_sender_key(jid: str) -> str:
    parsed = parse_whatsapp_jid(jid)
    if parsed is None:
        return jid
    return f"{parsed.user}:{parsed.device or 0}@{parsed.server}"


def _pad_random_max16(message_proto: bytes) -> bytes:
    pad_length = secrets.randbelow(16) + 1
    return message_proto + bytes([pad_length]) * pad_length


def _unpad_random_max16(message_proto: bytes) -> bytes:
    if not message_proto:
        raise ValueError("wabinary: empty padded message")
    pad_length = message_proto[-1]
    if pad_length < 1 or pad_length > min(16, len(message_proto)):
        raise ValueError("wabinary: invalid padded message")
    if message_proto[-pad_length:] != bytes([pad_length]) * pad_length:
        raise ValueError("wabinary: invalid padding bytes")
    return message_proto[:-pad_length]


def _proto_conversation_text(message_proto: bytes) -> str | None:
    with_padding_fallback = message_proto
    try:
        message_proto = _unpad_random_max16(message_proto)
    except ValueError:
        message_proto = with_padding_fallback
    try:
        fields = _read_fields(message_proto)
    except ValueError:
        return None
    for field_number, wire_type, value in fields:
        if field_number == 1 and wire_type == 2 and isinstance(value, bytes):
            try:
                return value.decode("utf-8")
            except UnicodeDecodeError:
                return None
        if field_number == 6 and wire_type == 2 and isinstance(value, bytes):
            text = _proto_conversation_text(value)
            if text is not None:
                return text
    return None


def _parse_sender_key_distribution_message(message_proto: bytes) -> tuple[str, bytes] | None:
    try:
        fields = _read_fields(message_proto)
    except ValueError:
        return None
    for field_number, wire_type, value in fields:
        if field_number != 2 or wire_type != 2 or not isinstance(value, bytes):
            continue
        try:
            skdm_fields = _read_fields(value)
        except ValueError:
            return None
        group_jid: str | None = None
        axolotl: bytes | None = None
        for nested_field, nested_wire_type, nested_value in skdm_fields:
            if nested_field == 1 and nested_wire_type == 2 and isinstance(nested_value, bytes):
                try:
                    group_jid = nested_value.decode("utf-8")
                except UnicodeDecodeError:
                    return None
            if nested_field == 2 and nested_wire_type == 2 and isinstance(nested_value, bytes):
                axolotl = nested_value
        if group_jid and axolotl:
            return group_jid, axolotl
    return None


def _inbound_message_attrs(
    *,
    from_jid: str,
    message_id: str,
    signal_jid: str,
    signal_server: str,
    participant_jid: str | None,
    push_name: str | None,
    timestamp: int | None,
    sender_lid_jid: str | None,
    sender_pn_jid: str | None,
    participant_lid_jid: str | None,
    participant_pn_jid: str | None,
) -> dict[str, str]:
    attrs = {
        "id": message_id,
        "from": from_jid,
        "t": str(timestamp if timestamp is not None else int(time.time())),
    }
    if participant_jid is not None:
        attrs["participant"] = participant_jid
    if push_name:
        attrs["notify"] = push_name
    peer_user = signal_jid.split("@", 1)[0].split(":", 1)[0]
    signal_is_lid = signal_server == "lid"
    if participant_jid is not None:
        if signal_is_lid:
            if participant_pn_jid:
                attrs["participant_pn"] = participant_pn_jid
            attrs["addressing_mode"] = "lid"
        else:
            attrs["participant_lid"] = participant_lid_jid or f"{peer_user}@lid"
            attrs["addressing_mode"] = "pn"
        return attrs
    if signal_is_lid:
        if sender_pn_jid:
            attrs["sender_pn"] = sender_pn_jid
        attrs["addressing_mode"] = "lid"
    else:
        attrs["sender_lid"] = sender_lid_jid or f"{peer_user}@lid"
        attrs["addressing_mode"] = "pn"
    return attrs


def _write_binary_node(node: dict[str, object], out: bytearray) -> None:
    tag = node.get("tag")
    attrs = node.get("attrs")
    content = node.get("content")
    if not isinstance(tag, str):
        raise ValueError("wabinary: node tag is required")
    attr_items = []
    if isinstance(attrs, dict):
        attr_items = [
            (str(key), str(value))
            for key, value in attrs.items()
            if value is not None and isinstance(value, (str, int, float, bool))
        ]
    list_size = 1 + 2 * len(attr_items) + (1 if content is not None else 0)
    _write_list_start(out, list_size)
    _write_string_raw(out, tag)
    for key, value in attr_items:
        _write_string_raw(out, key)
        _write_string_raw(out, value)
    if isinstance(content, str):
        _write_string_raw(out, content)
    elif isinstance(content, (bytes, bytearray)):
        _write_bytes(out, bytes(content))
    elif isinstance(content, list):
        valid_children = [item for item in content if isinstance(item, dict)]
        _write_list_start(out, len(valid_children))
        for child in valid_children:
            _write_binary_node(child, out)
    elif content is None:
        return
    else:
        raise ValueError("wabinary: unsupported node content")


def _cert_details(*, serial: int, issuer_serial: int, key: bytes) -> bytes:
    return _varint_field(1, serial) + _varint_field(2, issuer_serial) + _bytes_field(3, key)


def _iv(counter: int) -> bytes:
    return b"\0" * 8 + counter.to_bytes(4, byteorder="big", signed=False)


def _hkdf(data: bytes, *, salt: bytes, length: int) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(),
        length=length,
        salt=salt,
        info=b"",
    ).derive(data)


def _shared_key(private_key: bytes, public_key: bytes) -> bytes:
    private = x25519.X25519PrivateKey.from_private_bytes(private_key)
    public = x25519.X25519PublicKey.from_public_bytes(public_key)
    return private.exchange(public)


def _message_field(field_number: int, payload: bytes) -> bytes:
    return _key(field_number, 2) + _varint(len(payload)) + payload


def _bytes_field(field_number: int, payload: bytes) -> bytes:
    return _message_field(field_number, payload)


def _varint_field(field_number: int, value: int) -> bytes:
    return _key(field_number, 0) + _varint(value)


def _key(field_number: int, wire_type: int) -> bytes:
    return _varint((field_number << 3) | wire_type)


def _varint(value: int) -> bytes:
    out = bytearray()
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def _read_varint(data: bytes, offset: int) -> tuple[int, int]:
    shift = 0
    value = 0
    while offset < len(data):
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, offset
        shift += 7
    raise ValueError("protobuf: truncated varint")


def _read_fields(data: bytes) -> list[tuple[int, int, int | bytes]]:
    offset = 0
    fields: list[tuple[int, int, int | bytes]] = []
    while offset < len(data):
        key, offset = _read_varint(data, offset)
        field_number = key >> 3
        wire_type = key & 0x07
        if wire_type == 0:
            value, offset = _read_varint(data, offset)
            fields.append((field_number, wire_type, value))
        elif wire_type == 2:
            length, offset = _read_varint(data, offset)
            end = offset + length
            if end > len(data):
                raise ValueError("protobuf: truncated length-delimited field")
            fields.append((field_number, wire_type, data[offset:end]))
            offset = end
        else:
            raise ValueError(f"protobuf: unsupported wire type {wire_type}")
    return fields


def _write_list_start(out: bytearray, size: int) -> None:
    if size == 0:
        out.append(0)
    elif size < 256:
        out.extend([248, size])
    else:
        out.append(249)
        out.extend(size.to_bytes(2, "big"))


def _write_string_raw(out: bytearray, value: str) -> None:
    _write_bytes(out, value.encode("utf-8"))


def _write_bytes(out: bytearray, value: bytes) -> None:
    length = len(value)
    if length >= 1 << 20:
        out.append(254)
        out.extend(length.to_bytes(4, "big"))
    elif length >= 256:
        out.append(253)
        out.extend([(length >> 16) & 0x0F, (length >> 8) & 0xFF, length & 0xFF])
    else:
        out.extend([252, length])
    out.extend(value)


class _BinaryNodeDecoder:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._offset = 0

    def decode(self) -> BinaryNode:
        if self._read_byte() != 0:
            raise ValueError("wabinary: expected uncompressed frame")
        node = self._read_node()
        if not isinstance(node, dict):
            raise ValueError("wabinary: root node is not a dictionary")
        return node

    def _read_node(self) -> BinaryNode:
        list_size = self._read_list_size()
        if list_size == 0:
            raise ValueError("wabinary: empty node")
        tag = self._read_string()
        attrs: dict[str, str] = {}
        remaining = list_size - 1
        while remaining > 1:
            key = self._read_string()
            value = self._read_string()
            attrs[key] = value
            remaining -= 2
        node: BinaryNode = {"tag": tag, "attrs": attrs}
        if remaining == 1:
            node["content"] = self._read_content()
        return node

    def _read_content(self) -> Any:
        tag = self._peek_byte()
        if tag in {0, 248, 249}:
            count = self._read_list_size()
            return [self._read_node() for _ in range(count)]
        return self._read_string_or_bytes()

    def _read_string(self) -> str:
        value = self._read_string_or_bytes()
        if isinstance(value, bytes):
            return value.decode("utf-8")
        return value

    def _read_string_or_bytes(self) -> str | bytes:
        tag = self._read_byte()
        if tag == 0:
            return ""
        if tag == 252:
            length = self._read_byte()
            return self._read_bytes(length)
        if tag == 253:
            return self._read_bytes(self._read_int20())
        if tag == 254:
            length = int.from_bytes(self._read_bytes(4), "big")
            return self._read_bytes(length)
        if tag == 250:
            return self._read_jid_pair()
        if tag == 247:
            return self._read_ad_jid()
        if tag in {251, 255}:
            return self._read_packed8(tag)
        if 236 <= tag <= 239:
            index = self._read_byte()
            token = DOUBLE_BYTE_TOKEN_MAP.get((tag - 236, index))
            if token is not None:
                return token
            raise ValueError(
                f"wabinary: unsupported dictionary token {tag - 236}/{index}"
            )
        if 1 <= tag < 236:
            token = SINGLE_BYTE_TOKEN_MAP.get(tag)
            if token is not None:
                return token
            raise ValueError(f"wabinary: unsupported token {tag}")
        raise ValueError(f"wabinary: unsupported string tag {tag}")

    def _read_jid_pair(self) -> str:
        user = self._read_string()
        server = self._read_string()
        if not server:
            raise ValueError("wabinary: invalid jid pair")
        return f"{user}@{server}" if user else f"@{server}"

    def _read_ad_jid(self) -> str:
        domain_type = self._read_byte()
        device = self._read_byte()
        user = self._read_string()
        server = "s.whatsapp.net"
        if domain_type == 1:
            server = "lid"
        elif domain_type == 128:
            server = "hosted"
        elif domain_type == 129:
            server = "hosted.lid"
        return f"{user}:{device}@{server}" if device else f"{user}@{server}"

    def _read_packed8(self, tag: int) -> str:
        start = self._read_byte()
        length = start & 0x7F
        chars: list[str] = []
        for _ in range(length):
            value = self._read_byte()
            chars.append(_unpack_packed_nibble(tag, (value & 0xF0) >> 4))
            chars.append(_unpack_packed_nibble(tag, value & 0x0F))
        if start >> 7:
            chars.pop()
        return "".join(chars)

    def _read_int20(self) -> int:
        first = self._read_byte()
        second = self._read_byte()
        third = self._read_byte()
        return ((first & 0x0F) << 16) | (second << 8) | third

    def _read_list_size(self) -> int:
        tag = self._read_byte()
        if tag == 0:
            return 0
        if tag == 248:
            return self._read_byte()
        if tag == 249:
            return int.from_bytes(self._read_bytes(2), "big")
        raise ValueError(f"wabinary: unsupported list tag {tag}")

    def _peek_byte(self) -> int:
        if self._offset >= len(self._data):
            raise ValueError("wabinary: truncated input")
        return self._data[self._offset]

    def _read_byte(self) -> int:
        value = self._peek_byte()
        self._offset += 1
        return value

    def _read_bytes(self, length: int) -> bytes:
        end = self._offset + length
        if end > len(self._data):
            raise ValueError("wabinary: truncated bytes")
        value = self._data[self._offset : end]
        self._offset = end
        return value


def _unpack_packed_nibble(tag: int, value: int) -> str:
    if tag == 251:
        if 0 <= value <= 9:
            return chr(ord("0") + value)
        if 10 <= value <= 15:
            return chr(ord("A") + value - 10)
    if tag == 255:
        if 0 <= value <= 9:
            return chr(ord("0") + value)
        if value == 10:
            return "-"
        if value == 11:
            return "."
        if value == 15:
            return "\0"
    raise ValueError(f"wabinary: invalid packed value {value}")
