"""CAS of Cloud metadata from explicitly trusted native-ownership attestations."""

from datetime import UTC, datetime, timedelta
from typing import Literal, NoReturn
from uuid import UUID

from fastapi import HTTPException
from pydantic import JsonValue, TypeAdapter
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.models.hosted_runtime import HostedRuntimeState
from app.models.runtime_observation import (
    RUNTIME_ENVIRONMENT_ACTIVE,
    V2RuntimeEnvironmentFence,
)
from app.models.session import AgentEnvironment
from app.schemas.provider_environment_repair import (
    NativeEnvironmentProof,
    ProviderEnvironmentInventory,
    ProviderEnvironmentRepairReceipt,
    ProviderEnvironmentRestore,
    RepairApplyIdentity,
    RepairBinding,
)
from app.schemas.runtime import validate_hosted_runtime_desired_state
from app.schemas.runtime_observation import (
    RuntimeDriftBindingRequest,
    RuntimeDriftSummaryReadRequest,
)
from app.services.ai_provider_connection_ownership import (
    qualified_applied_runtime_evidence,
)
from app.services.app_setting_registry import (
    SUPPORTED_CUSTOM_PROVIDER_CLI_VERSIONS_SPEC,
)
from app.services.app_settings import resolve_app_setting
from app.services.platform_contract import platform_request_hash
from app.services.runtime_drift_summary import read_runtime_drift_summaries
from app.services.sync_events import queue_provider_runtime_manifest_changed


def _conflict(detail: str) -> NoReturn:
    raise HTTPException(409, detail)


async def _provider(db: AsyncSession, owner_id: UUID, provider_id: str) -> tuple[AiProvider, str]:
    provider = await db.scalar(
        select(AiProvider)
        .where(
            AiProvider.owner_user_id == owner_id,
            AiProvider.provider_id == provider_id,
            AiProvider.archived_at.is_(None),
        )
        .with_for_update()
    )
    if provider is None:
        raise HTTPException(404, "Provider not found")
    environment = provider.runtime_env_name
    if (
        provider.configuration_mode not in {"custom", "connection"}
        or provider.auth_type != "api_key"
        or provider.auth_ref is not None
        or not environment
    ):
        _conflict("Provider has no restorable managed credential environment")
    return provider, environment


async def _revision(db: AsyncSession, provider: AiProvider) -> str:
    credentials = (
        await db.scalars(
            select(AiProviderAuthPayload)
            .where(
                AiProviderAuthPayload.owner_user_id == provider.owner_user_id,
                AiProviderAuthPayload.provider_id == provider.provider_id,
                AiProviderAuthPayload.archived_at.is_(None),
            )
            .order_by(AiProviderAuthPayload.id)
        )
    ).all()
    if not credentials or any(row.kind != "api_key" for row in credentials):
        _conflict("Provider credential authority is unavailable")
    return platform_request_hash(
        TypeAdapter(dict[str, JsonValue]).validate_python(
            {
                "provider": {
                    "id": str(provider.id),
                    "incarnation": str(provider.incarnation_id),
                    "owner": str(provider.owner_user_id),
                    "provider_id": provider.provider_id,
                    "updated_at": provider.updated_at.isoformat(),
                    "environment": provider.runtime_env_name,
                    "auth_type": provider.auth_type,
                    "auth_ref": provider.auth_ref,
                    "auth_metadata": provider.auth_metadata,
                    "mode": provider.configuration_mode,
                    "base_url": provider.base_url,
                    "api_mode": provider.api_mode,
                    "label": provider.label,
                    "type": provider.type,
                    "native_provider": provider.native_provider,
                    "native_variant": provider.native_variant,
                    "capabilities": provider.capabilities,
                    "models": provider.models,
                    "managed_by": provider.managed_by,
                },
                "credentials": [
                    {
                        "id": str(row.id),
                        "revision": row.credential_revision,
                        "profile": row.auth_profile,
                        "kind": row.kind,
                        "source": row.source,
                    }
                    for row in credentials
                ],
            }
        )
    )


async def environment_repair_inventory(
    db: AsyncSession,
    *,
    owner_id: UUID,
    provider_id: str,
) -> ProviderEnvironmentInventory:
    provider, environment = await _provider(db, owner_id, provider_id)
    owned_states = (
        select(HostedRuntimeState)
        .join(AgentEnvironment, AgentEnvironment.id == HostedRuntimeState.environment_id)
        .where(AgentEnvironment.user_id == owner_id, AgentEnvironment.archived_at.is_(None))
    )
    valid_fence = (
        (V2RuntimeEnvironmentFence.state == RUNTIME_ENVIRONMENT_ACTIVE)
        & (V2RuntimeEnvironmentFence.owner_id == owner_id)
        & (V2RuntimeEnvironmentFence.deployment_id == HostedRuntimeState.deployment_id)
    )
    references = or_(
        *(
            HostedRuntimeState.runtimes[name]["provider_ids"].contains([provider_id])
            for name in ("hermes", "openclaw", "codex")
        )
    )
    unsupported = await db.scalar(
        owned_states.outerjoin(
            V2RuntimeEnvironmentFence,
            V2RuntimeEnvironmentFence.environment_id == HostedRuntimeState.environment_id,
        )
        .where(references, or_(V2RuntimeEnvironmentFence.environment_id.is_(None), ~valid_fence))
        .limit(1)
    )
    if unsupported is not None:
        _conflict("Provider has a consumer outside verified V2 ownership")
    states = list(
        (
            await db.scalars(
                owned_states.join(
                    V2RuntimeEnvironmentFence,
                    V2RuntimeEnvironmentFence.environment_id == HostedRuntimeState.environment_id,
                )
                .where(valid_fence)
                .order_by(HostedRuntimeState.environment_id)
                .limit(101)
            )
        ).all()
    )
    if len(states) > 100:
        _conflict("Provider repair requires a bounded complete V2 owner inventory")
    # Ingest and retirement use these same fences; pin boot identity until commit.
    await db.scalars(
        select(V2RuntimeEnvironmentFence)
        .where(
            V2RuntimeEnvironmentFence.environment_id.in_([state.environment_id for state in states])
        )
        .order_by(V2RuntimeEnvironmentFence.environment_id)
        .with_for_update()
    )
    active = []
    selected = {}
    for state in states:
        try:
            runtimes = {
                name: validate_hosted_runtime_desired_state(value)
                for name, value in state.runtimes.items()
            }
        except ValueError:
            _conflict("Runtime consumer configuration is invalid")
        primary = [
            (name, value)
            for name, value in runtimes.items()
            if name in {"hermes", "openclaw"} and value.enabled
        ]
        if len(primary) != 1:
            _conflict("Runtime primary binding is unavailable")
        selected[state.environment_id] = primary[0]
        active.append(state)
    if not active:
        _conflict("No V2 native ownership can attest this provider")
    summaries = await read_runtime_drift_summaries(
        db,
        RuntimeDriftSummaryReadRequest(
            bindings=[
                RuntimeDriftBindingRequest(
                    environmentId=row.environment_id, deploymentId=row.deployment_id
                )
                for row in active
            ]
        ),
        expected_generations={
            row.environment_id: row.apply_generation or row.generation for row in active
        },
        require_unique_active_head=True,
    )
    versions = await resolve_app_setting(db, SUPPORTED_CUSTOM_PROVIDER_CLI_VERSIONS_SPEC)
    bindings = []
    for state, summary in zip(active, summaries.items, strict=True):
        qualified = qualified_applied_runtime_evidence(
            summary, state, versions=versions, observed_at=summaries.observed_at
        )
        if qualified is None:
            _conflict("Provider repair requires unambiguous qualified runtime identity")
        head, _applied = qualified
        generation = state.apply_generation or state.generation
        name, runtime = selected[state.environment_id]
        runtime_name: Literal["hermes", "openclaw"] = "hermes" if name == "hermes" else "openclaw"
        bindings.append(
            RepairBinding(
                environment_id=state.environment_id,
                deployment_id=state.deployment_id,
                instance_id=state.instance_id,
                generation=generation,
                push_generation=state.generation,
                runtime=runtime_name,
                cli_package_spec=state.cli_package_spec,
                provider_ids=runtime.provider_ids,
                apply_identity=RepairApplyIdentity.model_validate(
                    head.runtime_identity.model_dump(by_alias=True)
                ),
            )
        )
    return ProviderEnvironmentInventory(
        provider_id=provider_id,
        provider_uuid=provider.id,
        incarnation_id=provider.incarnation_id,
        revision=await _revision(db, provider),
        runtime_env_name=environment,
        bindings=bindings,
    )


def native_repair_boundary(revision: str, proofs: list[NativeEnvironmentProof]) -> str:
    return platform_request_hash(
        {
            "revision": revision,
            "proofs": [
                item.model_dump(mode="json", by_alias=True)
                for item in sorted(proofs, key=lambda item: str(item.binding.environment_id))
            ],
        }
    )


async def restore_provider_environment(
    db: AsyncSession,
    *,
    owner_id: UUID,
    body: ProviderEnvironmentRestore,
) -> ProviderEnvironmentRepairReceipt:
    inventory = await environment_repair_inventory(
        db, owner_id=owner_id, provider_id=body.provider_id
    )
    if (
        inventory.revision != body.expected_revision
        or inventory.runtime_env_name != body.expected_env_name
    ):
        raise HTTPException(412, "Provider metadata or credential revision changed")
    now = datetime.now(UTC)
    if not now - timedelta(minutes=5) <= body.observed_at <= now:
        _conflict("Native ownership attestation expired")
    proof_bindings = [proof.binding for proof in body.proofs]
    if (
        len({proof.environment_id for proof in proof_bindings}) != len(proof_bindings)
        or sorted(proof_bindings, key=lambda row: str(row.environment_id)) != inventory.bindings
        or native_repair_boundary(inventory.revision, body.proofs) != body.expected_boundary
    ):
        raise HTTPException(412, "Native ownership or runtime binding changed")
    owned = [proof for proof in body.proofs if proof.native_env_name is not None]
    if not owned or any(
        proof.native_env_name != body.native_env_name
        or not proof.journal_sha256
        or not proof.config_sha256
        for proof in owned
    ):
        _conflict("Native credential owners do not agree on the restoration target")
    if any(
        proof.native_env_name is None
        and (
            body.provider_id in proof.binding.provider_ids
            or (
                proof.native_state != "stopped"
                and proof.applied_push_generation != proof.binding.push_generation
            )
        )
        for proof in body.proofs
    ):
        _conflict("An unowned consumer has not completed the current unbound checkpoint")
    # Preserve the existing owner-wide credential-environment reservation policy.
    conflict = await db.scalar(
        select(AiProvider.id)
        .where(
            AiProvider.owner_user_id == owner_id,
            AiProvider.id != inventory.provider_uuid,
            AiProvider.archived_at.is_(None),
            AiProvider.configuration_mode != "native",
            (AiProvider.runtime_env_name == body.native_env_name)
            | (AiProvider.auth_ref == f"env:{body.native_env_name}"),
        )
        .limit(1)
    )
    if conflict is not None:
        _conflict("Native credential environment belongs to another provider")
    provider, environment = await _provider(db, owner_id, body.provider_id)
    changed = environment != body.native_env_name
    if changed:
        environment = body.native_env_name
        provider.runtime_env_name = environment
        await db.flush()
        await db.refresh(provider, attribute_names=["updated_at"])
        await queue_provider_runtime_manifest_changed(db, owner_id, provider.provider_id)
    return ProviderEnvironmentRepairReceipt(
        status="restored" if changed else "already_current",
        provider_id=provider.provider_id,
        provider_uuid=provider.id,
        incarnation_id=provider.incarnation_id,
        previous_env_name=inventory.runtime_env_name,
        runtime_env_name=environment,
        before_revision=inventory.revision,
        after_revision=await _revision(db, provider),
        boundary=body.expected_boundary,
    )
