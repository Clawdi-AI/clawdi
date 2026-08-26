from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.hosted_runtime import HostedRuntimeConfigObservation, HostedRuntimeState
from app.models.session import AgentEnvironment
from app.schemas.runtime_observed import HostedRuntimeObserved, HostedRuntimeObservedV2
from app.services.runtime_generation import resolve_runtime_apply_generation
from app.services.runtime_source import expected_runtime_bundle_v2_etag
from app.services.runtime_source_revision import persisted_runtime_source_revision

RuntimeEvidenceStatus = Literal["ok", "error", "unknown", "missing", "stale"]
_RUNTIME_OBSERVED_ADAPTER = TypeAdapter(HostedRuntimeObserved)


@dataclass(frozen=True)
class RuntimeObservedEvidence:
    status: RuntimeEvidenceStatus
    observed_at: datetime | None
    converged: bool


def validated_runtime_observed_diagnostics(
    observation: HostedRuntimeConfigObservation | None,
) -> HostedRuntimeObservedV2 | None:
    if observation is None:
        return None
    try:
        return _RUNTIME_OBSERVED_ADAPTER.validate_python(observation.diagnostics)
    except ValidationError:
        return None


async def load_runtime_observed_evidence(
    db: AsyncSession,
    *,
    environment_ids: list[UUID],
    owner_user_id: UUID,
    now: datetime | None = None,
) -> dict[UUID, RuntimeObservedEvidence]:
    requested_ids = sorted(set(environment_ids), key=str)
    if not requested_ids:
        return {}

    rows = (
        await db.execute(
            select(HostedRuntimeState, HostedRuntimeConfigObservation)
            .join(
                AgentEnvironment,
                AgentEnvironment.id == HostedRuntimeState.environment_id,
            )
            .outerjoin(
                HostedRuntimeConfigObservation,
                HostedRuntimeConfigObservation.environment_id == HostedRuntimeState.environment_id,
            )
            .where(
                HostedRuntimeState.environment_id.in_(requested_ids),
                AgentEnvironment.user_id == owner_user_id,
                AgentEnvironment.archived_at.is_(None),
            )
        )
    ).all()
    by_environment = {state.environment_id: (state, observation) for state, observation in rows}
    current = now or datetime.now(UTC)
    freshness = timedelta(seconds=settings.runtime_observation_freshness_seconds)
    evidence: dict[UUID, RuntimeObservedEvidence] = {}
    for environment_id in requested_ids:
        row = by_environment.get(environment_id)
        state, observation = row if row is not None else (None, None)
        desired_source_revision = (
            persisted_runtime_source_revision(state) if state is not None else None
        )
        evidence[environment_id] = _runtime_observed_evidence(
            state=state,
            observation=observation,
            desired_source_revision=desired_source_revision,
            current=current,
            freshness=freshness,
        )
    return evidence


def _runtime_observed_evidence(
    *,
    state: HostedRuntimeState | None,
    observation: HostedRuntimeConfigObservation | None,
    desired_source_revision: str | None,
    current: datetime,
    freshness: timedelta,
) -> RuntimeObservedEvidence:
    if state is None or observation is None or observation.observed_at is None:
        return RuntimeObservedEvidence(status="missing", observed_at=None, converged=False)

    observed_at = _as_utc(observation.observed_at)
    diagnostics = validated_runtime_observed_diagnostics(observation)
    converged = _runtime_observation_matches_desired(
        state=state,
        observation=observation,
        diagnostics=diagnostics,
        desired_source_revision=desired_source_revision,
    )
    if current - observed_at > freshness:
        return RuntimeObservedEvidence(
            status="stale",
            observed_at=observed_at,
            converged=converged,
        )
    if diagnostics is None:
        return RuntimeObservedEvidence(
            status="unknown",
            observed_at=observed_at,
            converged=False,
        )
    return RuntimeObservedEvidence(
        status=diagnostics.status,
        observed_at=observed_at,
        converged=converged,
    )


def _runtime_observation_matches_desired(
    *,
    state: HostedRuntimeState,
    observation: HostedRuntimeConfigObservation,
    diagnostics: HostedRuntimeObservedV2 | None,
    desired_source_revision: str | None,
) -> bool:
    if diagnostics is None or diagnostics.applied is None or desired_source_revision is None:
        return False
    expected_generation = resolve_runtime_apply_generation(
        generation=state.generation,
        apply_generation=state.apply_generation,
    )
    expected_etag = expected_runtime_bundle_v2_etag(desired_source_revision)
    applied = diagnostics.applied
    return (
        observation.observed_config_generation == expected_generation
        and observation.observed_manifest_etag == expected_etag
        and observation.observed_source_revision == desired_source_revision
        and applied.generation == expected_generation
        and applied.etag == expected_etag
        and applied.source_revision == desired_source_revision
        and applied.instance_id == state.instance_id
    )


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)
