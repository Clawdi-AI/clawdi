from __future__ import annotations

import asyncio
import logging
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from uuid import UUID

import httpx
from cryptography.exceptions import InvalidTag
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.ai_provider import AiProviderOAuthRevokeTombstone
from app.services.ai_provider_oauth_attempt import (
    fence_oauth_attempt_for_revoke,
    oauth_revoke_candidate_ids,
    purge_expired_oauth_records,
)
from app.services.codex_oauth import CODEX_OAUTH_CLIENT_ID
from app.services.vault_crypto import decrypt

log = logging.getLogger(__name__)

CODEX_OAUTH_REVOKE_URL = "https://auth.openai.com/oauth/revoke"
OAUTH_REVOKE_CLAIM_LEASE_SECONDS = 60
OAUTH_REVOKE_BACKOFF_CAP_SECONDS = 15 * 60
OAUTH_REVOKE_ATTEMPT_STALE_SECONDS = 30 * 60
OAUTH_RETENTION_INTERVAL_SECONDS = 60 * 60


class OAuthRevokeAdapterError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ClaimedOAuthRevoke:
    tombstone_id: UUID
    claim_id: str
    oauth_provider: str
    token_type: str
    token: str = field(repr=False)
    attempt_count: int


async def claim_oauth_revoke_tombstone(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    lease_seconds: int = OAUTH_REVOKE_CLAIM_LEASE_SECONDS,
    attempt_stale_seconds: int = OAUTH_REVOKE_ATTEMPT_STALE_SECONDS,
) -> ClaimedOAuthRevoke | None:
    claimed_at = now or datetime.now(UTC)
    stale_before = claimed_at - timedelta(seconds=lease_seconds)
    attempt_stale_before = claimed_at - timedelta(seconds=attempt_stale_seconds)
    candidate_ids = await oauth_revoke_candidate_ids(
        db,
        claimed_at=claimed_at,
        tombstone_stale_before=stale_before,
        attempt_stale_before=attempt_stale_before,
    )
    for candidate_id in candidate_ids:
        claim = await _claim_oauth_revoke_candidate(
            db,
            tombstone_id=candidate_id,
            claimed_at=claimed_at,
            stale_before=stale_before,
            attempt_stale_before=attempt_stale_before,
        )
        if claim is not None:
            return claim
    return None


async def _claim_oauth_revoke_candidate(
    db: AsyncSession,
    *,
    tombstone_id: UUID,
    claimed_at: datetime,
    stale_before: datetime,
    attempt_stale_before: datetime,
) -> ClaimedOAuthRevoke | None:
    identity = await db.get(AiProviderOAuthRevokeTombstone, tombstone_id)
    if identity is None:
        return None
    attempt_id = identity.oauth_attempt_id
    identity_pending_due = identity.status == "pending" and (
        identity.next_attempt_at is None or identity.next_attempt_at <= claimed_at
    )
    identity_processing_stale = (
        identity.status == "processing"
        and identity.claimed_at is not None
        and identity.claimed_at <= stale_before
    )
    if not await fence_oauth_attempt_for_revoke(
        db,
        owner_user_id=identity.owner_user_id,
        attempt_id=attempt_id,
        pending_due=identity_pending_due,
        processing_stale=identity_processing_stale,
        claimed_at=claimed_at,
        attempt_stale_before=attempt_stale_before,
    ):
        return None

    tombstone = (
        await db.execute(
            select(AiProviderOAuthRevokeTombstone)
            .where(AiProviderOAuthRevokeTombstone.id == tombstone_id)
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if tombstone is None:
        return None
    pending_due = tombstone.status == "pending" and (
        tombstone.next_attempt_at is None or tombstone.next_attempt_at <= claimed_at
    )
    processing_stale = (
        tombstone.status == "processing"
        and tombstone.claimed_at is not None
        and tombstone.claimed_at <= stale_before
    )
    if not pending_due and not processing_stale:
        return None
    if tombstone.oauth_attempt_id != attempt_id:
        return None

    if tombstone.encrypted_token is None or tombstone.token_nonce is None:
        _quarantine_oauth_revoke_tombstone(tombstone, "revoke_material_missing")
        return None
    try:
        token = decrypt(tombstone.encrypted_token, tombstone.token_nonce)
    except (InvalidTag, TypeError, UnicodeError, ValueError):
        _quarantine_oauth_revoke_tombstone(tombstone, "revoke_material_corrupt")
        return None
    if not token:
        _quarantine_oauth_revoke_tombstone(tombstone, "revoke_material_corrupt")
        return None
    claim_id = secrets.token_hex(16)
    tombstone.status = "processing"
    tombstone.claim_id = claim_id
    tombstone.claimed_at = claimed_at
    tombstone.attempt_count += 1
    tombstone.last_error = None
    return ClaimedOAuthRevoke(
        tombstone_id=tombstone.id,
        claim_id=claim_id,
        oauth_provider=tombstone.oauth_provider,
        token_type=tombstone.token_type,
        token=token,
        attempt_count=tombstone.attempt_count,
    )


def _quarantine_oauth_revoke_tombstone(
    tombstone: AiProviderOAuthRevokeTombstone,
    error_code: str,
) -> None:
    tombstone.status = "quarantined"
    tombstone.encrypted_token = None
    tombstone.token_nonce = None
    tombstone.next_attempt_at = None
    tombstone.claimed_at = None
    tombstone.claim_id = None
    tombstone.last_error = error_code[:500]


async def record_oauth_revoke_result(
    db: AsyncSession,
    *,
    claim: ClaimedOAuthRevoke,
    revoked: bool,
    error_code: str | None = None,
    now: datetime | None = None,
) -> bool:
    completed_at = now or datetime.now(UTC)
    if revoked:
        values = {
            "status": "revoked",
            "encrypted_token": None,
            "token_nonce": None,
            "next_attempt_at": None,
            "claimed_at": None,
            "claim_id": None,
            "last_error": None,
        }
    else:
        backoff_seconds = min(
            2 ** min(max(claim.attempt_count - 1, 0), 10),
            OAUTH_REVOKE_BACKOFF_CAP_SECONDS,
        )
        values = {
            "status": "pending",
            "next_attempt_at": completed_at + timedelta(seconds=backoff_seconds),
            "claimed_at": None,
            "claim_id": None,
            "last_error": (error_code or "revoke_failed")[:500],
        }
    updated_id = await db.scalar(
        update(AiProviderOAuthRevokeTombstone)
        .where(
            AiProviderOAuthRevokeTombstone.id == claim.tombstone_id,
            AiProviderOAuthRevokeTombstone.status == "processing",
            AiProviderOAuthRevokeTombstone.claim_id == claim.claim_id,
        )
        .values(**values)
        .returning(AiProviderOAuthRevokeTombstone.id)
    )
    return updated_id is not None


async def revoke_oauth_token(claim: ClaimedOAuthRevoke) -> None:
    if claim.oauth_provider != "codex":
        raise OAuthRevokeAdapterError("unsupported_oauth_provider")
    request = {
        "token": claim.token,
        "token_type_hint": claim.token_type,
    }
    if claim.token_type == "refresh_token":
        request["client_id"] = CODEX_OAUTH_CLIENT_ID
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(CODEX_OAUTH_REVOKE_URL, json=request)
    except httpx.HTTPError as exc:
        raise OAuthRevokeAdapterError("oauth_revoke_network_error") from exc
    if response.status_code >= 400:
        raise OAuthRevokeAdapterError(f"oauth_revoke_http_{response.status_code}")


class AiProviderOAuthRevokeWorker:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        poll_interval_seconds: float = 1.0,
        retention_interval_seconds: float = OAUTH_RETENTION_INTERVAL_SECONDS,
        revoke: Callable[[ClaimedOAuthRevoke], Awaitable[None]] = revoke_oauth_token,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._poll_interval_seconds = poll_interval_seconds
        self._retention_interval = timedelta(seconds=max(0.0, retention_interval_seconds))
        self._next_retention_at: datetime | None = None
        self._revoke = revoke

    async def run_once(self) -> UUID | None:
        now = datetime.now(UTC)
        retention_due = self._next_retention_at is None or now >= self._next_retention_at
        async with self._sessionmaker() as db:
            purge_result = None
            if retention_due:
                purge_result = await purge_expired_oauth_records(db, now=now)
            claim = await claim_oauth_revoke_tombstone(db)
            if claim is None:
                await db.commit()
                if retention_due:
                    self._next_retention_at = now + self._retention_interval
                if purge_result is not None and (purge_result.attempts or purge_result.tombstones):
                    log.info(
                        "purged expired OAuth records attempts=%s tombstones=%s",
                        purge_result.attempts,
                        purge_result.tombstones,
                    )
                return None
            await db.commit()
        if retention_due:
            self._next_retention_at = now + self._retention_interval
        if purge_result is not None and (purge_result.attempts or purge_result.tombstones):
            log.info(
                "purged expired OAuth records attempts=%s tombstones=%s",
                purge_result.attempts,
                purge_result.tombstones,
            )

        revoked = False
        error_code = None
        try:
            await self._revoke(claim)
            revoked = True
        except Exception as exc:  # noqa: BLE001 - retry state must survive any adapter failure.
            error_code = (
                str(exc) if isinstance(exc, OAuthRevokeAdapterError) else "revoke_adapter_error"
            )

        async with self._sessionmaker() as db:
            recorded = await record_oauth_revoke_result(
                db,
                claim=claim,
                revoked=revoked,
                error_code=error_code,
            )
            await db.commit()
        if not recorded:
            log.info(
                "oauth revoke result ignored after claim changed tombstone_id=%s",
                claim.tombstone_id,
            )
        return claim.tombstone_id

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop_event = stop or asyncio.Event()
        while not stop_event.is_set():
            try:
                tombstone_id = await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - one corrupt row must not stop retry processing.
                log.exception("OAuth revoke worker iteration failed")
                tombstone_id = None
            if tombstone_id is None:
                try:
                    await asyncio.wait_for(
                        stop_event.wait(),
                        timeout=self._poll_interval_seconds,
                    )
                except TimeoutError:
                    pass


__all__ = [
    "AiProviderOAuthRevokeWorker",
    "ClaimedOAuthRevoke",
    "OAuthRevokeAdapterError",
    "claim_oauth_revoke_tombstone",
    "record_oauth_revoke_result",
    "revoke_oauth_token",
]
