"""Admission for the one-way, existing-runtime provider ownership handoff."""

from datetime import datetime
from uuid import UUID

from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_provider import AiProvider
from app.models.hosted_runtime import HostedRuntimeState
from app.models.runtime_observation import (
    RUNTIME_OBSERVATION_HEAD_ACTIVE,
    V2RuntimeObservationHead,
    V2RuntimeObservationInbox,
)
from app.models.session import AgentEnvironment
from app.schemas.runtime import validate_hosted_runtime_desired_state
from app.schemas.runtime_observation import (
    RuntimeDriftBindingRequest,
    RuntimeDriftObservationHead,
    RuntimeDriftSummary,
    RuntimeDriftSummaryReadRequest,
)
from app.schemas.runtime_observed import HostedRuntimeObservedAppliedV2
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
    if previous_state is None:
        return
    previous_ids = {
        provider_id
        for runtime in previous_state.runtimes.values()
        for provider_id in validate_hosted_runtime_desired_state(runtime).provider_ids
    }
    added_ids = custom - previous_ids
    if not added_ids:
        return
    owned_environment = await db.scalar(
        select(AgentEnvironment.id).where(
            AgentEnvironment.id == previous_state.environment_id,
            AgentEnvironment.user_id == owner_user_id,
            AgentEnvironment.archived_at.is_(None),
        )
    )
    if owned_environment is None:
        raise HTTPException(409, "Custom provider recovery binding is invalid")
    request = RuntimeDriftSummaryReadRequest(
        bindings=[
            RuntimeDriftBindingRequest(
                environmentId=previous_state.environment_id,
                deploymentId=previous_state.deployment_id,
            )
        ]
    )
    generations = {
        previous_state.environment_id: previous_state.apply_generation or previous_state.generation
    }
    evidence = await read_runtime_drift_summaries(db, request, expected_generations=generations)
    if len(evidence.items) != 1:
        raise HTTPException(409, "Custom provider binding requires current runtime evidence")
    summary = evidence.items[0]
    qualified = _qualified_applied_evidence(
        summary, previous_state, versions=versions, observed_at=evidence.observed_at
    )
    if qualified is not None:
        head, applied = qualified
        authority = summary.source_authority
        if (
            summary.observation.status == "fresh"
            and head.health == "ok"
            and authority.status == "present"
            and applied.source_revision == authority.source_revision
            and applied.etag == authority.etag
        ):
            return
    if await _has_historical_provider_ownership(
        db, previous_state, restoring=added_ids, versions=versions, request=request
    ):
        return
    raise HTTPException(409, "Custom provider binding requires a qualified running CLI")


def _qualified_applied_evidence(
    summary: RuntimeDriftSummary,
    state: HostedRuntimeState,
    *,
    versions: list[str],
    observed_at: datetime,
) -> tuple[RuntimeDriftObservationHead, HostedRuntimeObservedAppliedV2] | None:
    """Validate incarnation/CLI identity independently of health or desired source."""
    head = summary.observation.head
    applied = head.diagnostics.applied if head else None
    generation = state.apply_generation or state.generation
    if (
        summary.binding != "active"
        or summary.source_authority.instance_id != state.instance_id
        or head is None
        or applied is None
        or head.captured_at > observed_at
        or head.diagnostics.active_cli_version not in versions
        or state.cli_package_spec != f"clawdi@{head.diagnostics.active_cli_version}"
        or applied.instance_id != state.instance_id
        or applied.generation != generation
        or head.runtime_identity.generation != generation
        or not head.runtime_identity.apply_receipt_id
        or not head.runtime_identity.boot_nonce
        or applied.etag != expected_runtime_bundle_v2_etag(applied.source_revision)
    ):
        return None
    return head, applied


async def _has_historical_provider_ownership(
    db: AsyncSession,
    previous_state: HostedRuntimeState,
    *,
    restoring: set[str],
    versions: list[str],
    request: RuntimeDriftSummaryReadRequest,
) -> bool:
    """Recover completed transfers, never readiness or a new provider handoff."""
    historical = await read_runtime_drift_summaries(
        db,
        request,
        expected_generations={
            previous_state.environment_id: previous_state.apply_generation
            or previous_state.generation
        },
        require_unique_active_head=True,
    )
    if len(historical.items) != 1:
        return False
    summary = historical.items[0]
    qualified = _qualified_applied_evidence(
        summary, previous_state, versions=versions, observed_at=historical.observed_at
    )
    if qualified is None or not (
        summary.source_authority.status == "present"
        or summary.source_authority.status == "unavailable"
        and persisted_runtime_source_error(previous_state)
    ):
        return False
    prior_head, prior_applied = qualified
    if restoring <= set(prior_applied.applied_provider_ids):
        return True
    # Only retained evidence at or before this exact active boot's head counts.
    identity = prior_head.runtime_identity
    applied_payload = await db.scalar(
        select(V2RuntimeObservationInbox.diagnostics["applied"])
        .join(
            V2RuntimeObservationHead,
            (V2RuntimeObservationHead.environment_id == V2RuntimeObservationInbox.environment_id)
            & (V2RuntimeObservationHead.deployment_id == V2RuntimeObservationInbox.deployment_id)
            & (
                V2RuntimeObservationHead.boot_session_id
                == V2RuntimeObservationInbox.boot_session_id
            ),
        )
        .where(
            V2RuntimeObservationHead.state == RUNTIME_OBSERVATION_HEAD_ACTIVE,
            V2RuntimeObservationInbox.sequence <= V2RuntimeObservationHead.highest_sequence,
            V2RuntimeObservationInbox.environment_id == previous_state.environment_id,
            V2RuntimeObservationInbox.deployment_id == previous_state.deployment_id,
            V2RuntimeObservationInbox.generation == identity.generation,
            V2RuntimeObservationInbox.manifest_etag == identity.manifest_etag,
            V2RuntimeObservationInbox.apply_receipt_id == identity.apply_receipt_id,
            V2RuntimeObservationInbox.boot_nonce == identity.boot_nonce,
            V2RuntimeObservationInbox.boot_session_id == identity.boot_session_id,
            V2RuntimeObservationInbox.captured_at <= prior_head.captured_at,
            V2RuntimeObservationInbox.received_at <= historical.observed_at,
            V2RuntimeObservationInbox.payload_purged_at.is_(None),
            V2RuntimeObservationInbox.diagnostics["activeCliVersion"].as_string()
            == prior_head.diagnostics.active_cli_version,
            V2RuntimeObservationInbox.diagnostics["applied"]["appliedProviderIds"].contains(
                sorted(restoring)
            ),
        )
        .order_by(V2RuntimeObservationInbox.sequence.desc())
        .limit(1)
    )
    if applied_payload is not None:
        try:
            applied_history = HostedRuntimeObservedAppliedV2.model_validate(applied_payload)
        except ValidationError:
            applied_history = None
        if (
            applied_history is not None
            and applied_history.instance_id == previous_state.instance_id
            and applied_history.generation == identity.generation
            and applied_history.etag
            == expected_runtime_bundle_v2_etag(applied_history.source_revision)
        ):
            return True
    return False
