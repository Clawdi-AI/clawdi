"""Unit tests for the AES-256-GCM helpers in vault_crypto.

These are pure functions — no DB, no HTTP, no fixtures. They lock the
`encrypt_field` / `decrypt_field` contract that settings.py relies on.
"""

from __future__ import annotations

import base64

import pytest

from app.services.vault_crypto import (
    decrypt_field,
    encrypt_field,
    is_encrypted_field,
)


def test_encrypt_field_roundtrip() -> None:
    token = encrypt_field("mem0_live_supersecret")
    assert token.startswith("enc:")
    assert is_encrypted_field(token)
    assert decrypt_field(token) == "mem0_live_supersecret"


def test_encrypt_field_produces_fresh_nonce_each_call() -> None:
    # Two encryptions of the same plaintext must differ (fresh random nonce).
    a = encrypt_field("same-plaintext")
    b = encrypt_field("same-plaintext")
    assert a != b
    assert decrypt_field(a) == decrypt_field(b) == "same-plaintext"


def test_decrypt_field_legacy_plaintext_passthrough() -> None:
    # Values without the enc: prefix represent legacy plaintext rows; they
    # must round-trip unchanged so old users keep working during migration.
    assert decrypt_field("legacy-plaintext") == "legacy-plaintext"
    assert not is_encrypted_field("legacy-plaintext")


def test_is_encrypted_field_distinguishes_mask_from_ciphertext() -> None:
    # The UI mask "••••••••" must never be mistaken for ciphertext.
    assert not is_encrypted_field("••••••••")
    assert not is_encrypted_field("")


def test_decrypt_field_rejects_invalid_base64() -> None:
    with pytest.raises(ValueError, match="invalid base64"):
        decrypt_field("enc:!!!not-base64!!!")


def test_decrypt_field_rejects_truncated_blob() -> None:
    # 12-byte nonce + at least 1 byte of ciphertext required.
    too_short = "enc:" + base64.b64encode(b"short").decode("ascii")
    with pytest.raises(ValueError, match="truncated blob"):
        decrypt_field(too_short)


def test_decrypt_field_rejects_tampered_ciphertext() -> None:
    # GCM authentication tag catches tampering; we surface it as ValueError.
    # Decode the blob, flip a ciphertext byte, re-encode — this keeps the
    # blob well-formed (valid base64, correct length) so we actually exercise
    # the AES-GCM authentication tag rather than base64 validation.
    token = encrypt_field("secret")
    blob = bytearray(base64.b64decode(token[len("enc:") :]))
    blob[-1] ^= 0x01  # flip one bit in the ciphertext/tag tail
    tampered = "enc:" + base64.b64encode(bytes(blob)).decode("ascii")
    with pytest.raises(ValueError, match="authentication failed"):
        decrypt_field(tampered)


def test_encrypt_field_empty_string_roundtrip() -> None:
    # Empty plaintext is a legal input — callers guard before calling, but
    # the helper itself must not explode if someone passes "".
    token = encrypt_field("")
    assert is_encrypted_field(token)
    assert decrypt_field(token) == ""
