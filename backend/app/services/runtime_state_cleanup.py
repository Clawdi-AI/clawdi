from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hosted_runtime import HostedRuntimeState
from app.models.runtime_observation import (
    RUNTIME_ENVIRONMENT_ACTIVE,
    RUNTIME_ENVIRONMENT_RETIRED,
    V2RuntimeEnvironmentFence,
)
from app.models.user import User
from app.schemas.runtime_observation import RuntimeStateCleanupReceipt
from app.services.ai_provider_credentials import release_runtime_oauth_claims
from app.services.channels import archive_active_bot_agent_links_for_agent
from app.services.runtime_observation import RuntimeObservationProtocolError


async def lock_runtime_state_write_fence(
    db: AsyncSession,
    *,
    environment_id: UUID,
    owner_id: UUID,
    deployment_id: str,
) -> None:
    """Fence v2 desired-state writes while preserving unfenced v1 behavior."""

    fence = await db.scalar(
        select(V2RuntimeEnvironmentFence)
        .where(V2RuntimeEnvironmentFence.environment_id == environment_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if fence is None:
        return
    if fence.owner_id != owner_id or fence.deployment_id != deployment_id:
        raise RuntimeObservationProtocolError(
            409,
            "runtime_environment_binding_conflict",
            "runtime environment binding does not match desired state",
        )
    if fence.state != RUNTIME_ENVIRONMENT_ACTIVE:
        raise RuntimeObservationProtocolError(
            409,
            "runtime_environment_retired",
            "runtime environment is retired",
        )


async def cleanup_retired_runtime_state(
    db: AsyncSession,
    *,
    environment_id: UUID,
    expected_deployment_binding: str,
    retirement_id: str,
    cleanup_id: str,
    cleaned_at: datetime | None = None,
) -> tuple[RuntimeStateCleanupReceipt, bool, bool]:
    """Delete the exact retired desired state and persist its permanent receipt."""

    observed = await db.get(V2RuntimeEnvironmentFence, environment_id)
    if observed is None:
        raise _conflict(
            "runtime_environment_fence_missing",
            "runtime environment fence does not exist",
        )

    # User is the established parent lock for runtime state and OAuth claims.
    # It can be absent after principal cleanup; its dependent state is then
    # already absent through existing FK/lifecycle cleanup.
    owner_exists = (
        await db.scalar(select(User.id).where(User.id == observed.owner_id).with_for_update())
        is not None
    )
    fence = await db.scalar(
        select(V2RuntimeEnvironmentFence)
        .where(V2RuntimeEnvironmentFence.environment_id == environment_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if fence is None:
        raise _conflict(
            "runtime_environment_fence_missing",
            "runtime environment fence does not exist",
        )
    _validate_retirement_identity(
        fence,
        expected_deployment_binding=expected_deployment_binding,
        retirement_id=retirement_id,
    )

    existing_receipt: RuntimeStateCleanupReceipt | None = None
    if fence.runtime_state_cleanup_id is not None:
        if fence.runtime_state_cleanup_id != cleanup_id:
            raise _conflict(
                "runtime_state_cleanup_conflict",
                "retired runtime state was cleaned by another obligation",
            )
        existing_receipt = validate_runtime_state_cleanup_receipt(fence, cleanup_id=cleanup_id)

    # Link admission locks the runtime fence before inserting a Link. Holding
    # the retired fence here makes this replay-safe and closes concurrent
    # admission before the canonical per-Link cleanup runs.
    await archive_active_bot_agent_links_for_agent(db, agent_id=environment_id)
    if existing_receipt is not None:
        return existing_receipt, False, False

    runtime_state = await db.scalar(
        select(HostedRuntimeState)
        .where(HostedRuntimeState.environment_id == environment_id)
        .with_for_update()
    )
    runtime_state_deleted = runtime_state is not None
    if runtime_state is not None:
        if runtime_state.deployment_id != expected_deployment_binding:
            raise _conflict(
                "runtime_state_deployment_binding_conflict",
                "hosted runtime state deployment binding does not match",
            )
        await db.delete(runtime_state)
    if owner_exists:
        await release_runtime_oauth_claims(
            db,
            owner_user_id=fence.owner_id,
            environment_id=environment_id,
        )

    receipt = RuntimeStateCleanupReceipt(
        schemaVersion="clawdi.runtimeStateCleanupReceipt.v1",
        environmentReference=environment_id,
        expectedDeploymentBinding=expected_deployment_binding,
        retirementId=retirement_id,
        cleanupId=cleanup_id,
        runtimeStateStatus="absent",
        cleanedAt=cleaned_at or datetime.now(UTC),
    )
    fence.runtime_state_cleanup_id = cleanup_id
    fence.runtime_state_cleanup_receipt = receipt.model_dump(mode="json", by_alias=True)
    await db.flush()
    return receipt, True, runtime_state_deleted


def _validate_retirement_identity(
    fence: V2RuntimeEnvironmentFence,
    *,
    expected_deployment_binding: str,
    retirement_id: str,
) -> None:
    if fence.state != RUNTIME_ENVIRONMENT_RETIRED:
        raise _conflict(
            "runtime_environment_not_retired",
            "runtime environment is not retired",
        )
    if fence.deployment_id != expected_deployment_binding or fence.retirement_id != retirement_id:
        raise _conflict(
            "runtime_environment_retirement_conflict",
            "runtime environment retirement identity does not match",
        )


def validate_runtime_state_cleanup_receipt(
    fence: V2RuntimeEnvironmentFence,
    *,
    cleanup_id: str,
) -> RuntimeStateCleanupReceipt:
    try:
        receipt = RuntimeStateCleanupReceipt.model_validate(fence.runtime_state_cleanup_receipt)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("persisted runtime state cleanup receipt is invalid") from exc
    if receipt.cleaned_at.tzinfo is None or receipt.cleaned_at.utcoffset() is None:
        raise RuntimeError("persisted runtime state cleanup receipt is invalid")
    if (
        receipt.environment_reference != fence.environment_id
        or receipt.expected_deployment_binding != fence.deployment_id
        or receipt.retirement_id != fence.retirement_id
        or receipt.cleanup_id != cleanup_id
    ):
        raise RuntimeError("persisted runtime state cleanup receipt identity is invalid")
    return receipt


def _conflict(code: str, message: str) -> RuntimeObservationProtocolError:
    return RuntimeObservationProtocolError(409, code, message)
