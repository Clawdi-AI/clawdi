from __future__ import annotations

import re
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.api_scopes import RUNTIME_MCP_SCOPES
from app.schemas.runtime import (
    HostedEgressEngine,
    HostedEgressProfiles,
    HostedRuntimeCompanions,
    HostedRuntimeDesiredState,
    HostedRuntimeLiveSync,
    HostedRuntimeLocale,
    HostedRuntimeMcp,
    HostedRuntimeRecovery,
    HostedRuntimeSecretValues,
    HostedRuntimeSkills,
    HostedRuntimeSystem,
    HostedRuntimeTools,
    validate_clawdi_cli_package_spec,
    validate_hosted_runtime_secret_values,
)

PlatformOwnerKind = Literal["clerk", "partner_tenant"]
PLATFORM_RUNTIME_KEY_SCOPES = RUNTIME_MCP_SCOPES

_CLERK_REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_PARTNER_TENANT_REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
_SUPPORTED_HOSTED_RUNTIMES = {"hermes", "openclaw"}


class PlatformOwner(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: PlatformOwnerKind
    ref: str = Field(min_length=1, max_length=255)

    @model_validator(mode="after")
    def _validate_ref(self) -> PlatformOwner:
        pattern = _CLERK_REF_RE if self.kind == "clerk" else _PARTNER_TENANT_REF_RE
        if pattern.fullmatch(self.ref) is None:
            raise ValueError(f"invalid {self.kind} owner ref")
        if self.kind == "clerk" and len(self.ref) > 200:
            raise ValueError("clerk owner ref must be at most 200 characters")
        return self


class PlatformMutationBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    owner: PlatformOwner


class PlatformAgentCreate(PlatformMutationBody):
    agent_id: UUID
    machine_id: str = Field(min_length=1, max_length=200)
    machine_name: str = Field(min_length=1, max_length=200)
    default_name: str | None = Field(
        default=None,
        min_length=1,
        max_length=200,
        description="Canonical Agent name supplied by the owning control plane.",
    )
    agent_type: str = Field(min_length=1, max_length=50)
    agent_version: str | None = Field(default=None, max_length=50)
    os_name: str = Field(default="linux", min_length=1, max_length=50)


class PlatformApiKeyCreate(PlatformMutationBody):
    label: str = Field(min_length=1, max_length=200)
    environment_id: UUID
    scopes: list[str] = Field(default_factory=lambda: list(PLATFORM_RUNTIME_KEY_SCOPES))

    @field_validator("scopes")
    @classmethod
    def _validate_scopes(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("scopes cannot be empty")
        if len(value) != len(set(value)):
            raise ValueError("scopes cannot contain duplicates")
        unknown = sorted(set(value) - set(PLATFORM_RUNTIME_KEY_SCOPES))
        if unknown:
            raise ValueError(f"scopes exceed platform runtime ceiling: {', '.join(unknown)}")
        return [scope for scope in PLATFORM_RUNTIME_KEY_SCOPES if scope in value]


class PlatformRuntimeStateUpsert(PlatformMutationBody):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    deployment_id: str = Field(min_length=1, max_length=200)
    instance_id: str = Field(min_length=1, max_length=200)
    generation: int = Field(ge=0)
    apply_generation: int | None = Field(default=None, ge=1)
    cli_package_spec: str = Field(min_length=1, max_length=200)
    locale: HostedRuntimeLocale
    system: HostedRuntimeSystem
    egress_engine: HostedEgressEngine | None = None
    companions: HostedRuntimeCompanions | None = None
    runtimes: dict[str, HostedRuntimeDesiredState]
    live_sync: HostedRuntimeLiveSync
    recovery: HostedRuntimeRecovery
    egress_profiles: HostedEgressProfiles | None = None
    mcp: HostedRuntimeMcp | None = None
    skills: HostedRuntimeSkills | None = None
    tools: HostedRuntimeTools
    secret_values: HostedRuntimeSecretValues = Field(alias="secretValues")

    @field_validator("cli_package_spec")
    @classmethod
    def _validate_cli_package_spec(cls, value: str) -> str:
        return validate_clawdi_cli_package_spec(value)

    @field_validator("secret_values")
    @classmethod
    def _validate_secret_values(cls, value: HostedRuntimeSecretValues) -> HostedRuntimeSecretValues:
        return validate_hosted_runtime_secret_values(value)

    @field_validator("runtimes")
    @classmethod
    def _validate_runtimes(
        cls,
        value: dict[str, HostedRuntimeDesiredState],
    ) -> dict[str, HostedRuntimeDesiredState]:
        if not value:
            raise ValueError("runtimes cannot be empty")
        if "channels" in value:
            raise ValueError("channels are not runtime desired state")
        unknown = sorted(set(value) - _SUPPORTED_HOSTED_RUNTIMES)
        if unknown:
            raise ValueError(f"unsupported runtime desired state: {', '.join(unknown)}")
        if len(value) != 1:
            raise ValueError("runtimes must contain exactly one enabled runtime")
        return value


class PlatformRuntimeStateResponse(BaseModel):
    environment_id: UUID
    deployment_id: str
    instance_id: str
    generation: int
    apply_generation: int | None = None


class RuntimeSourceAuthorityResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, strict=True)

    environment_id: UUID = Field(alias="environmentId")
    deployment_id: str = Field(alias="deploymentId", min_length=1, max_length=200)
    instance_id: str = Field(alias="instanceId", min_length=1, max_length=200)
    source_revision: str = Field(alias="sourceRevision", pattern=r"^[0-9a-f]{64}$")
    etag: str = Field(pattern=r'^"sha256:[0-9a-f]{64}"$')
