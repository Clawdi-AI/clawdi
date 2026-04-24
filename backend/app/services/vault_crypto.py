"""AES-256-GCM encryption for vault secrets."""

import base64
import binascii
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings

# Prefix used to distinguish encrypted values from legacy plaintext in JSONB columns.
_ENC_PREFIX = "enc:"


def _get_key() -> bytes:
    """Get the encryption key from settings (hex-encoded 32 bytes)."""
    hex_key = settings.vault_encryption_key
    if not hex_key:
        raise RuntimeError("VAULT_ENCRYPTION_KEY not configured")
    key = bytes.fromhex(hex_key)
    if len(key) != 32:
        raise RuntimeError("VAULT_ENCRYPTION_KEY must be 32 bytes (64 hex chars)")
    return key


def encrypt(plaintext: str) -> tuple[bytes, bytes]:
    """Encrypt a string. Returns (ciphertext, nonce)."""
    key = _get_key()
    nonce = os.urandom(12)
    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
    return ciphertext, nonce


def decrypt(ciphertext: bytes, nonce: bytes) -> str:
    """Decrypt ciphertext back to string."""
    key = _get_key()
    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(nonce, ciphertext, None)
    return plaintext.decode("utf-8")


def encrypt_field(plaintext: str) -> str:
    """Encrypt a single string field into a prefixed, base64-encoded token.

    The output format is ``enc:<base64(nonce + ciphertext)>`` so that callers
    can detect whether a DB value is encrypted by checking for the prefix.
    """
    ciphertext, nonce = encrypt(plaintext)
    # Pack nonce (12 bytes) + ciphertext together so we only need one blob.
    blob = base64.b64encode(nonce + ciphertext).decode("ascii")
    return f"{_ENC_PREFIX}{blob}"


def decrypt_field(value: str) -> str:
    """Decrypt a value produced by :func:`encrypt_field`.

    If *value* does not start with the ``enc:`` prefix it is returned as-is
    (legacy plaintext pass-through for transparent migration).

    Raises :class:`ValueError` on malformed input (bad base64, truncated blob,
    or authentication failure) so callers can decide whether to 500, fall
    back, or log — without ever silently returning garbage.
    """
    if not value.startswith(_ENC_PREFIX):
        # Legacy plaintext — return unchanged so old rows keep working.
        return value
    try:
        blob = base64.b64decode(value[len(_ENC_PREFIX) :], validate=True)
    except (binascii.Error, ValueError) as e:
        raise ValueError("malformed encrypted field (invalid base64)") from e
    if len(blob) < 13:
        # 12-byte nonce + at least 1 byte of ciphertext required.
        raise ValueError("malformed encrypted field (truncated blob)")
    nonce = blob[:12]
    ciphertext = blob[12:]
    try:
        return decrypt(ciphertext, nonce)
    except Exception as e:  # AESGCM raises InvalidTag on tamper, ValueError on length
        raise ValueError("malformed encrypted field (authentication failed)") from e


def is_encrypted_field(value: str) -> bool:
    """Return True if *value* was produced by :func:`encrypt_field`."""
    return value.startswith(_ENC_PREFIX)
