from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from cryptography.exceptions import InvalidTag
from sqlalchemy import case, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_provider import (
    AiProvider,
    AiProviderAuthPayload,
    AiProviderOAuthAttempt,
    AiProviderOAuthRevokeTombstone,
)
from app.services.ai_provider_credentials import claim_unique_bound_runtime
from app.services.vault_crypto import decrypt, encrypt

OAuthRevokeStatus = Literal["pending", "not_required"]


@dataclass(frozen=True, slots=True)
class AuthCredentialWrite:
    profile: str
    kind: str
    plaintext: str
    metadata: dict | None


@dataclass(frozen=True, slots=True)
class AuthTransitionResult:
    remote_revoke_status: OAuthRevokeStatus
    manifest_event_queued: bool


@dataclass(frozen=True, slots=True)
class OAuthRevokeTombstoneRef:
    id: UUID


async def queue_provider_runtime_manifest_changed(
    db: AsyncSession,
    owner_user_id: UUID,
    provider_id: str,
) -> None:
    # sync_events imports managed provider constants, so defer this import to
    # keep the auth-transition/managed-provider dependency acyclic.
    from app.services.sync_events import (
        queue_provider_runtime_manifest_changed as queue_manifest_change,
    )

    await queue_manifest_change(db, owner_user_id, provider_id)


def revocable_oauth_token_from_envelope(payload_text: str) -> tuple[str, str] | None:
    try:
        envelope = json.loads(payload_text)
        files = envelope.get("files") if isinstance(envelope, dict) else None
        if not isinstance(files, list):
            return None
        auth_file = next(
            (
                item
                for item in files
                if isinstance(item, dict)
                and item.get("logicalName") == "auth.json"
                and isinstance(item.get("content"), str)
            ),
            None,
        )
        if auth_file is None:
            return None
        auth_json = json.loads(auth_file["content"])
        if not isinstance(auth_json, dict):
            return None
        auth_mode = auth_json.get("auth_mode")
        if auth_mode is not None and auth_mode != "chatgpt":
            return None
        if auth_mode is None and auth_json.get("OPENAI_API_KEY") is not None:
            return None
        tokens = auth_json.get("tokens")
        if not isinstance(tokens, dict):
            return None
        refresh_token = tokens.get("refresh_token")
        if isinstance(refresh_token, str) and refresh_token:
            return refresh_token, "refresh_token"
        access_token = tokens.get("access_token")
        if isinstance(access_token, str) and access_token:
            return access_token, "access_token"
    except (TypeError, ValueError):
        return None
    return None


def revocable_oauth_token(payload: AiProviderAuthPayload) -> tuple[str, str] | None:
    try:
        return revocable_oauth_token_from_envelope(
            decrypt(payload.encrypted_payload, payload.nonce)
        )
    except (InvalidTag, RuntimeError, TypeError, ValueError):
        return None


async def enqueue_oauth_revoke_tombstone(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider_id: str,
    oauth_provider: str,
    revocable: tuple[str, str] | None,
    oauth_attempt_id: UUID | None = None,
    not_before: datetime | None = None,
) -> OAuthRevokeTombstoneRef | None:
    if revocable is None:
        return None
    token, token_type = revocable
    token_sha256 = hashlib.sha256(token.encode()).hexdigest()
    encrypted_token, token_nonce = encrypt(token)
    ready_at = not_before or datetime.now(UTC)
    table = AiProviderOAuthRevokeTombstone.__table__
    preserve_existing = table.c.status.in_(("pending", "processing", "revoked"))
    statement = (
        insert(AiProviderOAuthRevokeTombstone)
        .values(
            owner_user_id=owner_user_id,
            oauth_attempt_id=oauth_attempt_id,
            provider_id=provider_id,
            oauth_provider=oauth_provider,
            token_type=token_type,
            token_sha256=token_sha256,
            encrypted_token=encrypted_token,
            token_nonce=token_nonce,
            status="pending",
            next_attempt_at=ready_at,
        )
        .on_conflict_do_update(
            constraint="uq_ai_provider_oauth_revoke_token",
            set_={
                "provider_id": case(
                    (preserve_existing, table.c.provider_id),
                    else_=provider_id,
                ),
                "oauth_attempt_id": case(
                    (preserve_existing, table.c.oauth_attempt_id),
                    else_=oauth_attempt_id,
                ),
                "encrypted_token": case(
                    (preserve_existing, table.c.encrypted_token),
                    else_=encrypted_token,
                ),
                "token_nonce": case(
                    (preserve_existing, table.c.token_nonce),
                    else_=token_nonce,
                ),
                "status": case(
                    (preserve_existing, table.c.status),
                    else_="pending",
                ),
                "next_attempt_at": case(
                    (preserve_existing, table.c.next_attempt_at),
                    else_=ready_at,
                ),
                "claimed_at": case(
                    (preserve_existing, table.c.claimed_at),
                    else_=None,
                ),
                "claim_id": case(
                    (preserve_existing, table.c.claim_id),
                    else_=None,
                ),
                "last_error": case(
                    (preserve_existing, table.c.last_error),
                    else_=None,
                ),
            },
        )
        .returning(AiProviderOAuthRevokeTombstone.id)
    )
    tombstone_id = (await db.execute(statement)).scalar_one()
    return OAuthRevokeTombstoneRef(id=tombstone_id)


async def cancel_oauth_revoke_tombstone(
    db: AsyncSession,
    tombstone_id: UUID,
    *,
    oauth_attempt_id: UUID,
) -> bool:
    result = await db.execute(
        update(AiProviderOAuthRevokeTombstone)
        .where(
            AiProviderOAuthRevokeTombstone.id == tombstone_id,
            AiProviderOAuthRevokeTombstone.status == "pending",
            AiProviderOAuthRevokeTombstone.oauth_attempt_id == oauth_attempt_id,
        )
        .values(
            status="cancelled",
            next_attempt_at=None,
            claim_id=None,
            claimed_at=None,
            encrypted_token=None,
            token_nonce=None,
        )
    )
    return result.rowcount == 1


async def transition_ai_provider_auth(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider: AiProvider,
    auth_type: str,
    auth_ref: str | None,
    auth_metadata: dict | None,
    credential: AuthCredentialWrite | None = None,
    archive_provider: bool = False,
    keep_oauth_attempt_id: UUID | None = None,
) -> AuthTransitionResult:
    """Apply one auth identity/material transition inside the caller's transaction."""

    now = datetime.now(UTC)
    old_identity = _auth_identity(provider.auth_type, provider.auth_ref, provider.auth_metadata)
    new_identity = _auth_identity(auth_type, auth_ref, auth_metadata)
    archive_active = archive_provider or credential is not None or old_identity != new_identity
    preserved_token_sha256 = _credential_revocable_token_sha256(credential)
    await db.execute(select(AiProvider.id).where(AiProvider.id == provider.id).with_for_update())
    if archive_active:
        attempt_filter = [
            AiProviderOAuthAttempt.provider_row_id == provider.id,
            AiProviderOAuthAttempt.status.in_(("pending", "exchanging")),
        ]
        if keep_oauth_attempt_id is not None:
            attempt_filter.append(AiProviderOAuthAttempt.id != keep_oauth_attempt_id)
        await db.execute(
            update(AiProviderOAuthAttempt)
            .where(*attempt_filter)
            .values(status="failed", completed_at=now)
        )
    payloads = list(
        (
            await db.execute(
                select(AiProviderAuthPayload)
                .where(
                    AiProviderAuthPayload.owner_user_id == owner_user_id,
                    AiProviderAuthPayload.provider_id == provider.provider_id,
                )
                .order_by(AiProviderAuthPayload.auth_profile)
                .with_for_update()
            )
        ).scalars()
    )
    remote_revoke_pending = False
    if archive_active:
        for payload in payloads:
            if payload.archived_at is not None:
                continue
            if payload.kind in {"agent_profile", "oauth_profile"}:
                revocable = revocable_oauth_token(payload)
                if revocable is not None:
                    token_sha256 = hashlib.sha256(revocable[0].encode()).hexdigest()
                    if token_sha256 != preserved_token_sha256:
                        tombstone = await enqueue_oauth_revoke_tombstone(
                            db,
                            owner_user_id=owner_user_id,
                            provider_id=provider.provider_id,
                            oauth_provider=_oauth_provider(payload.payload_metadata),
                            revocable=revocable,
                        )
                        remote_revoke_pending = remote_revoke_pending or tombstone is not None
            payload.archived_at = now
            payload.consumer_environment_id = None
            payload.consumer_runtime = None

    credential_revision = None
    if credential is not None:
        ciphertext, nonce = encrypt(credential.plaintext)
        payload = next(
            (item for item in payloads if item.auth_profile == credential.profile),
            None,
        )
        credential_revision = secrets.token_hex(16)
        if payload is None:
            payload = AiProviderAuthPayload(
                owner_user_id=owner_user_id,
                provider_id=provider.provider_id,
                auth_profile=credential.profile,
                kind=credential.kind,
                source="managed",
                encrypted_payload=ciphertext,
                nonce=nonce,
                payload_metadata=credential.metadata,
                credential_revision=credential_revision,
            )
            db.add(payload)
        else:
            payload.kind = credential.kind
            payload.source = "managed"
            payload.encrypted_payload = ciphertext
            payload.nonce = nonce
            payload.payload_metadata = credential.metadata
            payload.credential_revision = credential_revision
            payload.archived_at = None
        payload.consumer_environment_id = None
        payload.consumer_runtime = None
        if credential.kind in {"agent_profile", "oauth_profile"}:
            await claim_unique_bound_runtime(
                db,
                owner_user_id=owner_user_id,
                provider_id=provider.provider_id,
                payload=payload,
            )

    provider.auth_type = auth_type
    provider.auth_ref = auth_ref
    provider.auth_metadata = auth_metadata
    if archive_provider:
        provider.archived_at = now
    manifest_event_queued = archive_active
    if manifest_event_queued:
        await queue_provider_runtime_manifest_changed(db, owner_user_id, provider.provider_id)
    return AuthTransitionResult(
        remote_revoke_status="pending" if remote_revoke_pending else "not_required",
        manifest_event_queued=manifest_event_queued,
    )


def _auth_identity(auth_type: str, auth_ref: str | None, metadata: dict | None) -> tuple:
    values = metadata or {}
    if auth_type == "api_key":
        source = values.get("source")
        if source == "managed":
            return auth_type, source, str(values.get("profile") or "default")
        return auth_type, source, auth_ref
    if auth_type == "agent_profile":
        return auth_type, values.get("tool"), str(values.get("profile") or "default")
    if auth_type == "oauth_profile":
        return auth_type, values.get("provider"), str(values.get("profile") or "default")
    return auth_type, auth_ref


def _credential_revocable_token_sha256(credential: AuthCredentialWrite | None) -> str | None:
    if credential is None or credential.kind not in {"agent_profile", "oauth_profile"}:
        return None
    revocable = revocable_oauth_token_from_envelope(credential.plaintext)
    return hashlib.sha256(revocable[0].encode()).hexdigest() if revocable is not None else None


def _oauth_provider(metadata: dict | None) -> str:
    values = metadata or {}
    provider = values.get("tool") or values.get("provider")
    return provider if isinstance(provider, str) and provider else "codex"


__all__ = [
    "AuthCredentialWrite",
    "AuthTransitionResult",
    "OAuthRevokeTombstoneRef",
    "cancel_oauth_revoke_tombstone",
    "enqueue_oauth_revoke_tombstone",
    "revocable_oauth_token",
    "revocable_oauth_token_from_envelope",
    "transition_ai_provider_auth",
]
