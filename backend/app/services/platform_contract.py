from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from fastapi.encoders import jsonable_encoder
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.platform_idempotency import PlatformMutationIdempotency
from app.services.vault_crypto import decrypt, encrypt


@dataclass(frozen=True)
class PlatformReplay:
    status_code: int
    body: dict[str, Any]


def platform_request_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(
        jsonable_encoder(payload),
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


async def lock_platform_idempotency(
    db: AsyncSession,
    *,
    operation: str,
    idempotency_key: str,
) -> PlatformMutationIdempotency | None:
    lock_name = f"platform-idempotency:{operation}:{idempotency_key}"
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(lock_name, 0))))
    return (
        await db.execute(
            select(PlatformMutationIdempotency).where(
                PlatformMutationIdempotency.operation == operation,
                PlatformMutationIdempotency.idempotency_key == idempotency_key,
            )
        )
    ).scalar_one_or_none()


def read_platform_replay(row: PlatformMutationIdempotency) -> PlatformReplay:
    body = json.loads(decrypt(row.encrypted_response, row.response_nonce))
    if not isinstance(body, dict):
        raise ValueError("stored platform idempotency response is not an object")
    return PlatformReplay(status_code=row.response_status, body=body)


def store_platform_response(
    db: AsyncSession,
    *,
    operation: str,
    idempotency_key: str,
    request_hash: str,
    owner_user_id: UUID,
    resource_type: str,
    resource_id: str | None,
    response_status: int,
    response_body: dict[str, Any],
) -> PlatformMutationIdempotency:
    serialized = json.dumps(
        jsonable_encoder(response_body),
        separators=(",", ":"),
        sort_keys=True,
    )
    ciphertext, nonce = encrypt(serialized)
    row = PlatformMutationIdempotency(
        operation=operation,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        owner_user_id=owner_user_id,
        resource_type=resource_type,
        resource_id=resource_id,
        response_status=response_status,
        encrypted_response=ciphertext,
        response_nonce=nonce,
    )
    db.add(row)
    return row
