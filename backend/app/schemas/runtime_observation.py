from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, field_validator, model_validator

from app.models.api_key import RUNTIME_DEPLOYMENT_KEY_SCOPES
from app.schemas.platform import PlatformOwner
from app.schemas.runtime_observed import (
    HostedRuntimeObservedAppliedV2,
    HostedRuntimeObservedBootV1,
    HostedRuntimeObservedCliV1,
    HostedRuntimeObservedProviderPayload,
    HostedRuntimeObservedSupervisorV1,
    HostedRuntimeObservedSystemdV1,
    RuntimeObservedStatus,
)

RUNTIME_OBSERVATION_WRITE_SCOPE = "runtime-observations:write"


class RuntimeObservationRequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class RuntimeObservationEventV2(RuntimeObservationRequestModel):
    """Strict v2 companion event; deliberately separate from the frozen v1 wire model."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, strict=True)

    schema_version: Literal["clawdi.hostedRuntimeObserved.v2"] = Field(alias="schemaVersion")
    reported_at: datetime = Field(alias="reportedAt")
    runtime_mode: Literal["hosted"] = Field(alias="runtimeMode")
    status: RuntimeObservedStatus
    active_cli_version: str | None = Field(
        alias="activeCliVersion",
        min_length=1,
        max_length=200,
    )
    applied: HostedRuntimeObservedAppliedV2
    boot: HostedRuntimeObservedBootV1 | None
    cli: HostedRuntimeObservedCliV1 | None
    systemd: HostedRuntimeObservedSystemdV1 | None = None
    supervisor: HostedRuntimeObservedSupervisorV1 | None = None
    providers: dict[str, HostedRuntimeObservedProviderPayload] | None = None
    error: str | None = Field(default=None, max_length=4000)
    converge_error: str | None = Field(alias="convergeError", default=None, max_length=4000)
    truncated: Literal[False] | None = None
    apply_receipt_id: str = Field(alias="applyReceiptId", min_length=16, max_length=128)
    boot_nonce: str = Field(alias="bootNonce", min_length=16, max_length=128)
    boot_session_id: str = Field(alias="bootSessionId", min_length=1, max_length=128)
    sequence: int = Field(ge=1, le=9_007_199_254_740_991)
    event_id: str = Field(alias="eventId", min_length=1, max_length=128)
    captured_at: datetime = Field(alias="capturedAt")

    @field_validator("reported_at", "captured_at", mode="before")
    @classmethod
    def validate_timestamp(cls, value: object) -> datetime:
        if isinstance(value, datetime):
            parsed = value
        elif isinstance(value, str):
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError as exc:
                raise ValueError("runtime observation timestamps must be ISO 8601") from exc
        else:
            raise ValueError("runtime observation timestamps must be ISO 8601 strings")
        if parsed.tzinfo is None:
            raise ValueError("runtime observation timestamps must include a timezone")
        return parsed.astimezone(UTC)

    @model_validator(mode="after")
    def validate_companion_identity(self) -> RuntimeObservationEventV2:
        if self.applied.generation < 1:
            raise ValueError("runtime observation generation must be at least 1")
        if self.reported_at != self.captured_at:
            raise ValueError("reportedAt must equal capturedAt")
        return self


class RuntimeDeploymentKeyCreate(RuntimeObservationRequestModel):
    owner: PlatformOwner
    label: str = Field(min_length=1, max_length=200)
    environment_id: UUID = Field(alias="environmentId")
    deployment_id: str = Field(alias="deploymentId", min_length=1, max_length=200)
    scopes: list[str] = Field(default_factory=lambda: list(RUNTIME_DEPLOYMENT_KEY_SCOPES))

    @field_validator("scopes")
    @classmethod
    def validate_scopes(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("scopes cannot be empty")
        if len(value) != len(set(value)):
            raise ValueError("scopes cannot contain duplicates")
        unknown = sorted(set(value) - set(RUNTIME_DEPLOYMENT_KEY_SCOPES))
        if unknown:
            raise ValueError(f"scopes exceed runtime deployment ceiling: {', '.join(unknown)}")
        if RUNTIME_OBSERVATION_WRITE_SCOPE not in value:
            raise ValueError(f"scopes must include {RUNTIME_OBSERVATION_WRITE_SCOPE}")
        return [scope for scope in RUNTIME_DEPLOYMENT_KEY_SCOPES if scope in value]


class RuntimeEnvironmentRetireRequest(RuntimeObservationRequestModel):
    expected_deployment_binding: str = Field(
        alias="expectedDeploymentBinding",
        min_length=1,
        max_length=200,
    )
    retirement_id: str = Field(alias="retirementId", min_length=1, max_length=200)


class RuntimeObservationConsumerRequest(RuntimeObservationRequestModel):
    pass


class RuntimeObservationConsumerAckRequest(RuntimeObservationConsumerRequest):
    cursor: str = Field(min_length=1, max_length=2000)


class RuntimeApplyIdentityRequest(RuntimeObservationRequestModel):
    generation: int = Field(ge=1)
    manifest_etag: str = Field(alias="manifestETag", min_length=1, max_length=1024)
    apply_receipt_id: str = Field(alias="applyReceiptId", min_length=16, max_length=128)
    boot_nonce: str = Field(alias="bootNonce", min_length=16, max_length=128)


class RuntimeObservationReadRequest(RuntimeObservationRequestModel):
    expected_apply_identity: RuntimeApplyIdentityRequest = Field(alias="expectedApplyIdentity")
    after_cursor: str = Field(alias="afterCursor", min_length=1, max_length=2000)
    limit: int = Field(default=100, ge=1, le=500)


class RuntimeObservationIngestResponse(RuntimeObservationRequestModel):
    event_id: str = Field(alias="eventId")
    stream_position: int = Field(alias="streamPosition")
    outcome: Literal[
        "accepted_head_created",
        "accepted_head_advanced",
        "accepted_non_advance_sequence",
        "accepted_non_advance_captured_at",
        "duplicate_replay",
    ]


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
    environment_reference: str = Field(alias="environmentReference")
    expected_deployment_binding: str = Field(alias="expectedDeploymentBinding")
    retirement_id: str = Field(alias="retirementId")
    retired_at: datetime = Field(alias="retiredAt")
    final_cursor: str = Field(alias="finalCursor")
    final_session_high_water_marks: list[RuntimeSessionHighWaterMark] = Field(
        alias="finalSessionHighWaterMarks"
    )


class RuntimeSessionHighWaterMark(RuntimeObservationResponseModel):
    boot_session_id: str = Field(alias="bootSessionId")
    sequence: int


RuntimeObservationProblemDetail = dict[str, Any]
