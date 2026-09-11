"""Admission for the one-way, existing-runtime provider ownership handoff."""

from uuid import UUID

from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_provider import AiProvider
from app.models.hosted_runtime import HostedRuntimeState
from app.models.session import AgentEnvironment
from app.schemas.runtime import validate_hosted_runtime_desired_state
from app.schemas.runtime_observation import (
    RuntimeDriftBindingRequest,
    RuntimeDriftSummaryReadRequest,
)
from app.services.app_setting_registry import (
    SUPPORTED_CONNECTION_CLI_VERSIONS_SPEC,
    SUPPORTED_CUSTOM_PROVIDER_CLI_VERSIONS_SPEC,
    AppSettingSpec,
)
from app.services.app_settings import AppSettingUnavailable, resolve_app_setting
from app.services.runtime_drift_summary import read_runtime_drift_summaries
from app.services.runtime_source import expected_runtime_bundle_v2_etag
from app.services.runtime_source_revision import persisted_runtime_source_error


async def require_connection_ownership_migration(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider_id: str,
    versions_spec: AppSettingSpec[list[str]] = SUPPORTED_CONNECTION_CLI_VERSIONS_SPEC,
    allow_unbound: bool = False,
) -> None:
    """The caller holds the provider-owner lock shared by runtime-state mutations."""
    try:
        versions = await resolve_app_setting(db, versions_spec)
    except AppSettingUnavailable as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Connection ownership migration is not enabled"
        ) from exc
    if not versions:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Connection ownership migration is not enabled"
        )
    states = list(
        (
            await db.scalars(
                select(HostedRuntimeState)
                .join(AgentEnvironment, AgentEnvironment.id == HostedRuntimeState.environment_id)
                .where(
                    AgentEnvironment.user_id == owner_user_id,
                    AgentEnvironment.archived_at.is_(None),
                    or_(
                        *(
                            HostedRuntimeState.runtimes[name]["provider_ids"].contains(
                                [provider_id]
                            )
                            for name in ("openclaw", "hermes", "codex")
                        )
                    ),
                )
                .order_by(HostedRuntimeState.environment_id)
                .with_for_update(of=HostedRuntimeState)
            )
        ).all()
    )
    if not states and allow_unbound:
        return
    if not states:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Model ownership transfer requires an existing Hosted connection",
        )
    for state in states:
        for name, value in state.runtimes.items():
            try:
                runtime = validate_hosted_runtime_desired_state(value)
            except ValidationError as exc:
                raise HTTPException(
                    status.HTTP_409_CONFLICT, "Existing runtime binding is invalid"
                ) from exc
            if provider_id in runtime.provider_ids and name not in {"openclaw", "hermes"}:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Connection ownership supports only OpenClaw and Hermes",
                )
    # Use the existing accepted-v2 evidence reader, including boot ambiguity and retirement fences.
    for offset in range(0, len(states), 100):
        batch = states[offset : offset + 100]
        summaries = await read_runtime_drift_summaries(
            db,
            RuntimeDriftSummaryReadRequest(
                bindings=[
                    RuntimeDriftBindingRequest(
                        environmentId=state.environment_id, deploymentId=state.deployment_id
                    )
                    for state in batch
                ]
            ),
            expected_generations={
                state.environment_id: state.apply_generation or state.generation for state in batch
            },
        )
        by_environment = {state.environment_id: state for state in batch}
        for summary in summaries.items:
            state = by_environment[summary.environment_id]
            authority = summary.source_authority
            head = summary.observation.head
            applied = head.diagnostics.applied if head is not None else None
            if (
                summary.binding != "active"
                or summary.observation.status != "fresh"
                or authority.status != "present"
                or head is None
                or applied is None
                or head.captured_at > summaries.observed_at
                or head.freshness_deadline <= summaries.observed_at
                or head.health != "ok"
                or head.diagnostics.active_cli_version not in versions
                or state.cli_package_spec != f"clawdi@{head.diagnostics.active_cli_version}"
                or authority.instance_id != state.instance_id
                or applied.instance_id != authority.instance_id
                or applied.source_revision != authority.source_revision
                or applied.etag != authority.etag
                or applied.generation != (state.apply_generation or state.generation)
                or provider_id not in applied.applied_provider_ids
                or head.runtime_identity.generation != (state.apply_generation or state.generation)
                or not head.runtime_identity.apply_receipt_id
                or not head.runtime_identity.boot_nonce
            ):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Every bound runtime must have fresh, current evidence "
                    "from a qualified running CLI",
                )


async def require_custom_provider_cli(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider_ids: list[str],
    cli_package_spec: str,
    previous_state: HostedRuntimeState | None = None,
) -> None:
    if not provider_ids:
        return
    custom = set(
        await db.scalars(
            select(AiProvider.provider_id).where(
                AiProvider.owner_user_id == owner_user_id,
                AiProvider.provider_id.in_(provider_ids),
                AiProvider.archived_at.is_(None),
                AiProvider.configuration_mode == "custom",
            )
        )
    )
    if not custom:
        return
    try:
        versions = await resolve_app_setting(db, SUPPORTED_CUSTOM_PROVIDER_CLI_VERSIONS_SPEC)
    except AppSettingUnavailable as exc:
        raise HTTPException(409, "Custom provider initialization is not enabled") from exc
    if cli_package_spec not in {f"clawdi@{version}" for version in versions}:
        raise HTTPException(409, "Custom providers require a qualified CLI release")
    if previous_state is not None:
        previous_ids = {
            provider_id
            for runtime in previous_state.runtimes.values()
            for provider_id in validate_hosted_runtime_desired_state(runtime).provider_ids
        }
        if custom - previous_ids:
            evidence = await read_runtime_drift_summaries(
                db,
                RuntimeDriftSummaryReadRequest(
                    bindings=[
                        RuntimeDriftBindingRequest(
                            environmentId=previous_state.environment_id,
                            deploymentId=previous_state.deployment_id,
                        )
                    ]
                ),
                expected_generations={
                    previous_state.environment_id: previous_state.apply_generation
                    or previous_state.generation
                },
            )
            # Applied provider ownership survives a failed desired-state change.
            # This is not a readiness claim: only the exact previous incarnation's
            # already-applied providers may use historical evidence. Ignore other
            # generations, but refuse competing boots even when all have expired.
            historical = await read_runtime_drift_summaries(
                db,
                RuntimeDriftSummaryReadRequest(
                    bindings=[
                        RuntimeDriftBindingRequest(
                            environmentId=previous_state.environment_id,
                            deploymentId=previous_state.deployment_id,
                        )
                    ]
                ),
                expected_generations={
                    previous_state.environment_id: previous_state.apply_generation
                    or previous_state.generation
                },
                require_unique_active_head=True,
            )
            owned_environment = await db.scalar(
                select(AgentEnvironment.id).where(
                    AgentEnvironment.id == previous_state.environment_id,
                    AgentEnvironment.user_id == owner_user_id,
                    AgentEnvironment.archived_at.is_(None),
                )
            )
            if owned_environment is None:
                raise HTTPException(409, "Custom provider recovery binding is invalid")
            if len(historical.items) == 1:
                history = historical.items[0]
                prior_head = history.observation.head
                prior_applied = prior_head.diagnostics.applied if prior_head else None
                if (
                    history.binding == "active"
                    and history.source_authority.instance_id == previous_state.instance_id
                    and prior_head is not None
                    and prior_applied is not None
                    and prior_head.captured_at <= historical.observed_at
                    and prior_head.diagnostics.active_cli_version in versions
                    and previous_state.cli_package_spec
                    == f"clawdi@{prior_head.diagnostics.active_cli_version}"
                    and prior_applied.instance_id == previous_state.instance_id
                    and (
                        history.source_authority.status == "unavailable"
                        and persisted_runtime_source_error(previous_state)
                        or (
                            history.source_authority.status == "present"
                            and history.source_authority.source_revision
                            == prior_applied.source_revision
                            and history.source_authority.etag == prior_applied.etag
                        )
                    )
                    and prior_applied.generation
                    == (previous_state.apply_generation or previous_state.generation)
                    and prior_head.runtime_identity.generation == prior_applied.generation
                    and prior_head.runtime_identity.apply_receipt_id
                    and prior_head.runtime_identity.boot_nonce
                    and prior_applied.etag
                    == expected_runtime_bundle_v2_etag(prior_applied.source_revision)
                    and custom - previous_ids <= set(prior_applied.applied_provider_ids)
                ):
                    return
            if len(evidence.items) != 1:
                raise HTTPException(
                    409, "Custom provider binding requires current runtime evidence"
                )
            summary = evidence.items[0]
            head = summary.observation.head
            authority = summary.source_authority
            applied = head.diagnostics.applied if head else None
            if (
                summary.binding != "active"
                or summary.observation.status != "fresh"
                or head is None
                or head.health != "ok"
                or head.captured_at > evidence.observed_at
                or head.diagnostics.active_cli_version not in versions
                or previous_state.cli_package_spec
                != f"clawdi@{head.diagnostics.active_cli_version}"
                or authority.status != "present"
                or applied is None
                or applied.instance_id != authority.instance_id
                or authority.instance_id != previous_state.instance_id
                or applied.source_revision != authority.source_revision
                or applied.etag != authority.etag
                or applied.generation
                != (previous_state.apply_generation or previous_state.generation)
            ):
                raise HTTPException(409, "Custom provider binding requires a qualified running CLI")
