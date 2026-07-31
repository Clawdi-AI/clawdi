from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.hosted_runtime import HostedRuntimeSecret
from app.schemas.runtime import HostedRuntimeSecretValues
from app.services.vault_crypto import decrypt, encrypt

HOSTED_RUNTIME_SECRET_KEY_VERSION = "vault.v1"
_IDEMPOTENCY_KEY_DERIVATION_DOMAIN = b"clawdi.hosted-runtime-secret-values.idempotency-key.v1"


def runtime_secret_values_idempotency_identity(values: HostedRuntimeSecretValues) -> str:
    """Return a server-keyed identity safe to persist with idempotency metadata."""

    key_hex = settings.vault_encryption_key
    if not key_hex:
        raise RuntimeError("VAULT_ENCRYPTION_KEY not configured")
    key = bytes.fromhex(key_hex)
    if len(key) != 32:
        raise RuntimeError("VAULT_ENCRYPTION_KEY must be 32 bytes (64 hex chars)")
    idempotency_key = hmac.new(
        key,
        _IDEMPOTENCY_KEY_DERIVATION_DOMAIN,
        hashlib.sha256,
    ).digest()
    material = json.dumps(
        _plaintext_secret_values(values),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode()
    return hmac.new(idempotency_key, material, hashlib.sha256).hexdigest()


async def load_hosted_runtime_secrets_for_update(
    db: AsyncSession,
    *,
    environment_id: UUID,
) -> list[HostedRuntimeSecret]:
    return list(
        (
            await db.execute(
                select(HostedRuntimeSecret)
                .where(HostedRuntimeSecret.environment_id == environment_id)
                .order_by(HostedRuntimeSecret.secret_ref)
                .with_for_update()
            )
        ).scalars()
    )


def hosted_runtime_secret_values_changed(
    rows: Iterable[HostedRuntimeSecret],
    desired: HostedRuntimeSecretValues,
) -> bool:
    return _decrypted_secret_values(rows) != _plaintext_secret_values(desired)


def validate_hosted_runtime_secret_key_version(key_version: str) -> None:
    if key_version != HOSTED_RUNTIME_SECRET_KEY_VERSION:
        raise RuntimeError(f"Unsupported hosted runtime secret key version: {key_version}")


async def sync_hosted_runtime_secret_values(
    db: AsyncSession,
    *,
    environment_id: UUID,
    rows: Iterable[HostedRuntimeSecret],
    desired: HostedRuntimeSecretValues,
) -> None:
    desired_plaintext = _plaintext_secret_values(desired)
    existing = {row.secret_ref: row for row in rows}
    for secret_ref, plaintext in sorted(desired_plaintext.items()):
        row = existing.pop(secret_ref, None)
        if row is not None:
            validate_hosted_runtime_secret_key_version(row.key_version)
            if decrypt(row.encrypted_value, row.nonce) == plaintext:
                continue
        ciphertext, nonce = encrypt(plaintext)
        if row is None:
            db.add(
                HostedRuntimeSecret(
                    environment_id=environment_id,
                    secret_ref=secret_ref,
                    encrypted_value=ciphertext,
                    nonce=nonce,
                    key_version=HOSTED_RUNTIME_SECRET_KEY_VERSION,
                )
            )
            continue
        row.encrypted_value = ciphertext
        row.nonce = nonce
        row.key_version = HOSTED_RUNTIME_SECRET_KEY_VERSION
    for row in existing.values():
        await db.delete(row)


def _plaintext_secret_values(values: HostedRuntimeSecretValues) -> dict[str, str]:
    return {secret_ref: value.get_secret_value() for secret_ref, value in values.items()}


def _decrypted_secret_values(rows: Iterable[HostedRuntimeSecret]) -> dict[str, str]:
    result: dict[str, str] = {}
    for row in rows:
        validate_hosted_runtime_secret_key_version(row.key_version)
        result[row.secret_ref] = decrypt(row.encrypted_value, row.nonce)
    return result
