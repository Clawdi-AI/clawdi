from __future__ import annotations

import hashlib
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hosted_runtime import HostedRuntimeState
from app.models.session import AgentEnvironment
from app.schemas.runtime import PersistedHostedRuntimeSkills


async def runtime_manifest_reserved_skill_ids(
    db: AsyncSession,
    *,
    user_id: UUID,
    project_id: UUID,
) -> set[str]:
    """Return enabled desired Skill IDs for the hosted agent's default project."""
    result = await db.execute(
        select(HostedRuntimeState.skills)
        .join(
            AgentEnvironment,
            AgentEnvironment.id == HostedRuntimeState.environment_id,
        )
        .where(
            AgentEnvironment.user_id == user_id,
            AgentEnvironment.default_project_id == project_id,
        )
    )
    reserved: set[str] = set()
    for raw in result.scalars():
        if raw is None:
            continue
        try:
            skills = PersistedHostedRuntimeSkills.model_validate(raw)
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={
                    "code": "runtime_manifest_skill_reservation_indeterminate",
                    "message": "Runtime-managed Skill reservations are temporarily unavailable.",
                },
            ) from exc
        reserved.update(
            skill_id for skill_id, entry in skills.entries.items() if entry.enabled is True
        )
    return reserved


def enabled_runtime_manifest_skill_ids(raw: object | None) -> set[str]:
    if raw is None:
        return set()
    try:
        skills = PersistedHostedRuntimeSkills.model_validate(raw)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "runtime_manifest_skill_reservation_indeterminate",
                "message": "Runtime-managed Skill reservations are temporarily unavailable.",
            },
        ) from exc
    return {skill_id for skill_id, entry in skills.entries.items() if entry.enabled is True}


def project_skill_advisory_lock_key(
    user_id: UUID,
    project_id: UUID,
    skill_key: str,
) -> int:
    digest = hashlib.sha256(f"skill:{user_id}:{project_id}:{skill_key}".encode()).digest()
    value = int.from_bytes(digest[:8], "big", signed=False)
    return value - (1 << 64) if value >= 1 << 63 else value


async def lock_runtime_manifest_skill_reservations(
    db: AsyncSession,
    *,
    user_id: UUID,
    project_id: UUID | None,
    skill_ids: set[str],
) -> None:
    if project_id is None:
        return
    for skill_id in sorted(skill_ids):
        await db.execute(
            text("SELECT pg_advisory_xact_lock(:k)"),
            {"k": project_skill_advisory_lock_key(user_id, project_id, skill_id)},
        )


async def assert_project_skill_not_runtime_managed(
    db: AsyncSession,
    *,
    user_id: UUID,
    project_id: UUID,
    skill_key: str,
) -> None:
    if skill_key not in await runtime_manifest_reserved_skill_ids(
        db,
        user_id=user_id,
        project_id=project_id,
    ):
        return
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        detail={
            "code": "runtime_manifest_managed_skill",
            "message": "This Skill key is reserved by the hosted runtime manifest.",
            "skill_key": skill_key,
        },
    )
