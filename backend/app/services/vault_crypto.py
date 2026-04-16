"""AES-256-GCM encryption for vault secrets."""

import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings


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
