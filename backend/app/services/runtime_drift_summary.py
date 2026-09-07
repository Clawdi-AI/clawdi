from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import and_, func, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

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
    observed_at = datetime.now(UTC)
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
    expected: list[tuple[UUID, str, int, str, str, str]] = []
    legacy: list[tuple[UUID, str]] = []
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
            identity = requested.expected_apply_identity
            if identity is None:
                legacy.append((requested.environment_id, requested.deployment_id))
            else:
                expected.append(
                    (
                        requested.environment_id,
                        requested.deployment_id,
                        identity.generation,
                        identity.manifest_etag,
                        identity.apply_receipt_id,
                        identity.boot_nonce,
                    )
                )
        binding_states[requested.environment_id] = binding

    heads: dict[UUID, RuntimeDriftObservationHead | None] = {}
    if active:
        fresh = and_(
            V2RuntimeObservationHead.captured_at <= observed_at,
            V2RuntimeObservationHead.freshness_deadline > observed_at,
        )
        predicates: list[ColumnElement[bool]] = []
        if expected:
            predicates.append(
                tuple_(
                    V2RuntimeObservationHead.environment_id,
                    V2RuntimeObservationHead.deployment_id,
                    V2RuntimeObservationHead.generation,
                    V2RuntimeObservationHead.manifest_etag,
                    V2RuntimeObservationHead.apply_receipt_id,
                    V2RuntimeObservationHead.boot_nonce,
                ).in_(expected)
            )
        if legacy:
            predicates.append(
                tuple_(
                    V2RuntimeObservationHead.environment_id,
                    V2RuntimeObservationHead.deployment_id,
                ).in_(legacy)
            )
        ranked_heads = (
            select(
                *V2RuntimeObservationHead.__table__.c,
                func.count()
                .over(partition_by=V2RuntimeObservationHead.environment_id)
                .label("active_head_count"),
                func.count()
                .filter(fresh)
                .over(partition_by=V2RuntimeObservationHead.environment_id)
                .label("fresh_head_count"),
                func.row_number()
                .over(
                    partition_by=V2RuntimeObservationHead.environment_id,
                    order_by=(
                        fresh.desc(),
                        V2RuntimeObservationHead.captured_at.desc(),
                        V2RuntimeObservationHead.freshness_deadline.desc(),
                        V2RuntimeObservationHead.boot_session_id.desc(),
                        V2RuntimeObservationHead.highest_sequence.desc(),
                        V2RuntimeObservationHead.latest_event_id.desc(),
                    ),
                )
                .label("head_rank"),
            )
            .where(
                V2RuntimeObservationHead.state == RUNTIME_OBSERVATION_HEAD_ACTIVE,
                or_(*predicates),
            )
            .subquery()
        )
        head_rows = (
            await db.execute(
                select(
                    ranked_heads,
                    V2RuntimeObservationInbox.diagnostics["activeCliVersion"].label(
                        "active_cli_version"
                    ),
                    V2RuntimeObservationInbox.diagnostics["applied"].label("applied_diagnostics"),
                    V2RuntimeObservationInbox.diagnostics["skills"].label("skills"),
                    V2RuntimeObservationInbox.diagnostics["agentPlugins"].label("agent_plugins"),
                    V2RuntimeObservationInbox.diagnostics["userActivity"].label("user_activity"),
                )
                .outerjoin(
                    V2RuntimeObservationInbox,
                    (V2RuntimeObservationInbox.id == ranked_heads.c.latest_inbox_id)
                    & (V2RuntimeObservationInbox.environment_id == ranked_heads.c.environment_id)
                    & (V2RuntimeObservationInbox.deployment_id == ranked_heads.c.deployment_id),
                )
                .where(ranked_heads.c.head_rank == 1)
            )
        ).all()
        legacy_environments = {environment_id for environment_id, _ in legacy}
        for row in head_rows:
            ambiguous = (
                row.active_head_count > 1
                if row.environment_id in legacy_environments
                else row.fresh_head_count > 1
            )
            if ambiguous:
                heads[row.environment_id] = None
                continue
            # Coalescing advances head metadata, not inbox diagnostic timestamps.
            heads[row.environment_id] = RuntimeDriftObservationHead.model_validate(
                {
                    "runtimeIdentity": {
                        "generation": row.generation,
                        "manifestETag": row.manifest_etag,
                        "applyReceiptId": row.apply_receipt_id,
                        "bootNonce": row.boot_nonce,
                        "bootSessionId": row.boot_session_id,
                    },
                    "capturedAt": row.captured_at,
                    "freshnessDeadline": row.freshness_deadline,
                    "health": row.health,
                    "diagnostics": {
                        "activeCliVersion": row.active_cli_version,
                        "applied": row.applied_diagnostics,
                        "skills": row.skills,
                        "agentPlugins": row.agent_plugins,
                        "userActivity": row.user_activity,
                    },
                }
            )

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
