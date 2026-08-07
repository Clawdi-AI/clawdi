from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

from pydantic import JsonValue

from app.models.ai_provider import AiProviderOAuthAttempt

OAuthAttemptTerminalStatus = Literal["committed", "failed"]

OAUTH_TERMINAL_RETENTION = timedelta(days=30)
OAUTH_RETENTION_BATCH_SIZE = 100


@dataclass(frozen=True, slots=True)
class OAuthAttemptTerminalTransition:
    status: OAuthAttemptTerminalStatus
    completed_at: datetime
    receipt: dict[str, JsonValue] | None

    def apply(self, attempt: AiProviderOAuthAttempt) -> None:
        attempt.status = self.status
        attempt.completed_at = self.completed_at
        attempt.receipt = self.receipt
        attempt.encrypted_flow_payload = None
        attempt.flow_payload_nonce = None
        attempt.poll_claim_id = None

    def update_values(self) -> dict[str, object]:
        return {
            "status": self.status,
            "completed_at": self.completed_at,
            "receipt": self.receipt,
            "encrypted_flow_payload": None,
            "flow_payload_nonce": None,
            "poll_claim_id": None,
        }


@dataclass(frozen=True, slots=True)
class OAuthRetentionPurgeResult:
    attempts: int
    tombstones: int


def terminal_oauth_attempt(
    status: OAuthAttemptTerminalStatus,
    *,
    completed_at: datetime | None = None,
    receipt: dict[str, JsonValue] | None = None,
) -> OAuthAttemptTerminalTransition:
    if status == "committed" and receipt is None:
        raise ValueError("committed OAuth attempts require a receipt")
    return OAuthAttemptTerminalTransition(
        status=status,
        completed_at=completed_at or datetime.now(UTC),
        receipt=receipt,
    )


__all__ = [
    "OAUTH_RETENTION_BATCH_SIZE",
    "OAUTH_TERMINAL_RETENTION",
    "OAuthAttemptTerminalTransition",
    "OAuthRetentionPurgeResult",
    "terminal_oauth_attempt",
]
