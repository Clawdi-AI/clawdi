from __future__ import annotations

import hashlib

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import JsonValue

from app.services.whatsapp_baileys import SenderKeyRecordSnapshot, WhatsAppAuthCert, buffer_json


def serialize_whatsapp_auth_cert(cert: WhatsAppAuthCert) -> dict[str, JsonValue]:
    return {
        "SERIAL": cert.serial,
        "ISSUER": cert.issuer,
        "PUBLIC_KEY": buffer_json(cert.root_public_key),
    }


def encrypt_whatsapp_group_message_for_sender_key(
    *,
    axolotl_bytes: bytes,
    plaintext: bytes,
) -> bytes:
    record: SenderKeyRecordSnapshot = {
        "version": 1,
        "key": hashlib.sha256(axolotl_bytes).digest(),
        "iteration": 0,
    }
    return _encrypt_sender_key_record(record, plaintext)


def _encrypt_sender_key_record(record: SenderKeyRecordSnapshot, plaintext: bytes) -> bytes:
    iteration = record["iteration"]
    nonce = _record_nonce(b"sender-key", iteration)
    return nonce + AESGCM(record["key"]).encrypt(nonce, plaintext, None)


def _record_nonce(prefix: bytes, counter: int) -> bytes:
    return hashlib.sha256(prefix + counter.to_bytes(8, "big")).digest()[:12]
