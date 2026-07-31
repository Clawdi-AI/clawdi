from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_provider import (
    AiProviderOAuthAttempt,
    AiProviderOAuthRevokeTombstone,
)

OAuthAttemptTerminalStatus = Literal["committed", "failed"]

OAUTH_TERMINAL_RETENTION = timedelta(days=30)
OAUTH_RETENTION_BATCH_SIZE = 100


@dataclass(frozen=True, slots=True)
class OAuthAttemptTerminalTransition:
    status: OAuthAttemptTerminalStatus
    completed_at: datetime
    receipt: dict | None

    def apply(self, attempt: AiProviderOAuthAttempt) -> None:
        attempt.status = self.status
        attempt.completed_at = self.completed_at
        attempt.receipt = self.receipt
        attempt.encrypted_flow_payload = None
        attempt.flow_payload_nonce = None

    def update_values(self) -> dict[str, object]:
        return {
            "status": self.status,
            "completed_at": self.completed_at,
            "receipt": self.receipt,
            "encrypted_flow_payload": None,
            "flow_payload_nonce": None,
        }


@dataclass(frozen=True, slots=True)
class OAuthRetentionPurgeResult:
    attempts: int
    tombstones: int


def terminal_oauth_attempt(
    status: OAuthAttemptTerminalStatus,
    *,
    completed_at: datetime | None = None,
    receipt: dict | None = None,
) -> OAuthAttemptTerminalTransition:
    if status == "committed" and receipt is None:
        raise ValueError("committed OAuth attempts require a receipt")
    return OAuthAttemptTerminalTransition(
        status=status,
        completed_at=completed_at or datetime.now(UTC),
        receipt=receipt,
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
                .order_by(
                    AiProviderOAuthAttempt.completed_at,
                    AiProviderOAuthAttempt.id,
                )
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


__all__ = [
    "OAUTH_RETENTION_BATCH_SIZE",
    "OAUTH_TERMINAL_RETENTION",
    "OAuthAttemptTerminalTransition",
    "OAuthRetentionPurgeResult",
    "purge_expired_oauth_records",
    "terminal_oauth_attempt",
]
