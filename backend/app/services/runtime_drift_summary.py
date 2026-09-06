from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hosted_runtime import HostedRuntimeState
from app.models.runtime_observation import (
    RUNTIME_ENVIRONMENT_ACTIVE,
    RUNTIME_OBSERVATION_HEAD_ACTIVE,
    V2RuntimeEnvironmentFence,
    V2RuntimeObservationHead,
    V2RuntimeObservationInbox,
)
from app.models.session import AgentEnvironment
from app.schemas.runtime_observation import (
    RuntimeDriftObservationHead,
    RuntimeDriftObservationSummary,
    RuntimeDriftSourceAuthority,
    RuntimeDriftSummary,
    RuntimeDriftSummaryReadRequest,
    RuntimeDriftSummaryReadResponse,
)
from app.services.runtime_source import expected_runtime_bundle_v2_etag
from app.services.runtime_source_revision import runtime_source_contract_revision


async def read_runtime_drift_summaries(
    db: AsyncSession,
    body: RuntimeDriftSummaryReadRequest,
) -> RuntimeDriftSummaryReadResponse:
    """Read persisted drift evidence without writes in the caller's RR snapshot."""
    environment_ids = [binding.environment_id for binding in body.bindings]
    rows = (
        await db.execute(
            select(
                V2RuntimeEnvironmentFence.environment_id,
                V2RuntimeEnvironmentFence.deployment_id,
                V2RuntimeEnvironmentFence.state,
                HostedRuntimeState.deployment_id.label("source_deployment_id"),
                HostedRuntimeState.instance_id,
                HostedRuntimeState.source_revision,
                HostedRuntimeState.source_revision_contract,
            )
            .outerjoin(
                AgentEnvironment,
                (AgentEnvironment.id == V2RuntimeEnvironmentFence.environment_id)
                & (AgentEnvironment.user_id == V2RuntimeEnvironmentFence.owner_id)
                & AgentEnvironment.archived_at.is_(None),
            )
            .outerjoin(HostedRuntimeState, HostedRuntimeState.environment_id == AgentEnvironment.id)
            .where(V2RuntimeEnvironmentFence.environment_id.in_(environment_ids))
        )
    ).all()
    by_environment = {row.environment_id: row for row in rows}
    binding_states: dict[UUID, Literal["active", "retired", "missing", "binding_mismatch"]] = {}
    active: list[tuple[UUID, str]] = []
    for requested in body.bindings:
        row = by_environment.get(requested.environment_id)
        if row is None:
            binding = "missing"
        elif row.deployment_id != requested.deployment_id or (
            row.source_deployment_id is not None
            and row.source_deployment_id != requested.deployment_id
        ):
            binding = "binding_mismatch"
        elif row.state != RUNTIME_ENVIRONMENT_ACTIVE:
            binding = "retired"
        else:
            binding = "active"
            active.append((requested.environment_id, requested.deployment_id))
        binding_states[requested.environment_id] = binding

    heads: dict[UUID, RuntimeDriftObservationHead | None] = {}
    if active:
        head_counts = (
            select(
                V2RuntimeObservationHead.environment_id,
                V2RuntimeObservationHead.deployment_id,
                func.count().label("active_head_count"),
            )
            .where(
                tuple_(
                    V2RuntimeObservationHead.environment_id,
                    V2RuntimeObservationHead.deployment_id,
                ).in_(active),
                V2RuntimeObservationHead.state == RUNTIME_OBSERVATION_HEAD_ACTIVE,
            )
            .group_by(
                V2RuntimeObservationHead.environment_id,
                V2RuntimeObservationHead.deployment_id,
            )
            .subquery()
        )
        # Only singleton groups join a head: ambiguous bindings return one count
        # row with no head or diagnostics, regardless of how many boots exist.
        head_rows = (
            await db.execute(
                select(
                    head_counts.c.environment_id,
                    head_counts.c.active_head_count,
                    V2RuntimeObservationHead,
                    V2RuntimeObservationInbox.diagnostics["activeCliVersion"],
                    V2RuntimeObservationInbox.diagnostics["applied"],
                    V2RuntimeObservationInbox.diagnostics["agentPlugins"],
                    V2RuntimeObservationInbox.diagnostics["userActivity"],
                )
                .select_from(head_counts)
                .outerjoin(
                    V2RuntimeObservationHead,
                    (head_counts.c.active_head_count == 1)
                    & (V2RuntimeObservationHead.environment_id == head_counts.c.environment_id)
                    & (V2RuntimeObservationHead.deployment_id == head_counts.c.deployment_id)
                    & (V2RuntimeObservationHead.state == RUNTIME_OBSERVATION_HEAD_ACTIVE),
                )
                .outerjoin(
                    V2RuntimeObservationInbox,
                    (V2RuntimeObservationInbox.id == V2RuntimeObservationHead.latest_inbox_id)
                    & (V2RuntimeObservationInbox.environment_id == head_counts.c.environment_id)
                    & (V2RuntimeObservationInbox.deployment_id == head_counts.c.deployment_id),
                )
            )
        ).all()
        for environment_id, count, head, cli_version, applied, plugins, activity in head_rows:
            if count > 1:
                heads[environment_id] = None
                continue
            # Coalescing advances head metadata, not inbox diagnostic timestamps.
            heads[environment_id] = RuntimeDriftObservationHead.model_validate(
                {
                    "runtimeIdentity": {
                        "generation": head.generation,
                        "manifestETag": head.manifest_etag,
                        "applyReceiptId": head.apply_receipt_id,
                        "bootNonce": head.boot_nonce,
                        "bootSessionId": head.boot_session_id,
                    },
                    "capturedAt": head.captured_at,
                    "freshnessDeadline": head.freshness_deadline,
                    "health": head.health,
                    "diagnostics": {
                        "activeCliVersion": cli_version,
                        "applied": applied,
                        "agentPlugins": plugins,
                        "userActivity": activity,
                    },
                }
            )

    observed_at = datetime.now(UTC)
    contract = runtime_source_contract_revision()
    items: list[RuntimeDriftSummary] = []
    for requested in body.bindings:
        binding = binding_states[requested.environment_id]
        row = by_environment.get(requested.environment_id)
        if binding == "active" and row is not None and row.source_deployment_id is not None:
            revision = row.source_revision if row.source_revision_contract == contract else None
            source = RuntimeDriftSourceAuthority(
                status="present" if revision is not None else "unavailable",
                instanceId=row.instance_id,
                sourceRevision=revision,
                etag=expected_runtime_bundle_v2_etag(revision) if revision is not None else None,
            )
        else:
            source = RuntimeDriftSourceAuthority(
                status="missing", instanceId=None, sourceRevision=None, etag=None
            )
        head = heads.get(requested.environment_id)
        if head is None:
            observation_status = "ambiguous" if requested.environment_id in heads else "missing"
        else:
            observation_status = "fresh" if head.freshness_deadline > observed_at else "expired"
        items.append(
            RuntimeDriftSummary(
                environmentId=requested.environment_id,
                deploymentId=requested.deployment_id,
                binding=binding,
                sourceAuthority=source,
                observation=RuntimeDriftObservationSummary(status=observation_status, head=head),
            )
        )
    return RuntimeDriftSummaryReadResponse(observedAt=observed_at, items=items)
