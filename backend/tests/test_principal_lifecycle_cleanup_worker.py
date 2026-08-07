from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models.agent_project_binding import AgentProjectBinding
from app.models.principal_lifecycle import PrincipalLifecycle
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.project_membership import ProjectMembership
from app.models.user import User
from app.services import sync_events
from app.services.principal_lifecycle import (
    PRINCIPAL_CLEANUP_CLAIM_LEASE_SECONDS,
    PrincipalCleanupClaimLostError,
    claim_principal_cleanup,
    complete_principal_cleanup,
    record_principal_cleanup_failure,
)
from tests.conftest import create_env_with_project, create_test_hosted_runtime_state

pytestmark = [pytest.mark.asyncio, pytest.mark.committed_db]

_ISSUER = "https://cleanup-worker.clerk.example.test"


def _pending_lifecycle(*, subject: str, due_at: datetime) -> PrincipalLifecycle:
    return PrincipalLifecycle(
        issuer=_ISSUER,
        subject=subject,
        terminated_at=due_at,
        next_cleanup_attempt_at=due_at,
    )


async def _delete_lifecycles(session_factory, lifecycle_ids: list[uuid.UUID]) -> None:
    async with session_factory() as db:
        await db.execute(delete(PrincipalLifecycle).where(PrincipalLifecycle.id.in_(lifecycle_ids)))
        await db.commit()


async def test_cleanup_claims_use_skip_locked_across_workers(engine):
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    due_at = datetime.now(UTC) - timedelta(minutes=1)
    first = _pending_lifecycle(subject=f"claim-a-{uuid.uuid4().hex}", due_at=due_at)
    second = _pending_lifecycle(subject=f"claim-b-{uuid.uuid4().hex}", due_at=due_at)
    async with session_factory() as db:
        db.add_all([first, second])
        await db.commit()
    lifecycle_ids = [first.id, second.id]

    first_session = session_factory()
    second_session = session_factory()
    try:
        first_claim, second_claim = await asyncio.wait_for(
            asyncio.gather(
                claim_principal_cleanup(first_session, now=due_at + timedelta(minutes=2)),
                claim_principal_cleanup(second_session, now=due_at + timedelta(minutes=2)),
            ),
            timeout=5,
        )
        assert first_claim is not None
        assert second_claim is not None
        assert {first_claim.lifecycle_id, second_claim.lifecycle_id} == set(lifecycle_ids)
        assert first_claim.claim_id != second_claim.claim_id
    finally:
        await first_session.rollback()
        await second_session.rollback()
        await first_session.close()
        await second_session.close()
        await _delete_lifecycles(session_factory, lifecycle_ids)


async def test_cleanup_claim_recovers_after_crash_and_rejects_stale_worker(engine):
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    claimed_at = datetime.now(UTC) - timedelta(minutes=5)
    lifecycle = _pending_lifecycle(
        subject=f"crash-{uuid.uuid4().hex}",
        due_at=claimed_at,
    )
    async with session_factory() as db:
        db.add(lifecycle)
        await db.commit()

    try:
        async with session_factory() as db:
            original = await claim_principal_cleanup(db, now=claimed_at)
            assert original is not None
            await db.commit()
        async with session_factory() as db:
            assert (
                await record_principal_cleanup_failure(
                    db,
                    lifecycle_id=lifecycle.id,
                    now=claimed_at,
                )
                is False
            )
            await db.rollback()
        async with session_factory() as db:
            not_stale = await claim_principal_cleanup(
                db,
                now=claimed_at + timedelta(seconds=PRINCIPAL_CLEANUP_CLAIM_LEASE_SECONDS - 1),
            )
            assert not_stale is None
            await db.rollback()
        async with session_factory() as db:
            recovered = await claim_principal_cleanup(
                db,
                now=claimed_at + timedelta(seconds=PRINCIPAL_CLEANUP_CLAIM_LEASE_SECONDS + 1),
            )
            assert recovered is not None
            assert recovered.claim_id != original.claim_id
            assert recovered.attempt_count == 2
            await db.commit()

        async with session_factory() as db:
            with pytest.raises(PrincipalCleanupClaimLostError):
                await complete_principal_cleanup(
                    db,
                    lifecycle_id=lifecycle.id,
                    expected_claim_id=original.claim_id,
                )
            await db.rollback()
        async with session_factory() as db:
            result = await complete_principal_cleanup(
                db,
                lifecycle_id=lifecycle.id,
                expected_claim_id=recovered.claim_id,
            )
            assert result.user_disabled is False
            await db.commit()
        async with session_factory() as db:
            persisted = await db.get(PrincipalLifecycle, lifecycle.id)
            assert persisted is not None
            assert persisted.cleanup_completed_at is not None
            assert persisted.cleanup_attempts == 2
            assert persisted.cleanup_claim_id is None
    finally:
        await _delete_lifecycles(session_factory, [lifecycle.id])


async def test_owner_cleanup_unlinks_and_notifies_member_agents(db_session, seed_user):
    now = datetime.now(UTC)
    nonce = uuid.uuid4().hex
    owner = User(
        clerk_id=f"deleted-owner-{nonce}",
        clerk_issuer=_ISSUER,
        email=f"deleted-owner-{nonce}@test.dev",
        name="Deleted owner",
    )
    db_session.add(owner)
    await db_session.flush()
    project = Project(
        user_id=owner.id,
        name="Owner Project",
        slug=f"owner-project-{nonce[:8]}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(project)
    await db_session.flush()
    agent = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"member-agent-{nonce[:8]}",
        machine_name="member-agent",
        agent_type="openclaw",
    )
    await create_test_hosted_runtime_state(db_session, agent, runtime_name="openclaw")
    lifecycle = PrincipalLifecycle(
        issuer=_ISSUER,
        subject=owner.clerk_id,
        user_id=owner.id,
        terminated_at=now,
        next_cleanup_attempt_at=now,
    )
    db_session.add_all(
        [
            project,
            lifecycle,
            ProjectMembership(
                project_id=project.id,
                member_user_id=seed_user.id,
                role="viewer",
                joined_via="invite",
                joined_at=now,
                resolved_owner_handle="deleted-owner",
            ),
            AgentProjectBinding(
                agent_id=agent.id,
                project_id=project.id,
                binding_type="context",
                priority=1,
                default_write_enabled=False,
                created_by_user_id=seed_user.id,
            ),
        ]
    )
    await db_session.commit()
    lifecycle_id = lifecycle.id
    project_id = project.id
    owner_id = owner.id
    queue = sync_events.subscribe(seed_user.id, frozenset(), environment_id=agent.id)

    try:
        result = await complete_principal_cleanup(db_session, lifecycle_id=lifecycle_id, now=now)
        await db_session.commit()

        assert result.user_disabled is True
        assert queue.get_nowait() == {
            "type": "runtime_manifest_changed",
            "environment_id": str(agent.id),
        }
        assert (
            await db_session.execute(
                select(AgentProjectBinding).where(
                    AgentProjectBinding.agent_id == agent.id,
                    AgentProjectBinding.project_id == project_id,
                )
            )
        ).scalar_one_or_none() is None
        assert (
            await db_session.execute(
                select(ProjectMembership).where(ProjectMembership.project_id == project_id)
            )
        ).scalar_one_or_none() is None
    finally:
        sync_events.unsubscribe(seed_user.id, queue)
        await db_session.rollback()
        await db_session.execute(
            delete(PrincipalLifecycle).where(PrincipalLifecycle.id == lifecycle_id)
        )
        await db_session.execute(delete(Project).where(Project.id == project_id))
        await db_session.execute(delete(User).where(User.id == owner_id))
        await db_session.commit()
