from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    RootModel,
    field_validator,
    model_validator,
)

RuntimeObservedStatus = Literal["ok", "error", "unknown"]
AgentPluginObservedStatus = Literal["installed", "failed", "unknown"]
AgentPluginObservationErrorCode = Literal[
    "reconcile_failed",
    "receipt_missing",
    "receipt_unreadable",
    "receipt_mismatch",
]


class _StrictObservedWireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class HostedRuntimeObservedBootV1(_StrictObservedWireModel):
    status: RuntimeObservedStatus
    mode: str = Field(max_length=100)
    stage: str = Field(max_length=100)
    timestamp: str = Field(max_length=100)
    active_generation: int | None = Field(alias="activeGeneration", default=None, ge=0)
    instance_id: str | None = Field(alias="instanceId", default=None, max_length=200)
    enabled_runtimes: list[str] = Field(alias="enabledRuntimes", max_length=20)
    errors: list[str] = Field(max_length=100)


class HostedRuntimeObservedCliV1(_StrictObservedWireModel):
    status: str | None = Field(default=None, max_length=100)
    source: str | None = Field(default=None, max_length=100)
    package_spec: str | None = Field(alias="packageSpec", default=None, max_length=200)
    registry: str | None = Field(default=None, max_length=1000)
    active_path: str | None = Field(alias="activePath", default=None, max_length=2000)
    active_target: str | None = Field(alias="activeTarget", default=None, max_length=2000)
    version: str | None = Field(default=None, max_length=200)


class HostedRuntimeObservedSystemdUnitV1(_StrictObservedWireModel):
    scope: Literal["system", "user"]
    name: str = Field(max_length=300)
    active_state: str = Field(alias="activeState", max_length=100)
    sub_state: str = Field(alias="subState", max_length=100)
    status: RuntimeObservedStatus
    error: str | None = Field(default=None, max_length=1000)


class HostedRuntimeObservedSystemdV1(_StrictObservedWireModel):
    status: RuntimeObservedStatus
    unit_count: int = Field(alias="unitCount", ge=0, le=30)
    units: list[HostedRuntimeObservedSystemdUnitV1] = Field(max_length=30)


class HostedRuntimeObservedSupervisorProgramV1(_StrictObservedWireModel):
    name: str = Field(max_length=300)
    state: str = Field(max_length=100)
    status: RuntimeObservedStatus
    description: str | None = Field(default=None, max_length=1000)


class HostedRuntimeObservedSupervisorV1(_StrictObservedWireModel):
    status: RuntimeObservedStatus
    programs: list[HostedRuntimeObservedSupervisorProgramV1] = Field(max_length=100)


class HostedRuntimeObservedProviderPayload(RootModel[dict[str, JsonValue]]):
    model_config = ConfigDict(strict=True)

    @model_validator(mode="after")
    def validate_known_scalars(self) -> HostedRuntimeObservedProviderPayload:
        payload = self.root
        status = payload.get("status")
        if status is not None and status not in {"ok", "error", "unknown", "not_configured"}:
            raise ValueError("provider status is invalid")
        for key in ("configured", "secretAvailable"):
            value = payload.get(key)
            if value is not None and not isinstance(value, bool):
                raise ValueError(f"provider {key} must be a boolean or null")
        reasons = payload.get("reasons")
        if reasons is not None and (
            not isinstance(reasons, list) or any(not isinstance(reason, str) for reason in reasons)
        ):
            raise ValueError("provider reasons must be an array of strings")
        return self


class HostedRuntimeObservedAppliedV2(_StrictObservedWireModel):
    etag: str = Field(min_length=1, max_length=1024)
    source_revision: str = Field(alias="sourceRevision", pattern=r"^[0-9a-f]{64}$")
    generation: int = Field(ge=0)
    instance_id: str = Field(alias="instanceId", min_length=1, max_length=200)
    applied_provider_ids: list[str] = Field(alias="appliedProviderIds", max_length=100)

    @field_validator("applied_provider_ids")
    @classmethod
    def validate_applied_provider_ids(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("appliedProviderIds must be unique")
        return value


class HostedRuntimeObservedAgentPluginV1(_StrictObservedWireModel):
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


class HostedRuntimeObservedAgentPluginsV1(_StrictObservedWireModel):
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
                if installation.generation < applied.generation or (
                    installation.generation == applied.generation
                    and installation.source_revision != applied.source_revision
                ):
                    raise ValueError("failed Agent Plugin observation is stale")
                continue
            if (
                installation.generation != applied.generation
                or installation.source_revision != applied.source_revision
            ):
                raise ValueError("Agent Plugin observation must match applied identity")


class HostedRuntimeObservedV2(_StrictObservedWireModel):
    schema_version: Literal["clawdi.hostedRuntimeObserved.v2"] = Field(alias="schemaVersion")
    reported_at: datetime = Field(alias="reportedAt")
    runtime_mode: Literal["hosted"] = Field(alias="runtimeMode")
    status: RuntimeObservedStatus
    active_cli_version: str | None = Field(
        alias="activeCliVersion",
        min_length=1,
        max_length=200,
    )
    applied: HostedRuntimeObservedAppliedV2 | None
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
    truncated: bool | None = None

    @field_validator("reported_at", mode="before")
    @classmethod
    def validate_reported_at(cls, value: object) -> datetime:
        if isinstance(value, datetime):
            parsed = value
        elif isinstance(value, str):
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError as exc:
                raise ValueError("reportedAt must be an ISO 8601 timestamp") from exc
        else:
            raise ValueError("reportedAt must be an ISO 8601 timestamp string")
        if parsed.tzinfo is None:
            raise ValueError("reportedAt must include a timezone")
        return parsed.astimezone(UTC)

    @model_validator(mode="after")
    def validate_agent_plugin_identity(self) -> HostedRuntimeObservedV2:
        if self.agent_plugins is None:
            return self
        if self.applied is None:
            raise ValueError("Agent Plugin observation requires applied identity")
        self.agent_plugins.validate_applied_identity(self.applied)
        return self


HostedRuntimeObserved = HostedRuntimeObservedV2


class RuntimeObservedConfigSummaryResponse(BaseModel):
    observed_at: datetime | None = None
    observed_config_generation: int | None = None
    observed_manifest_etag: str | None = None
    observed_source_revision: str | None = None


class RuntimeObservedConfigResponse(RuntimeObservedConfigSummaryResponse):
    diagnostics: HostedRuntimeObservedV2 | None = None
