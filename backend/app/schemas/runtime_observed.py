from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

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


class _StrictObservedWireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class HostedRuntimeObservedManifestV1(_StrictObservedWireModel):
    etag: str | None = Field(max_length=1024)
    last_good_exists: bool = Field(alias="lastGoodExists")


class HostedRuntimeObservedChannelsV1(_StrictObservedWireModel):
    etag: str | None = Field(max_length=1024)


class HostedRuntimeObservedBootV1(_StrictObservedWireModel):
    status: RuntimeObservedStatus
    mode: str = Field(max_length=100)
    stage: str = Field(max_length=100)
    timestamp: str = Field(max_length=100)
    active_generation: int | None = Field(alias="activeGeneration", default=None, ge=0)
    instance_id: str | None = Field(alias="instanceId", default=None, max_length=200)
    enabled_runtimes: list[str] = Field(alias="enabledRuntimes", max_length=20)
    errors: list[str] = Field(max_length=100)


class HostedRuntimeObservedCliUpdateV1(_StrictObservedWireModel):
    status: str | None = Field(default=None, max_length=100)
    package_spec: str | None = Field(alias="packageSpec", default=None, max_length=200)
    registry: str | None = Field(default=None, max_length=1000)
    active_path: str | None = Field(alias="activePath", default=None, max_length=2000)
    active_target: str | None = Field(alias="activeTarget", default=None, max_length=2000)
    version: str | None = Field(default=None, max_length=200)


class HostedRuntimeObservedWatchV1(_StrictObservedWireModel):
    status: Literal["applied", "not_modified", "error"] | None = None
    stage: str | None = Field(default=None, max_length=100)
    etag: str | None = Field(default=None, max_length=1024)
    channels_etag: str | None = Field(alias="channelsEtag", default=None, max_length=1024)
    generation: int | None = Field(default=None, ge=0)
    instance_id: str | None = Field(alias="instanceId", default=None, max_length=200)
    self_reexec: bool | None = Field(alias="selfReexec", default=None)
    error: str | None = Field(default=None, max_length=4000)
    errors: list[str] = Field(default_factory=list, max_length=100)
    cli_update: HostedRuntimeObservedCliUpdateV1 | None = Field(
        alias="cliUpdate",
        default=None,
    )


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


class HostedRuntimeObservedV1(_StrictObservedWireModel):
    schema_version: Literal["clawdi.hostedRuntimeObserved.v1"] = Field(alias="schemaVersion")
    reported_at: datetime = Field(alias="reportedAt")
    runtime_mode: Literal["hosted"] = Field(alias="runtimeMode")
    status: RuntimeObservedStatus
    manifest: HostedRuntimeObservedManifestV1
    channels: HostedRuntimeObservedChannelsV1
    boot: HostedRuntimeObservedBootV1 | None
    watch: HostedRuntimeObservedWatchV1 | None
    cli: HostedRuntimeObservedCliV1 | None
    systemd: HostedRuntimeObservedSystemdV1 | None = None
    supervisor: HostedRuntimeObservedSupervisorV1 | None = None
    providers: dict[str, HostedRuntimeObservedProviderPayload] | None = None
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


class RuntimeObservedConfigSummaryResponse(BaseModel):
    observed_at: datetime | None = None
    observed_config_generation: int | None = None
    observed_manifest_etag: str | None = None


class RuntimeObservedConfigResponse(RuntimeObservedConfigSummaryResponse):
    diagnostics: HostedRuntimeObservedV1 | None = None
