from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue


class RuntimeObservationResponseModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class RuntimeObservationApplyIdentityResponse(RuntimeObservationResponseModel):
    generation: int
    manifest_etag: str = Field(alias="manifestETag")
    apply_receipt_id: str = Field(alias="applyReceiptId")
    boot_nonce: str = Field(alias="bootNonce")


class RuntimeObservationIdentityResponse(RuntimeObservationApplyIdentityResponse):
    """Guest-reported identity authenticated by a per-deployment credential.

    This is the protocol's readiness authority, not attestation-bound instance
    identity.
    """

    boot_session_id: str = Field(alias="bootSessionId")


class RuntimeObservationEvidenceReference(RuntimeObservationResponseModel):
    event_id: str = Field(alias="eventId")
    cursor: str


class RuntimeObservationEventResponse(RuntimeObservationResponseModel):
    runtime_identity: RuntimeObservationIdentityResponse = Field(alias="runtimeIdentity")
    sequence: int
    captured_at: datetime = Field(alias="capturedAt")
    received_at: datetime = Field(alias="receivedAt")
    freshness_deadline: datetime = Field(alias="freshnessDeadline")
    evidence_reference: RuntimeObservationEvidenceReference = Field(alias="evidenceReference")
    payload_hash: str = Field(alias="payloadHash")
    health: Literal["ok", "error", "unknown"]
    diagnostics: JsonValue


class RuntimeObservationHeadResponse(RuntimeObservationResponseModel):
    runtime_identity: RuntimeObservationIdentityResponse = Field(alias="runtimeIdentity")
    sequence: int
    captured_at: datetime | None = Field(alias="capturedAt")
    freshness_deadline: datetime | None = Field(alias="freshnessDeadline")
    evidence_reference: RuntimeObservationEvidenceReference = Field(alias="evidenceReference")
    payload_hash: str = Field(alias="payloadHash")
    health: Literal["ok", "error", "unknown"] | None
    state: Literal["active", "retired"]


class RuntimeObservationReadResponse(RuntimeObservationResponseModel):
    environment_id: str = Field(alias="environmentId")
    deployment_id: str = Field(alias="deploymentId")
    consumer_id: str = Field(alias="consumerId")
    expected_apply_identity: RuntimeObservationApplyIdentityResponse = Field(
        alias="expectedApplyIdentity"
    )
    heads: list[RuntimeObservationHeadResponse]
    events: list[RuntimeObservationEventResponse]
    stream_high_water_cursor: str = Field(alias="streamHighWaterCursor")
    next_cursor: str = Field(alias="nextCursor")
    has_more: bool = Field(alias="hasMore")


class RuntimeObservationConsumerResponse(RuntimeObservationResponseModel):
    environment_id: str = Field(alias="environmentId")
    deployment_id: str = Field(alias="deploymentId")
    consumer_id: str = Field(alias="consumerId")
    cursor: str
    acknowledged_at: datetime | None = Field(default=None, alias="acknowledgedAt")


class RuntimeObservationResetBoundary(RuntimeObservationResponseModel):
    cursor: str
    barrier_at: datetime = Field(alias="barrierAt")


class RuntimeObservationConsumerResetResponse(RuntimeObservationConsumerResponse):
    reset_boundary: RuntimeObservationResetBoundary = Field(alias="resetBoundary")
    session_high_water_marks: dict[str, int] = Field(alias="sessionHighWaterMarks")


class RuntimeEnvironmentRetirementReceipt(RuntimeObservationResponseModel):
    retirement_receipt_id: str = Field(alias="retirementReceiptId")
    retirement_id: str = Field(alias="retirementId")
    environment_id: str = Field(alias="environmentId")
    deployment_id: str = Field(alias="deploymentId")
    retired_at: datetime = Field(alias="retiredAt")
    final_cursor: str = Field(alias="finalCursor")
    final_session_high_water_marks: dict[str, int] = Field(alias="finalSessionHighWaterMarks")


RuntimeObservationProblemDetail = dict[str, Any]
