"""Admission for the one-way, existing-runtime provider ownership handoff."""

from uuid import UUID

from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hosted_runtime import HostedRuntimeState
from app.models.session import AgentEnvironment
from app.schemas.runtime import validate_hosted_runtime_desired_state
from app.schemas.runtime_observation import (
    RuntimeDriftBindingRequest,
    RuntimeDriftSummaryReadRequest,
)
from app.services.app_setting_registry import SUPPORTED_CONNECTION_CLI_VERSIONS_SPEC
from app.services.app_settings import AppSettingUnavailable, resolve_app_setting
from app.services.runtime_drift_summary import read_runtime_drift_summaries


async def require_connection_ownership_migration(
    db: AsyncSession, *, owner_user_id: UUID, provider_id: str
) -> None:
    """The caller holds the provider-owner lock shared by runtime-state mutations."""
    try:
        versions = await resolve_app_setting(db, SUPPORTED_CONNECTION_CLI_VERSIONS_SPEC)
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
