from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from cryptography.exceptions import InvalidTag
from pydantic import JsonValue, TypeAdapter, ValidationError
from sqlalchemy import case, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_provider import (
    AiProvider,
    AiProviderAuthPayload,
    AiProviderOAuthRevokeTombstone,
)
from app.services.ai_provider_credentials import (
    claim_unique_bound_runtime,
    lock_ai_provider_owner,
    validate_prospective_bound_runtime_auth,
)
from app.services.ai_provider_oauth_attempt import fail_active_oauth_attempts
from app.services.vault_crypto import decrypt, encrypt

OAuthRevokeStatus = Literal["pending", "not_required"]
OAuthTokenExtractionState = Literal["revocable", "not_revocable", "corrupt"]
OAUTH_CREDENTIAL_SOURCES = frozenset({"device_code", "oauth_pkce"})
type JsonObject = dict[str, JsonValue]
_JSON_OBJECT_ADAPTER: TypeAdapter[JsonObject] = TypeAdapter(dict[str, JsonValue])


class OAuthCredentialPayloadCorruptError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("OAuth credential payload is corrupt")


@dataclass(frozen=True, slots=True)
class AuthCredentialWrite:
    profile: str
    kind: str
    plaintext: str
    metadata: dict[str, JsonValue] | None


@dataclass(frozen=True, slots=True)
class AuthTransitionResult:
    remote_revoke_status: OAuthRevokeStatus
    manifest_event_queued: bool


@dataclass(frozen=True, slots=True)
class OAuthRevokeTombstoneRef:
    id: UUID


@dataclass(frozen=True, slots=True)
class OAuthTokenExtraction:
    state: OAuthTokenExtractionState
    revocable: tuple[str, str] | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if (self.state == "revocable") != (self.revocable is not None):
            raise ValueError("OAuth token extraction state is inconsistent")


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


def extract_oauth_token_from_envelope(payload_text: str) -> OAuthTokenExtraction:
    envelope = _parse_json_object(payload_text)
    if envelope is None:
        return OAuthTokenExtraction(state="corrupt")
    if (
        envelope.get("schemaVersion") != 1
        or envelope.get("kind") != "local_agent_profile"
        or not isinstance(envelope.get("tool"), str)
        or not envelope["tool"]
        or not isinstance(envelope.get("profile"), str)
        or not envelope["profile"]
    ):
        return OAuthTokenExtraction(state="corrupt")
    files = envelope.get("files")
    if not isinstance(files, list) or not files:
        return OAuthTokenExtraction(state="corrupt")
    auth_files: list[JsonObject] = []
    for item in files:
        if not isinstance(item, dict):
            return OAuthTokenExtraction(state="corrupt")
        logical_name = item.get("logicalName")
        source_path = item.get("sourcePath")
        target_strategy = item.get("targetStrategy")
        content = item.get("content")
        mode = item.get("mode")
        size = item.get("size")
        if (
            not isinstance(logical_name, str)
            or not logical_name
            or not isinstance(source_path, str)
            or target_strategy not in {"adapter_default", "explicit"}
            or not isinstance(content, str)
            or not isinstance(mode, int)
            or isinstance(mode, bool)
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
        ):
            return OAuthTokenExtraction(state="corrupt")
        if logical_name == "auth.json":
            auth_files.append(item)
    if not auth_files:
        return OAuthTokenExtraction(state="not_revocable")
    if len(auth_files) != 1:
        return OAuthTokenExtraction(state="corrupt")
    auth_file_content = auth_files[0].get("content")
    if not isinstance(auth_file_content, str):
        return OAuthTokenExtraction(state="corrupt")
    auth_json = _parse_json_object(auth_file_content)
    if auth_json is None:
        return OAuthTokenExtraction(state="corrupt")
    auth_mode = auth_json.get("auth_mode")
    if auth_mode is not None:
        if not isinstance(auth_mode, str) or not auth_mode:
            return OAuthTokenExtraction(state="corrupt")
        if auth_mode != "chatgpt":
            return OAuthTokenExtraction(state="not_revocable")
    elif "OPENAI_API_KEY" in auth_json:
        api_key = auth_json["OPENAI_API_KEY"]
        if not isinstance(api_key, str) or not api_key:
            return OAuthTokenExtraction(state="corrupt")
        return OAuthTokenExtraction(state="not_revocable")

    tokens = auth_json.get("tokens")
    if not isinstance(tokens, dict):
        return OAuthTokenExtraction(state="corrupt")
    for token_name in ("refresh_token", "access_token"):
        if token_name in tokens and (
            not isinstance(tokens[token_name], str) or not tokens[token_name]
        ):
            return OAuthTokenExtraction(state="corrupt")
    refresh_token = tokens.get("refresh_token")
    if isinstance(refresh_token, str):
        return OAuthTokenExtraction(
            state="revocable",
            revocable=(refresh_token, "refresh_token"),
        )
    access_token = tokens.get("access_token")
    if isinstance(access_token, str):
        return OAuthTokenExtraction(
            state="revocable",
            revocable=(access_token, "access_token"),
        )
    return OAuthTokenExtraction(state="corrupt")


def _preflight_active_oauth_payload(
    payload: AiProviderAuthPayload,
) -> OAuthTokenExtraction | None:
    """Validate active OAuth material without treating generic profiles as OAuth."""

    try:
        plaintext = decrypt(payload.encrypted_payload, payload.nonce)
    except (InvalidTag, RuntimeError, TypeError, UnicodeError, ValueError):
        # A ciphertext failure cannot prove that a stored agent profile is
        # non-OAuth, so fail closed before its archive/revoke state can change.
        return OAuthTokenExtraction(state="corrupt")
    if not _is_oauth_credential_payload(
        kind=payload.kind,
        metadata=payload.payload_metadata,
        plaintext=plaintext,
    ):
        return None
    return extract_oauth_token_from_envelope(plaintext)


def _preflight_incoming_oauth_credential(
    credential: AuthCredentialWrite | None,
) -> OAuthTokenExtraction | None:
    if credential is None or not _is_oauth_credential_payload(
        kind=credential.kind,
        metadata=credential.metadata,
        plaintext=credential.plaintext,
    ):
        return None
    return extract_oauth_token_from_envelope(credential.plaintext)


def _is_oauth_credential_payload(
    *,
    kind: str,
    metadata: dict[str, JsonValue] | None,
    plaintext: str,
) -> bool:
    if kind == "oauth_profile":
        return True
    if kind != "agent_profile":
        return False
    source = (metadata or {}).get("source")
    if source in OAUTH_CREDENTIAL_SOURCES:
        return True
    envelope = _parse_json_object(plaintext)
    return envelope is not None and "files" in envelope


def _parse_json_object(value: str) -> JsonObject | None:
    try:
        return _JSON_OBJECT_ADAPTER.validate_json(value)
    except ValidationError:
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
    updated_id = await db.scalar(
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
        .returning(AiProviderOAuthRevokeTombstone.id)
    )
    return updated_id is not None


async def transition_ai_provider_auth(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider: AiProvider,
    auth_type: str,
    auth_ref: str | None,
    auth_metadata: dict[str, JsonValue] | None,
    credential: AuthCredentialWrite | None = None,
    archive_provider: bool = False,
    keep_oauth_attempt_id: UUID | None = None,
) -> AuthTransitionResult:
    """Apply one auth identity/material transition inside the caller's transaction."""

    await lock_ai_provider_owner(db, owner_user_id)
    if auth_type != provider.auth_type:
        await validate_prospective_bound_runtime_auth(
            db,
            owner_user_id=owner_user_id,
            provider_id=provider.provider_id,
            prospective_auth_type=auth_type,
        )
    now = datetime.now(UTC)
    old_identity = _auth_identity(provider.auth_type, provider.auth_ref, provider.auth_metadata)
    new_identity = _auth_identity(auth_type, auth_ref, auth_metadata)
    archive_active = archive_provider or credential is not None or old_identity != new_identity
    incoming_oauth = _preflight_incoming_oauth_credential(credential)
    preserved_token_sha256 = _credential_revocable_token_sha256(incoming_oauth)
    await db.execute(select(AiProvider.id).where(AiProvider.id == provider.id).with_for_update())
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
    active_oauth_revocables: dict[UUID, tuple[str, str] | None] = {}
    if archive_active:
        for payload in payloads:
            if payload.archived_at is None and payload.kind in {"agent_profile", "oauth_profile"}:
                extraction = _preflight_active_oauth_payload(payload)
                if extraction is not None:
                    active_oauth_revocables[payload.id] = _revocable_or_raise(extraction)

        await fail_active_oauth_attempts(
            db,
            provider_row_id=provider.id,
            completed_at=now,
            exclude_attempt_id=keep_oauth_attempt_id,
        )
    remote_revoke_pending = False
    if archive_active:
        for payload in payloads:
            if payload.archived_at is not None:
                continue
            if payload.kind in {"agent_profile", "oauth_profile"}:
                revocable = active_oauth_revocables.get(payload.id)
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
                prospective_auth_type=auth_type,
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


def _auth_identity(
    auth_type: str,
    auth_ref: str | None,
    metadata: dict[str, JsonValue] | None,
) -> tuple[object, ...]:
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


def _credential_revocable_token_sha256(
    extraction: OAuthTokenExtraction | None,
) -> str | None:
    if extraction is None:
        return None
    revocable = _revocable_or_raise(extraction)
    return hashlib.sha256(revocable[0].encode()).hexdigest() if revocable is not None else None


def _revocable_or_raise(extraction: OAuthTokenExtraction) -> tuple[str, str] | None:
    if extraction.state == "corrupt":
        raise OAuthCredentialPayloadCorruptError()
    return extraction.revocable


def _oauth_provider(metadata: dict[str, JsonValue] | None) -> str:
    values = metadata or {}
    provider = values.get("tool") or values.get("provider")
    return provider if isinstance(provider, str) and provider else "codex"


__all__ = [
    "AuthCredentialWrite",
    "AuthTransitionResult",
    "OAuthCredentialPayloadCorruptError",
    "OAuthRevokeTombstoneRef",
    "OAuthTokenExtraction",
    "cancel_oauth_revoke_tombstone",
    "enqueue_oauth_revoke_tombstone",
    "extract_oauth_token_from_envelope",
    "transition_ai_provider_auth",
]
