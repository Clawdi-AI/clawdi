from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, field_validator, model_validator

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
RuntimeObservationIngestOutcome = Literal[
    "accepted_head_created",
    "accepted_head_advanced",
    "accepted_non_advance_sequence",
    "accepted_non_advance_captured_at",
    "duplicate_replay",
]


class RuntimeObservationRequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


AgentPluginObservedStatus = Literal["installed", "failed", "unknown"]
AgentPluginObservationErrorCode = Literal[
    "reconcile_failed",
    "receipt_missing",
    "receipt_unreadable",
    "receipt_mismatch",
]


class HostedRuntimeObservedAgentPluginV1(RuntimeObservationRequestModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, strict=True)

    installation_id: str = Field(alias="installationId", min_length=1, max_length=200)
    name: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[a-z0-9][a-z0-9.-]{0,63}$",
    )
    version: str = Field(
        min_length=1,
        max_length=256,
        pattern=(
            r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
            r"(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
            r"(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?"
            r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
        ),
    )
    content_digest: str = Field(
        alias="contentDigest",
        pattern=r"^sha256-tree-v1:[0-9a-f]{64}$",
    )
    source_revision: str = Field(alias="sourceRevision", pattern=r"^[0-9a-f]{64}$")
    generation: int = Field(ge=1, le=9_007_199_254_740_991)
    status: AgentPluginObservedStatus
    error_code: AgentPluginObservationErrorCode | None = Field(
        alias="errorCode",
        default=None,
    )

    @field_validator("installation_id")
    @classmethod
    def validate_installation_id(cls, value: str) -> str:
        try:
            parsed = UUID(value)
        except ValueError as exc:
            raise ValueError("installationId must be a canonical UUID") from exc
        if str(parsed) != value:
            raise ValueError("installationId must be a canonical UUID")
        return value

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        if "--" in value or ".." in value or value[-1] in {".", "-"}:
            raise ValueError("name must be a canonical Agent Plugin name")
        return value

    @model_validator(mode="after")
    def validate_status_error(self) -> HostedRuntimeObservedAgentPluginV1:
        if self.status == "installed" and self.error_code is not None:
            raise ValueError("installed Agent Plugin observation cannot include errorCode")
        if self.status == "failed" and self.error_code != "reconcile_failed":
            raise ValueError("failed Agent Plugin observation requires reconcile_failed")
        if self.status == "unknown" and self.error_code not in {
            "receipt_missing",
            "receipt_unreadable",
            "receipt_mismatch",
        }:
            raise ValueError("unknown Agent Plugin observation requires a receipt error code")
        return self


class HostedRuntimeObservedAgentPluginsV1(RuntimeObservationRequestModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, strict=True)

    schema_version: Literal[1] = Field(alias="schemaVersion")
    installations: list[HostedRuntimeObservedAgentPluginV1] = Field(max_length=128)

    @field_validator("installations")
    @classmethod
    def validate_installations(
        cls,
        value: list[HostedRuntimeObservedAgentPluginV1],
    ) -> list[HostedRuntimeObservedAgentPluginV1]:
        names = [installation.name for installation in value]
        installation_ids = [installation.installation_id for installation in value]
        if len(names) != len(set(names)) or len(installation_ids) != len(set(installation_ids)):
            raise ValueError("Agent Plugin observations must have unique identities")
        if names != sorted(names, key=lambda name: name.encode("utf-8")):
            raise ValueError("Agent Plugin observations must be sorted by name")
        return value

    def validate_applied_identity(self, applied: HostedRuntimeObservedAppliedV2) -> None:
        for installation in self.installations:
            if installation.status == "failed":
                # A failed apply never becomes the applied state, so a failure
                # naming the exact applied identity is a replay; a same-generation
                # attempt with a *different* revision is a newer (e.g. plugin-only)
                # manifest that did not bump the runtime generation.
                if installation.generation < applied.generation or (
                    installation.generation == applied.generation
                    and installation.source_revision == applied.source_revision
                ):
                    raise ValueError("failed Agent Plugin observation is stale")
                continue
            if (
                installation.generation != applied.generation
                or installation.source_revision != applied.source_revision
            ):
                raise ValueError("Agent Plugin observation must match applied identity")


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
    agent_plugins: HostedRuntimeObservedAgentPluginsV1 | None = Field(
        alias="agentPlugins",
        default=None,
    )
    error: str | None = Field(default=None, max_length=4000)
    converge_error: str | None = Field(alias="convergeError", default=None, max_length=4000)
    truncated: Literal[False] | None = None
    generation: int | None = Field(default=None, ge=1, le=9_007_199_254_740_991)
    manifest_etag: str | None = Field(
        alias="manifestETag",
        default=None,
        min_length=1,
        max_length=128,
    )
    apply_receipt_id: str = Field(alias="applyReceiptId", min_length=16, max_length=128)
    boot_nonce: str = Field(alias="bootNonce", min_length=16, max_length=128)
    boot_session_id: str = Field(alias="bootSessionId", min_length=1, max_length=128)
    successor_boot_session_id: str | None = Field(
        alias="successorBootSessionId",
        default=None,
        min_length=1,
        max_length=128,
    )
    predecessor_boot_session_id: str | None = Field(
        alias="predecessorBootSessionId",
        default=None,
        min_length=1,
        max_length=128,
    )
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
        if (self.generation is None) != (self.manifest_etag is None):
            raise ValueError("generation and manifestETag must be present together")
        if self.generation is not None and self.generation != self.applied.generation:
            raise ValueError("generation must match applied.generation")
        if self.reported_at != self.captured_at:
            raise ValueError("reportedAt must equal capturedAt")
        if self.predecessor_boot_session_id == self.boot_session_id:
            raise ValueError("predecessorBootSessionId must differ from bootSessionId")
        if self.successor_boot_session_id == self.boot_session_id:
            raise ValueError("successorBootSessionId must differ from bootSessionId")
        if self.agent_plugins is not None:
            self.agent_plugins.validate_applied_identity(self.applied)
        return self


class RuntimeDeploymentKeyCreate(RuntimeObservationRequestModel):
    owner: PlatformOwner
    label: str = Field(min_length=1, max_length=200)
    environment_id: UUID = Field(alias="environmentId")
    deployment_id: str = Field(alias="deploymentId", min_length=1, max_length=200)


class RuntimeEnvironmentRetireRequest(RuntimeObservationRequestModel):
    expected_deployment_binding: str = Field(
        alias="expectedDeploymentBinding",
        min_length=1,
        max_length=200,
    )
    retirement_id: str = Field(alias="retirementId", min_length=1, max_length=200)


class RuntimeStateCleanupRequest(RuntimeObservationRequestModel):
    environment_reference: UUID = Field(alias="environmentReference")
    expected_deployment_binding: str = Field(
        alias="expectedDeploymentBinding",
        min_length=1,
        max_length=200,
    )
    retirement_id: str = Field(alias="retirementId", min_length=1, max_length=200)
    cleanup_id: str = Field(alias="cleanupId", min_length=1, max_length=200)


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
    outcome: RuntimeObservationIngestOutcome


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


class RuntimeStateCleanupReceipt(RuntimeObservationResponseModel):
    schema_version: Literal["clawdi.runtimeStateCleanupReceipt.v1"] = Field(alias="schemaVersion")
    environment_reference: UUID = Field(alias="environmentReference")
    expected_deployment_binding: str = Field(alias="expectedDeploymentBinding")
    retirement_id: str = Field(alias="retirementId")
    cleanup_id: str = Field(alias="cleanupId")
    runtime_state_status: Literal["absent"] = Field(alias="runtimeStateStatus")
    cleaned_at: datetime = Field(alias="cleanedAt")


class RuntimeSessionHighWaterMark(RuntimeObservationResponseModel):
    boot_session_id: str = Field(alias="bootSessionId")
    sequence: int


RuntimeObservationProblemDetail = dict[str, Any]
