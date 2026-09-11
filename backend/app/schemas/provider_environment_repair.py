"""Workload-only attestation for restoring an existing native credential identity."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator

from app.schemas.platform import PlatformMutationBody
from app.schemas.runtime_observation import RuntimeApplyIdentityRequest

PROVIDER_ENVIRONMENT_REPAIR_SCOPE = "platform:provider-environment:repair"
ENV_PATTERN = r"^[A-Z][A-Z0-9_]{0,127}$"
DIGEST_PATTERN = r"^[a-f0-9]{64}$"


class RepairApplyIdentity(RuntimeApplyIdentityRequest):
    boot_session_id: str = Field(alias="bootSessionId", min_length=1, max_length=128)


class RepairBinding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    environment_id: UUID
    deployment_id: str = Field(min_length=1, max_length=200)
    instance_id: str = Field(min_length=1, max_length=200)
    generation: int = Field(ge=1)
    push_generation: int = Field(ge=1)
    runtime: Literal["hermes", "openclaw"]
    cli_package_spec: str = Field(min_length=1, max_length=200)
    provider_ids: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(max_length=2)
    apply_identity: RepairApplyIdentity


class ProviderEnvironmentInventory(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider_id: str
    provider_uuid: UUID
    incarnation_id: UUID
    revision: str = Field(pattern=DIGEST_PATTERN)
    runtime_env_name: str = Field(pattern=ENV_PATTERN)
    bindings: list[RepairBinding] = Field(max_length=100)


class NativeEnvironmentProof(BaseModel):
    model_config = ConfigDict(extra="forbid")
    binding: RepairBinding
    incus_instance_uuid: UUID
    native_state: Literal["running", "stopped"]
    applied_push_generation: int = Field(ge=1)
    hosted_spec_revision: str = Field(pattern=DIGEST_PATTERN)
    journal_sha256: str | None = Field(default=None, pattern=DIGEST_PATTERN)
    config_sha256: str | None = Field(default=None, pattern=DIGEST_PATTERN)
    native_env_name: str | None = Field(default=None, pattern=ENV_PATTERN)


class ProviderEnvironmentRepairIntent(PlatformMutationBody):
    provider_id: str = Field(pattern=r"^[a-z][a-z0-9._-]{1,62}$")
    expected_revision: str = Field(pattern=DIGEST_PATTERN)
    expected_boundary: str = Field(pattern=DIGEST_PATTERN)
    expected_env_name: str = Field(pattern=ENV_PATTERN)
    native_env_name: str = Field(pattern=ENV_PATTERN)
    operator_fingerprint: str = Field(pattern=DIGEST_PATTERN)
    operator_ref: str = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=1, max_length=200)

    @field_validator("reason")
    @classmethod
    def nonempty_reason(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("reason must not be blank")
        return value


class ProviderEnvironmentRestore(ProviderEnvironmentRepairIntent):
    observed_at: AwareDatetime
    proofs: list[NativeEnvironmentProof] = Field(min_length=1, max_length=100)


class ProviderEnvironmentRepairReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["restored", "already_current"]
    provider_id: str
    provider_uuid: UUID
    incarnation_id: UUID
    previous_env_name: str
    runtime_env_name: str
    before_revision: str
    after_revision: str
    boundary: str


class ProviderEnvironmentVerifierGrant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: str = Field(pattern=DIGEST_PATTERN)
    action: Literal["grant", "revoke"]
    reason: str = Field(min_length=1, max_length=200)


class ProviderEnvironmentVerifierAccess(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_id: str
    credential_id: UUID
    public_key_fingerprint: str
    status: str
    revision: str
    granted: bool
