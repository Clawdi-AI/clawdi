from __future__ import annotations

import base64
import binascii
import hashlib
import json
import logging
import secrets
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Literal
from urllib.parse import urlparse
from uuid import UUID, uuid4

import httpx
from fastapi import HTTPException, status
from pydantic import JsonValue, TypeAdapter, ValidationError
from sqlalchemy import and_, delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import settings
from app.core.database import async_session_factory
from app.models.ai_provider import (
    AiProvider,
    AiProviderAuthPayload,
    AiProviderOAuthAttempt,
    AiProviderOAuthRevokeTombstone,
)
from app.schemas.ai_provider import AiProviderResponse
from app.services.ai_provider_capabilities import effective_provider_api_mode
from app.services.ai_provider_credentials import (
    OAuthCredentialClaimConflict,
    lock_ai_provider_owner,
)
from app.services.ai_provider_oauth_lifecycle import (
    OAUTH_RETENTION_BATCH_SIZE,
    OAUTH_TERMINAL_RETENTION,
    OAuthRetentionPurgeResult,
    terminal_oauth_attempt,
)
from app.services.codex_oauth import (
    CODEX_OAUTH_CLIENT_ID,
    CODEX_OAUTH_TOKEN_URL,
    CodexOAuthUpstreamError,
    exchange_device_code,
    poll_device_authorization,
)
from app.services.vault_crypto import decrypt, encrypt

if TYPE_CHECKING:
    from app.services.ai_provider_auth_transition import OAuthRevokeTombstoneRef

log = logging.getLogger(__name__)

OAuthFlowKind = Literal["authorization_code", "device_code"]
ProviderResponseBuilder = Callable[[AsyncSession, AiProvider], Awaitable[AiProviderResponse]]

OAUTH_EXCHANGE_STALE_SECONDS = 2 * 60
OAUTH_DEVICE_POLL_LEASE_SECONDS = 30
CODEX_OAUTH_PROVIDER = "codex"
CODEX_OPENAI_BASE_URL = "https://api.openai.com/v1"
CODEX_OAUTH_REVOKE_URL = "https://auth.openai.com/oauth/revoke"
CODEX_OAUTH_CONFIG: dict[str, JsonValue] = {
    "authorization_url": "https://auth.openai.com/oauth/authorize",
    "token_url": CODEX_OAUTH_TOKEN_URL,
    "client_id": CODEX_OAUTH_CLIENT_ID,
    "scope": "openid profile email offline_access api.connectors.read api.connectors.invoke",
    "extra_authorize_params": {
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
        "originator": "codex_cli_rs",
    },
}

_JSON_OBJECT_ADAPTER = TypeAdapter(dict[str, JsonValue])


@dataclass(frozen=True, slots=True)
class OAuthAttemptStateIdentity:
    flow_id: UUID
    state_sha256: str


@dataclass(frozen=True, slots=True)
class OAuthDevicePollPending:
    retry_after_seconds: int


@dataclass(frozen=True, slots=True)
class _DevicePollClaim:
    attempt_id: UUID
    claim_id: str
    oauth_provider: str
    device_auth_id: str
    user_code: str
    retry_after_seconds: int


async def fail_active_oauth_attempts(
    db: AsyncSession,
    *,
    provider_row_id: UUID,
    completed_at: datetime | None = None,
    exclude_attempt_id: UUID | None = None,
) -> None:
    """Fail and scrub active attempts inside the caller's locked transaction."""

    filters = [
        AiProviderOAuthAttempt.provider_row_id == provider_row_id,
        AiProviderOAuthAttempt.status.in_(("pending", "polling", "exchanging")),
    ]
    if exclude_attempt_id is not None:
        filters.append(AiProviderOAuthAttempt.id != exclude_attempt_id)
    await db.execute(
        update(AiProviderOAuthAttempt)
        .where(*filters)
        .values(**terminal_oauth_attempt("failed", completed_at=completed_at).update_values())
    )


async def fence_oauth_attempt_for_revoke(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    attempt_id: UUID | None,
    pending_due: bool,
    processing_stale: bool,
    claimed_at: datetime,
    attempt_stale_before: datetime,
) -> bool:
    """Fence an attempt before its compensation tombstone enters processing."""

    await lock_ai_provider_owner(db, owner_user_id)
    if attempt_id is None:
        return True
    identity = await db.get(AiProviderOAuthAttempt, attempt_id)
    if identity is None:
        return True
    if identity.owner_user_id != owner_user_id:
        raise RuntimeError("OAuth revoke tombstone owner does not match attempt owner")
    await db.execute(
        select(AiProvider.id).where(AiProvider.id == identity.provider_row_id).with_for_update()
    )
    attempt = (
        await db.execute(
            select(AiProviderOAuthAttempt)
            .where(AiProviderOAuthAttempt.id == attempt_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if attempt is None:
        return True
    if processing_stale and attempt.status == "exchanging":
        terminal_oauth_attempt("failed", completed_at=claimed_at).apply(attempt)
        return True
    if pending_due:
        if attempt.status == "exchanging":
            if (
                attempt.exchange_started_at is None
                or attempt.exchange_started_at > attempt_stale_before
            ):
                return False
            terminal_oauth_attempt("failed", completed_at=claimed_at).apply(attempt)
        elif attempt.status != "failed":
            return False
    return True


async def oauth_revoke_candidate_ids(
    db: AsyncSession,
    *,
    claimed_at: datetime,
    tombstone_stale_before: datetime,
    attempt_stale_before: datetime,
    limit: int = 32,
) -> list[UUID]:
    """Read revoke candidates without taking locks before the common User lock."""

    attempt_eligible = or_(
        AiProviderOAuthRevokeTombstone.oauth_attempt_id.is_(None),
        AiProviderOAuthAttempt.id.is_(None),
        AiProviderOAuthAttempt.status == "failed",
        and_(
            AiProviderOAuthAttempt.status == "exchanging",
            AiProviderOAuthAttempt.exchange_started_at <= attempt_stale_before,
        ),
    )
    return list(
        (
            await db.execute(
                select(AiProviderOAuthRevokeTombstone.id)
                .outerjoin(
                    AiProviderOAuthAttempt,
                    AiProviderOAuthAttempt.id == AiProviderOAuthRevokeTombstone.oauth_attempt_id,
                )
                .where(
                    or_(
                        and_(
                            AiProviderOAuthRevokeTombstone.status == "pending",
                            or_(
                                AiProviderOAuthRevokeTombstone.next_attempt_at.is_(None),
                                AiProviderOAuthRevokeTombstone.next_attempt_at <= claimed_at,
                            ),
                            attempt_eligible,
                        ),
                        and_(
                            AiProviderOAuthRevokeTombstone.status == "processing",
                            AiProviderOAuthRevokeTombstone.claimed_at <= tombstone_stale_before,
                        ),
                    )
                )
                .order_by(
                    AiProviderOAuthRevokeTombstone.next_attempt_at.asc().nullsfirst(),
                    AiProviderOAuthRevokeTombstone.created_at,
                    AiProviderOAuthRevokeTombstone.id,
                )
                .limit(max(0, limit))
            )
        ).scalars()
    )


async def purge_expired_oauth_records(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    retention: timedelta = OAUTH_TERMINAL_RETENTION,
    limit: int = OAUTH_RETENTION_BATCH_SIZE,
) -> OAuthRetentionPurgeResult:
    """Delete one bounded batch of expired terminal OAuth audit rows."""

    batch_limit = max(0, limit)
    if batch_limit == 0:
        return OAuthRetentionPurgeResult(attempts=0, tombstones=0)
    cutoff = (now or datetime.now(UTC)) - retention
    attempt_ids = list(
        (
            await db.execute(
                select(AiProviderOAuthAttempt.id)
                .where(
                    AiProviderOAuthAttempt.status.in_(("committed", "failed")),
                    AiProviderOAuthAttempt.completed_at < cutoff,
                )
                .order_by(AiProviderOAuthAttempt.completed_at, AiProviderOAuthAttempt.id)
                .limit(batch_limit)
                .with_for_update(skip_locked=True)
            )
        ).scalars()
    )
    if attempt_ids:
        await db.execute(
            delete(AiProviderOAuthAttempt).where(AiProviderOAuthAttempt.id.in_(attempt_ids))
        )
    tombstone_ids = list(
        (
            await db.execute(
                select(AiProviderOAuthRevokeTombstone.id)
                .where(
                    AiProviderOAuthRevokeTombstone.status.in_(
                        ("cancelled", "revoked", "quarantined")
                    ),
                    AiProviderOAuthRevokeTombstone.updated_at < cutoff,
                )
                .order_by(
                    AiProviderOAuthRevokeTombstone.updated_at,
                    AiProviderOAuthRevokeTombstone.id,
                )
                .limit(batch_limit)
                .with_for_update(skip_locked=True)
            )
        ).scalars()
    )
    if tombstone_ids:
        await db.execute(
            delete(AiProviderOAuthRevokeTombstone).where(
                AiProviderOAuthRevokeTombstone.id.in_(tombstone_ids)
            )
        )
    return OAuthRetentionPurgeResult(
        attempts=len(attempt_ids),
        tombstones=len(tombstone_ids),
    )


def validate_codex_oauth_provider_shape(provider: AiProvider | object) -> None:
    provider_type = getattr(provider, "type", None)
    api_mode = getattr(provider, "api_mode", None)
    base_url = getattr(provider, "base_url", "")
    if (
        provider_type != "openai"
        or effective_provider_api_mode(provider_type, api_mode) != "openai_responses"
        or not isinstance(base_url, str)
        or base_url.rstrip("/") != CODEX_OPENAI_BASE_URL
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "ChatGPT sign-in requires the canonical OpenAI Responses provider",
        )


class AiProviderOAuthAttemptService:
    """Own the durable OAuth attempt state machine and its transaction fences."""

    def __init__(
        self,
        *,
        response_builder: ProviderResponseBuilder,
        session_factory: async_sessionmaker[AsyncSession] | None = None,
    ) -> None:
        self._response_builder = response_builder
        self._session_factory = session_factory or async_session_factory

    async def persist_attempt(
        self,
        db: AsyncSession,
        *,
        owner_user_id: UUID,
        provider: AiProvider,
        profile: str,
        flow_kind: OAuthFlowKind,
        expires_at: datetime,
        flow_payload: dict[str, JsonValue],
    ) -> str:
        await lock_ai_provider_owner(db, owner_user_id)
        locked_provider = (
            await db.execute(
                select(AiProvider)
                .where(
                    AiProvider.id == provider.id,
                    AiProvider.owner_user_id == owner_user_id,
                    AiProvider.archived_at.is_(None),
                )
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if locked_provider is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "AI Provider not found")
        validate_codex_oauth_provider_shape(locked_provider)
        await fail_active_oauth_attempts(
            db,
            provider_row_id=locked_provider.id,
        )
        payload = (
            await db.execute(
                select(AiProviderAuthPayload)
                .where(
                    AiProviderAuthPayload.owner_user_id == owner_user_id,
                    AiProviderAuthPayload.provider_id == locked_provider.provider_id,
                    AiProviderAuthPayload.auth_profile == profile,
                    AiProviderAuthPayload.archived_at.is_(None),
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        flow_id = uuid4()
        state_value = encode_oauth_state(
            {"flow_id": str(flow_id), "fence": secrets.token_urlsafe(24)}
        )
        encrypted_payload, payload_nonce = encrypt(
            json.dumps(flow_payload, separators=(",", ":"), sort_keys=True)
        )
        db.add(
            AiProviderOAuthAttempt(
                id=uuid4(),
                flow_id=flow_id,
                owner_user_id=owner_user_id,
                provider_row_id=locked_provider.id,
                provider_id=locked_provider.provider_id,
                oauth_provider=CODEX_OAUTH_PROVIDER,
                auth_profile=profile,
                flow_kind=flow_kind,
                status="pending",
                base_credential_revision=(
                    payload.credential_revision if payload is not None else None
                ),
                state_sha256=hashlib.sha256(state_value.encode()).hexdigest(),
                encrypted_flow_payload=encrypted_payload,
                flow_payload_nonce=payload_nonce,
                expires_at=expires_at,
            )
        )
        await db.flush()
        return state_value

    async def begin_exchange(
        self,
        *,
        owner_user_id: UUID,
        provider_id: str,
        state_value: str,
        flow_kind: OAuthFlowKind,
        payload_updates: dict[str, JsonValue],
    ) -> UUID | AiProviderResponse:
        state_identity = oauth_attempt_state_identity(state_value)
        async with self._session_factory() as db:
            provider, attempt = await self._lock_attempt_for_state(
                db,
                state_identity=state_identity,
                owner_user_id=owner_user_id,
                provider_id=provider_id,
                flow_kind=flow_kind,
            )
            replay = oauth_attempt_replay(attempt)
            if replay is not None:
                await db.rollback()
                return replay
            if provider is None or provider.archived_at is not None:
                terminal_oauth_attempt("failed").apply(attempt)
                await db.commit()
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "AI Provider changed after sign-in started",
                )
            if attempt.status == "exchanging" and self._exchange_is_stale(attempt):
                # Reusable code/verifier material is already durable. Re-fence a
                # crashed exchanger rather than discarding the one-time result.
                attempt_id = attempt.id
                attempt.exchange_started_at = datetime.now(UTC)
                await db.commit()
                return attempt_id
            if attempt.status != "pending":
                await db.rollback()
                raise HTTPException(status.HTTP_409_CONFLICT, "OAuth completion is not pending")
            try:
                await self._validate_attempt_fence(db, provider=provider, attempt=attempt)
            except HTTPException:
                terminal_oauth_attempt("failed").apply(attempt)
                await db.commit()
                raise
            flow_payload = oauth_attempt_flow_payload(attempt)
            requested_redirect_uri = payload_updates.get("requested_redirect_uri")
            if flow_kind == "authorization_code":
                redirect_uri = str(flow_payload.get("redirect_uri") or "")
                validate_redirect_uri(redirect_uri)
                if requested_redirect_uri is not None:
                    validate_redirect_uri(str(requested_redirect_uri))
                    if not secrets.compare_digest(str(requested_redirect_uri), redirect_uri):
                        raise HTTPException(
                            status.HTTP_400_BAD_REQUEST,
                            "OAuth redirect_uri does not match state",
                        )
            flow_payload.update(
                {
                    key: value
                    for key, value in payload_updates.items()
                    if key != "requested_redirect_uri" and value is not None
                }
            )
            self._store_flow_payload(attempt, flow_payload)
            attempt.status = "exchanging"
            attempt.exchange_started_at = datetime.now(UTC)
            attempt.poll_claim_id = None
            attempt_id = attempt.id
            await db.commit()
            return attempt_id

    async def poll_device_attempt(
        self,
        *,
        owner_user_id: UUID,
        provider_id: str,
        state_value: str,
    ) -> OAuthDevicePollPending | AiProviderResponse:
        state_identity = oauth_attempt_state_identity(state_value)
        claim = await self._claim_device_poll(
            state_identity=state_identity,
            owner_user_id=owner_user_id,
            provider_id=provider_id,
        )
        if isinstance(claim, AiProviderResponse):
            return claim
        if isinstance(claim, OAuthDevicePollPending):
            return claim
        if isinstance(claim, UUID):
            return await self.exchange_and_commit(
                attempt_id=claim,
                owner_user_id=owner_user_id,
            )

        config = oauth_config_for(claim.oauth_provider)
        client_id = required_oauth_config(config, "client_id", claim.oauth_provider)
        if client_id != CODEX_OAUTH_CLIENT_ID:
            await self.fail_attempt(claim.attempt_id, expected_claim_id=claim.claim_id)
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "ChatGPT device sign-in requires the official Codex OAuth client",
            )
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                poll_result = await poll_device_authorization(
                    client,
                    device_auth_id=claim.device_auth_id,
                    user_code=claim.user_code,
                )
        except CodexOAuthUpstreamError as exc:
            if exc.pending_retry:
                await self._release_device_poll(claim)
                return OAuthDevicePollPending(exc.retry_after or claim.retry_after_seconds)
            await self.fail_attempt(claim.attempt_id, expected_claim_id=claim.claim_id)
            raise _codex_upstream_http_exception(exc) from exc

        if poll_result.pending:
            await self._release_device_poll(claim)
            return OAuthDevicePollPending(claim.retry_after_seconds)
        if poll_result.authorization_code is None or poll_result.code_verifier is None:
            await self.fail_attempt(claim.attempt_id, expected_claim_id=claim.claim_id)
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "ChatGPT device authorization response was incomplete",
            )

        # The upstream response cannot be atomically committed with our database.
        # The durable polling claim precedes the call, and this immediate CAS stores
        # the one-time result before any token exchange. A process death between the
        # response and this commit is the remaining unavoidable external atomicity
        # window; an expired polling lease can be reclaimed and retried.
        attempt_id = await self._persist_device_poll_success(
            claim,
            authorization_code=poll_result.authorization_code,
            code_verifier=poll_result.code_verifier,
        )
        return await self.exchange_and_commit(
            attempt_id=attempt_id,
            owner_user_id=owner_user_id,
        )

    async def exchange_and_commit(
        self,
        *,
        attempt_id: UUID,
        owner_user_id: UUID,
    ) -> AiProviderResponse:
        async with self._session_factory() as db:
            attempt = await db.get(AiProviderOAuthAttempt, attempt_id)
            if attempt is None or attempt.owner_user_id != owner_user_id:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "OAuth attempt not found")
            replay = oauth_attempt_replay(attempt)
            if replay is not None:
                await db.rollback()
                return replay
            if attempt.status != "exchanging":
                raise HTTPException(status.HTTP_409_CONFLICT, "OAuth completion is not exchanging")
            oauth_provider = attempt.oauth_provider
            profile = attempt.auth_profile
            flow_kind = attempt.flow_kind
            provider_id = attempt.provider_id
            flow_payload = oauth_attempt_flow_payload(attempt)
            await db.rollback()

        config = oauth_config_for(oauth_provider)
        client_id = required_oauth_config(config, "client_id", oauth_provider)
        compensation: OAuthRevokeTombstoneRef | None = None
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                if flow_kind == "device_code":
                    response = await exchange_device_code(
                        client,
                        client_id=client_id,
                        authorization_code=str(flow_payload.get("authorization_code") or ""),
                        code_verifier=str(flow_payload.get("code_verifier") or ""),
                    )
                    source = "device_code"
                else:
                    response = await _exchange_authorization_code(
                        client,
                        oauth_provider=oauth_provider,
                        config=config,
                        client_id=client_id,
                        flow_payload=flow_payload,
                    )
                    source = "oauth_pkce"
                revocable = revocable_token_from_token_response(response)
                if revocable is not None:
                    # The upstream exchange and this database cannot share a
                    # transaction. A hard process death before the first durable
                    # tombstone write remains unavoidable; catchable write failures
                    # synchronously revoke and then retry the durable record below.
                    compensation = await self._persist_compensation_or_revoke(
                        owner_user_id=owner_user_id,
                        provider_id=provider_id,
                        oauth_provider=oauth_provider,
                        attempt_id=attempt_id,
                        revocable=revocable,
                    )
                payload_text = await _codex_auth_profile_payload(client, config, response, profile)
                provider_auth_type = "agent_profile"
                metadata: dict[str, JsonValue] = {
                    "tool": "codex",
                    "profile": profile,
                    "source": source,
                }
        except CodexOAuthUpstreamError as exc:
            await self.fail_attempt(attempt_id)
            raise _codex_upstream_http_exception(exc) from exc
        except httpx.HTTPError as exc:
            await self.fail_attempt(attempt_id)
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "OAuth token exchange failed") from exc
        except Exception:
            await self.fail_attempt(attempt_id)
            raise

        try:
            return await self.commit_attempt(
                attempt_id=attempt_id,
                owner_user_id=owner_user_id,
                provider_auth_type=provider_auth_type,
                payload_text=payload_text,
                metadata=metadata,
                compensation=compensation,
            )
        except Exception:
            await self.fail_attempt(attempt_id)
            raise

    async def commit_attempt(
        self,
        *,
        attempt_id: UUID,
        owner_user_id: UUID,
        provider_auth_type: str,
        payload_text: str,
        metadata: dict[str, JsonValue],
        compensation: OAuthRevokeTombstoneRef | None,
    ) -> AiProviderResponse:
        from app.services.ai_provider_auth_transition import (
            AuthCredentialWrite,
            cancel_oauth_revoke_tombstone,
            transition_ai_provider_auth,
        )

        async with self._session_factory() as db:
            provider, attempt = await self._lock_attempt_by_id(
                db,
                attempt_id=attempt_id,
                owner_user_id=owner_user_id,
            )
            replay = oauth_attempt_replay(attempt)
            if replay is not None:
                await db.rollback()
                return replay
            if provider is None or provider.archived_at is not None:
                terminal_oauth_attempt("failed").apply(attempt)
                await db.commit()
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "AI Provider changed after sign-in started",
                )
            if attempt.status != "exchanging":
                raise HTTPException(status.HTTP_409_CONFLICT, "OAuth completion lost its fence")
            try:
                await self._validate_attempt_fence(db, provider=provider, attempt=attempt)
            except HTTPException:
                terminal_oauth_attempt("failed").apply(attempt)
                await db.commit()
                raise
            if compensation is not None and not await cancel_oauth_revoke_tombstone(
                db,
                compensation.id,
                oauth_attempt_id=attempt.id,
            ):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "OAuth completion compensation already started; sign in again",
                )
            try:
                await transition_ai_provider_auth(
                    db,
                    owner_user_id=owner_user_id,
                    provider=provider,
                    auth_type=provider_auth_type,
                    auth_ref=None,
                    auth_metadata=metadata,
                    credential=AuthCredentialWrite(
                        profile=attempt.auth_profile,
                        kind=provider_auth_type,
                        plaintext=payload_text,
                        metadata=metadata,
                    ),
                    keep_oauth_attempt_id=attempt.id,
                )
            except OAuthCredentialClaimConflict as exc:
                raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
            await db.flush()
            await db.refresh(provider)
            response = await self._response_builder(db, provider)
            terminal_oauth_attempt(
                "committed",
                receipt=response.model_dump(mode="json", exclude_none=True),
            ).apply(attempt)
            await db.commit()
            return response

    async def fail_attempt(
        self,
        attempt_id: UUID,
        *,
        expected_claim_id: str | None = None,
    ) -> None:
        try:
            async with self._session_factory() as db:
                _provider, attempt = await self._lock_attempt_by_id(db, attempt_id=attempt_id)
                if attempt.status not in {"pending", "polling", "exchanging"}:
                    await db.rollback()
                    return
                if expected_claim_id is not None and attempt.poll_claim_id != expected_claim_id:
                    await db.rollback()
                    return
                terminal_oauth_attempt("failed").apply(attempt)
                await db.commit()
        except Exception:
            log.exception("oauth_attempt_failure_state_write_failed attempt_id=%s", attempt_id)

    async def _claim_device_poll(
        self,
        *,
        state_identity: OAuthAttemptStateIdentity,
        owner_user_id: UUID,
        provider_id: str,
    ) -> _DevicePollClaim | UUID | OAuthDevicePollPending | AiProviderResponse:
        async with self._session_factory() as db:
            provider, attempt = await self._lock_attempt_for_state(
                db,
                state_identity=state_identity,
                owner_user_id=owner_user_id,
                provider_id=provider_id,
                flow_kind="device_code",
            )
            replay = oauth_attempt_replay(attempt)
            if replay is not None:
                await db.rollback()
                return replay
            if provider is None or provider.archived_at is not None:
                terminal_oauth_attempt("failed").apply(attempt)
                await db.commit()
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "AI Provider changed after sign-in started",
                )
            if attempt.status == "exchanging":
                if self._exchange_is_stale(attempt):
                    attempt_id = attempt.id
                    attempt.exchange_started_at = datetime.now(UTC)
                    await db.commit()
                    return attempt_id
                await db.rollback()
                return OAuthDevicePollPending(1)
            now = datetime.now(UTC)
            if attempt.status == "polling" and not self._poll_is_stale(attempt, now=now):
                await db.rollback()
                return OAuthDevicePollPending(1)
            if attempt.status not in {"pending", "polling"}:
                await db.rollback()
                raise HTTPException(status.HTTP_409_CONFLICT, "OAuth completion is not pending")
            try:
                await self._validate_attempt_fence(db, provider=provider, attempt=attempt)
            except HTTPException:
                terminal_oauth_attempt("failed").apply(attempt)
                await db.commit()
                raise
            flow_payload = oauth_attempt_flow_payload(attempt)
            interval = flow_payload.get("poll_interval_seconds")
            retry_after = min(max(interval, 1), 30) if isinstance(interval, int) else 5
            claim_id = secrets.token_hex(16)
            attempt.status = "polling"
            attempt.poll_claim_id = claim_id
            attempt.exchange_started_at = now
            claim = _DevicePollClaim(
                attempt_id=attempt.id,
                claim_id=claim_id,
                oauth_provider=attempt.oauth_provider,
                device_auth_id=str(flow_payload.get("device_auth_id") or ""),
                user_code=str(flow_payload.get("user_code") or ""),
                retry_after_seconds=retry_after,
            )
            await db.commit()
            return claim

    async def _release_device_poll(self, claim: _DevicePollClaim) -> None:
        async with self._session_factory() as db:
            _provider, attempt = await self._lock_attempt_by_id(db, attempt_id=claim.attempt_id)
            if attempt.status == "polling" and attempt.poll_claim_id == claim.claim_id:
                attempt.status = "pending"
                attempt.poll_claim_id = None
                attempt.exchange_started_at = None
                await db.commit()
                return
            await db.rollback()

    async def _persist_device_poll_success(
        self,
        claim: _DevicePollClaim,
        *,
        authorization_code: str,
        code_verifier: str,
    ) -> UUID:
        async with self._session_factory() as db:
            provider, attempt = await self._lock_attempt_by_id(db, attempt_id=claim.attempt_id)
            if provider is None or provider.archived_at is not None:
                terminal_oauth_attempt("failed").apply(attempt)
                await db.commit()
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "AI Provider changed after sign-in started",
                )
            if attempt.status != "polling" or attempt.poll_claim_id != claim.claim_id:
                if attempt.status == "exchanging":
                    attempt_id = attempt.id
                    await db.rollback()
                    return attempt_id
                await db.rollback()
                raise HTTPException(status.HTTP_409_CONFLICT, "OAuth device poll lost its fence")
            try:
                await self._validate_attempt_fence(db, provider=provider, attempt=attempt)
            except HTTPException:
                terminal_oauth_attempt("failed").apply(attempt)
                await db.commit()
                raise
            flow_payload = oauth_attempt_flow_payload(attempt)
            flow_payload.update(
                {
                    "authorization_code": authorization_code,
                    "code_verifier": code_verifier,
                }
            )
            self._store_flow_payload(attempt, flow_payload)
            attempt.status = "exchanging"
            attempt.poll_claim_id = None
            attempt.exchange_started_at = datetime.now(UTC)
            attempt_id = attempt.id
            await db.commit()
            return attempt_id

    async def _persist_compensation_or_revoke(
        self,
        *,
        owner_user_id: UUID,
        provider_id: str,
        oauth_provider: str,
        attempt_id: UUID,
        revocable: tuple[str, str],
    ) -> OAuthRevokeTombstoneRef:
        try:
            return await self._persist_compensation_once(
                owner_user_id=owner_user_id,
                provider_id=provider_id,
                oauth_provider=oauth_provider,
                attempt_id=attempt_id,
                revocable=revocable,
            )
        except Exception as first_error:
            log.exception(
                "oauth_compensation_initial_commit_failed attempt_id=%s",
                attempt_id,
            )
            revoke_error: Exception | None = None
            try:
                await revoke_exchanged_token(
                    oauth_provider=oauth_provider,
                    token=revocable[0],
                    token_type=revocable[1],
                )
            except Exception as exc:  # noqa: BLE001 - durable retry remains mandatory.
                revoke_error = exc
                log.exception(
                    "oauth_compensation_synchronous_revoke_failed attempt_id=%s",
                    attempt_id,
                )
            try:
                await self._persist_compensation_once(
                    owner_user_id=owner_user_id,
                    provider_id=provider_id,
                    oauth_provider=oauth_provider,
                    attempt_id=attempt_id,
                    revocable=revocable,
                )
            except Exception as retry_error:
                if revoke_error is not None:
                    log.critical(
                        "oauth_compensation_revoke_and_durable_retry_failed attempt_id=%s",
                        attempt_id,
                        exc_info=retry_error,
                    )
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE,
                    "OAuth token could not be durably protected; sign in again",
                ) from retry_error
            # The token was synchronously revoked (or queued after a revoke error),
            # so it must never be installed as the user's credential.
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "OAuth token protection was recovered; sign in again",
            ) from first_error

    async def _persist_compensation_once(
        self,
        *,
        owner_user_id: UUID,
        provider_id: str,
        oauth_provider: str,
        attempt_id: UUID,
        revocable: tuple[str, str],
    ) -> OAuthRevokeTombstoneRef:
        from app.services.ai_provider_auth_transition import enqueue_oauth_revoke_tombstone

        async with self._session_factory() as db:
            await lock_ai_provider_owner(db, owner_user_id)
            tombstone = await enqueue_oauth_revoke_tombstone(
                db,
                owner_user_id=owner_user_id,
                provider_id=provider_id,
                oauth_provider=oauth_provider,
                revocable=revocable,
                oauth_attempt_id=attempt_id,
            )
            if tombstone is None:  # pragma: no cover - non-null input invariant
                raise RuntimeError("OAuth compensation token was not persisted")
            await db.commit()
            return tombstone

    async def _lock_attempt_for_state(
        self,
        db: AsyncSession,
        *,
        state_identity: OAuthAttemptStateIdentity,
        owner_user_id: UUID,
        provider_id: str,
        flow_kind: OAuthFlowKind,
    ) -> tuple[AiProvider | None, AiProviderOAuthAttempt]:
        identity = await load_oauth_attempt(
            db,
            state_identity=state_identity,
            owner_user_id=owner_user_id,
            provider_id=provider_id,
            flow_kind=flow_kind,
        )
        await lock_ai_provider_owner(db, owner_user_id)
        provider = (
            await db.execute(
                select(AiProvider)
                .where(
                    AiProvider.id == identity.provider_row_id,
                    AiProvider.owner_user_id == owner_user_id,
                    AiProvider.provider_id == identity.provider_id,
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        attempt = await load_oauth_attempt(
            db,
            state_identity=state_identity,
            owner_user_id=owner_user_id,
            provider_id=provider_id,
            flow_kind=flow_kind,
            for_update=True,
        )
        return provider, attempt

    async def _lock_attempt_by_id(
        self,
        db: AsyncSession,
        *,
        attempt_id: UUID,
        owner_user_id: UUID | None = None,
    ) -> tuple[AiProvider | None, AiProviderOAuthAttempt]:
        identity = await db.get(AiProviderOAuthAttempt, attempt_id)
        if identity is None or (
            owner_user_id is not None and identity.owner_user_id != owner_user_id
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "OAuth attempt not found")
        await lock_ai_provider_owner(db, identity.owner_user_id)
        provider = (
            await db.execute(
                select(AiProvider)
                .where(
                    AiProvider.id == identity.provider_row_id,
                    AiProvider.owner_user_id == identity.owner_user_id,
                    AiProvider.provider_id == identity.provider_id,
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        attempt = (
            await db.execute(
                select(AiProviderOAuthAttempt)
                .where(AiProviderOAuthAttempt.id == attempt_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one()
        return provider, attempt

    async def _validate_attempt_fence(
        self,
        db: AsyncSession,
        *,
        provider: AiProvider,
        attempt: AiProviderOAuthAttempt,
    ) -> None:
        try:
            validate_codex_oauth_provider_shape(provider)
        except HTTPException as exc:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "AI Provider changed after sign-in started",
            ) from exc
        current_payload = (
            await db.execute(
                select(AiProviderAuthPayload)
                .where(
                    AiProviderAuthPayload.owner_user_id == attempt.owner_user_id,
                    AiProviderAuthPayload.provider_id == attempt.provider_id,
                    AiProviderAuthPayload.auth_profile == attempt.auth_profile,
                    AiProviderAuthPayload.archived_at.is_(None),
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        current_revision = (
            current_payload.credential_revision if current_payload is not None else None
        )
        if current_revision != attempt.base_credential_revision:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "AI Provider credentials changed after this sign-in started",
            )

    @staticmethod
    def _store_flow_payload(attempt: AiProviderOAuthAttempt, payload: dict[str, JsonValue]) -> None:
        attempt.encrypted_flow_payload, attempt.flow_payload_nonce = encrypt(
            json.dumps(payload, separators=(",", ":"), sort_keys=True)
        )

    @staticmethod
    def _exchange_is_stale(attempt: AiProviderOAuthAttempt) -> bool:
        return (
            attempt.status == "exchanging"
            and attempt.exchange_started_at is not None
            and attempt.exchange_started_at
            <= datetime.now(UTC) - timedelta(seconds=OAUTH_EXCHANGE_STALE_SECONDS)
        )

    @staticmethod
    def _poll_is_stale(attempt: AiProviderOAuthAttempt, *, now: datetime) -> bool:
        return (
            attempt.exchange_started_at is None
            or attempt.exchange_started_at
            <= now - timedelta(seconds=OAUTH_DEVICE_POLL_LEASE_SECONDS)
        )


def oauth_attempt_state_identity(state_value: str) -> OAuthAttemptStateIdentity:
    decoded = decode_oauth_state(state_value)
    try:
        flow_id = UUID(str(decoded.get("flow_id") or ""))
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid OAuth state") from exc
    if not isinstance(decoded.get("fence"), str):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid OAuth state")
    return OAuthAttemptStateIdentity(
        flow_id=flow_id,
        state_sha256=hashlib.sha256(state_value.encode()).hexdigest(),
    )


async def load_oauth_attempt(
    db: AsyncSession,
    *,
    state_identity: OAuthAttemptStateIdentity,
    owner_user_id: UUID,
    provider_id: str,
    flow_kind: OAuthFlowKind,
    for_update: bool = False,
) -> AiProviderOAuthAttempt:
    statement = select(AiProviderOAuthAttempt).where(
        AiProviderOAuthAttempt.flow_id == state_identity.flow_id,
        AiProviderOAuthAttempt.owner_user_id == owner_user_id,
        AiProviderOAuthAttempt.provider_id == provider_id,
        AiProviderOAuthAttempt.flow_kind == flow_kind,
        AiProviderOAuthAttempt.state_sha256 == state_identity.state_sha256,
    )
    if for_update:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    attempt = (await db.execute(statement)).scalar_one_or_none()
    if attempt is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth state does not match this user")
    if attempt.status != "committed" and attempt.expires_at < datetime.now(UTC):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth state expired")
    return attempt


def oauth_attempt_flow_payload(attempt: AiProviderOAuthAttempt) -> dict[str, JsonValue]:
    if attempt.encrypted_flow_payload is None or attempt.flow_payload_nonce is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Stored OAuth attempt is invalid")
    try:
        payload = _JSON_OBJECT_ADAPTER.validate_json(
            decrypt(attempt.encrypted_flow_payload, attempt.flow_payload_nonce)
        )
    except Exception as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, "Stored OAuth attempt is invalid") from exc
    return payload


def oauth_attempt_replay(attempt: AiProviderOAuthAttempt) -> AiProviderResponse | None:
    if attempt.status != "committed":
        return None
    if not isinstance(attempt.receipt, dict):
        raise HTTPException(status.HTTP_409_CONFLICT, "Stored OAuth receipt is invalid")
    try:
        return AiProviderResponse.model_validate(attempt.receipt)
    except ValidationError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, "Stored OAuth receipt is invalid") from exc


def oauth_config_for(oauth_provider: str) -> dict[str, JsonValue]:
    if oauth_provider != CODEX_OAUTH_PROVIDER:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"AI Provider OAuth config not found for {oauth_provider}",
        )
    config = dict(CODEX_OAUTH_CONFIG)
    raw = settings.ai_provider_oauth_config_json.strip()
    if raw:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "AI Provider OAuth config is invalid JSON",
            ) from exc
        if not isinstance(data, dict):
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "AI Provider OAuth config must be an object",
            )
        configured = data.get(oauth_provider)
        if configured is not None and not isinstance(configured, dict):
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                f"AI Provider OAuth config for {oauth_provider} must be an object",
            )
        if isinstance(configured, dict):
            config = merge_oauth_config(config, configured)
    return config


def merge_oauth_config(
    base: Mapping[str, JsonValue], override: Mapping[str, JsonValue]
) -> dict[str, JsonValue]:
    merged = {**base, **override}
    base_extra = base.get("extra_authorize_params")
    override_extra = override.get("extra_authorize_params")
    if isinstance(base_extra, dict) or isinstance(override_extra, dict):
        merged["extra_authorize_params"] = {
            **(base_extra if isinstance(base_extra, dict) else {}),
            **(override_extra if isinstance(override_extra, dict) else {}),
        }
    return merged


def required_oauth_config(config: Mapping[str, JsonValue], key: str, oauth_provider: str) -> str:
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            f"AI Provider OAuth config for {oauth_provider} is missing {key}",
        )
    return value.strip()


def encode_oauth_state(payload: dict[str, object]) -> str:
    ciphertext, nonce = encrypt(json.dumps(payload, separators=(",", ":"), sort_keys=True))
    return f"v1.{_base64url(nonce)}.{_base64url(ciphertext)}"


def decode_oauth_state(state_value: str) -> dict:
    try:
        version, nonce, ciphertext = state_value.split(".", 2)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid OAuth state") from exc
    if version != "v1":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid OAuth state")
    try:
        plaintext = decrypt(_base64url_decode_bytes(ciphertext), _base64url_decode_bytes(nonce))
        decoded = json.loads(plaintext)
    except Exception as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid OAuth state") from exc
    if not isinstance(decoded, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid OAuth state")
    return decoded


def validate_oauth_url(value: str, label: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{label} must be an https URL")


def validate_redirect_uri(value: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme == "https" and parsed.netloc:
        return
    if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
        return
    if (
        settings.environment == "development"
        and parsed.scheme == "http"
        and _url_origin(parsed) in _development_oauth_redirect_origins()
    ):
        return
    raise HTTPException(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        "redirect_uri must be https or loopback http",
    )


def revocable_token_from_token_response(response: httpx.Response) -> tuple[str, str] | None:
    data = token_response_json(response)
    refresh_token = data.get("refresh_token")
    if isinstance(refresh_token, str) and refresh_token:
        return refresh_token, "refresh_token"
    access_token = data.get("access_token")
    if isinstance(access_token, str) and access_token:
        return access_token, "access_token"
    return None


async def revoke_exchanged_token(
    *,
    oauth_provider: str,
    token: str,
    token_type: str,
) -> None:
    if oauth_provider != CODEX_OAUTH_PROVIDER:
        raise RuntimeError("unsupported OAuth revoke provider")
    request = {"token": token, "token_type_hint": token_type}
    if token_type == "refresh_token":
        request["client_id"] = CODEX_OAUTH_CLIENT_ID
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(CODEX_OAUTH_REVOKE_URL, json=request)
    if response.status_code >= 400:
        raise RuntimeError(f"OAuth synchronous revoke failed with {response.status_code}")


async def _exchange_authorization_code(
    client: httpx.AsyncClient,
    *,
    oauth_provider: str,
    config: dict,
    client_id: str,
    flow_payload: dict,
) -> httpx.Response:
    token_url = required_oauth_config(config, "token_url", oauth_provider)
    validate_oauth_url(token_url, "token_url")
    form = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": str(flow_payload.get("authorization_code") or ""),
        "redirect_uri": str(flow_payload.get("redirect_uri") or ""),
        "code_verifier": str(flow_payload.get("code_verifier") or ""),
    }
    client_secret = str(config.get("client_secret") or "")
    if client_secret:
        form["client_secret"] = client_secret
    response = await client.post(token_url, data=form)
    if response.status_code >= 400:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "OAuth token exchange failed")
    return response


async def _codex_auth_profile_payload(
    client: httpx.AsyncClient,
    config: dict,
    response: httpx.Response,
    profile: str,
) -> str:
    token_data = token_response_json(response)
    access_token = _required_token_field(token_data, "access_token")
    refresh_token = _required_token_field(token_data, "refresh_token")
    raw_id_token = token_data.get("id_token")
    id_token = raw_id_token if isinstance(raw_id_token, str) and raw_id_token else None
    api_key = await _obtain_codex_api_key(client, config, id_token) if id_token else None
    claims = _jwt_auth_claims(id_token or access_token)
    account_id = claims.get("chatgpt_account_id")
    tokens = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "account_id": account_id if isinstance(account_id, str) and account_id else None,
    }
    if id_token:
        tokens["id_token"] = id_token
    auth_json = {
        "auth_mode": "chatgpt",
        "tokens": tokens,
        "last_refresh": datetime.now(UTC).isoformat(),
    }
    if api_key:
        auth_json["OPENAI_API_KEY"] = api_key
    content = json.dumps(auth_json, indent=2)
    envelope = {
        "schemaVersion": 1,
        "kind": "local_agent_profile",
        "tool": "codex",
        "profile": profile,
        "importedAt": datetime.now(UTC).isoformat(),
        "files": [
            {
                "logicalName": "auth.json",
                "sourcePath": "codex-oauth",
                "targetStrategy": "adapter_default",
                "sourceKind": "file",
                "content": content,
                "mode": 0o600,
                "size": len(content.encode()),
            }
        ],
    }
    return json.dumps(envelope, separators=(",", ":"))


def token_response_json(response: httpx.Response) -> dict:
    try:
        data = response.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "OAuth token response was not JSON",
        ) from exc
    if not isinstance(data, dict):
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "OAuth token response had invalid shape")
    return data


def _required_token_field(data: dict, field: str) -> str:
    value = data.get(field)
    if not isinstance(value, str) or not value:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"OAuth token response missing {field}",
        )
    return value


async def _obtain_codex_api_key(
    client: httpx.AsyncClient,
    config: dict,
    id_token: str,
) -> str | None:
    token_url = required_oauth_config(config, "token_url", CODEX_OAUTH_PROVIDER)
    client_id = required_oauth_config(config, "client_id", CODEX_OAUTH_PROVIDER)
    response = await client.post(
        token_url,
        data={
            "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
            "client_id": client_id,
            "requested_token": "openai-api-key",
            "subject_token": id_token,
            "subject_token_type": "urn:ietf:params:oauth:token-type:id_token",
        },
    )
    if response.status_code >= 400:
        return None
    access_token = token_response_json(response).get("access_token")
    return access_token if isinstance(access_token, str) and access_token else None


def _jwt_auth_claims(jwt: str) -> dict:
    parts = jwt.split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1]
    padding = "=" * (-len(payload) % 4)
    try:
        decoded = base64.urlsafe_b64decode(f"{payload}{padding}".encode())
        claims = json.loads(decoded)
    except (binascii.Error, ValueError, json.JSONDecodeError):
        return {}
    if not isinstance(claims, dict):
        return {}
    auth_claims = claims.get("https://api.openai.com/auth")
    return auth_claims if isinstance(auth_claims, dict) else {}


def _base64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _base64url_decode_bytes(raw: str) -> bytes:
    padding = "=" * ((4 - len(raw) % 4) % 4)
    return base64.urlsafe_b64decode(f"{raw}{padding}")


def _url_origin(parsed) -> str | None:
    if not parsed.scheme or not parsed.netloc or parsed.username or parsed.password:
        return None
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def _development_oauth_redirect_origins() -> set[str]:
    allowed: set[str] = set()
    for origin in [settings.web_origin, *settings.cors_origins]:
        parsed = urlparse(origin)
        if parsed.scheme == "http" and (parsed_origin := _url_origin(parsed)):
            allowed.add(parsed_origin)
    return allowed


def _codex_upstream_http_exception(exc: CodexOAuthUpstreamError) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS
        if exc.retry_after is not None
        else status.HTTP_503_SERVICE_UNAVAILABLE
        if exc.unavailable
        else status.HTTP_502_BAD_GATEWAY,
        str(exc),
        headers={"Retry-After": str(exc.retry_after)} if exc.retry_after is not None else None,
    )


__all__ = [
    "AiProviderOAuthAttemptService",
    "CODEX_OAUTH_PROVIDER",
    "CODEX_OPENAI_BASE_URL",
    "OAuthDevicePollPending",
    "OAUTH_DEVICE_POLL_LEASE_SECONDS",
    "OAUTH_EXCHANGE_STALE_SECONDS",
    "fail_active_oauth_attempts",
    "fence_oauth_attempt_for_revoke",
    "oauth_config_for",
    "oauth_revoke_candidate_ids",
    "purge_expired_oauth_records",
    "required_oauth_config",
    "validate_codex_oauth_provider_shape",
    "validate_oauth_url",
    "validate_redirect_uri",
]
