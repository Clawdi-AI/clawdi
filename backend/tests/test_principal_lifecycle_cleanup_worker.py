from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models.principal_lifecycle import PrincipalLifecycle
from app.services.principal_lifecycle import (
    PRINCIPAL_CLEANUP_CLAIM_LEASE_SECONDS,
    PrincipalCleanupClaimLostError,
    claim_principal_cleanup,
    complete_principal_cleanup,
    record_principal_cleanup_failure,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.committed_db]

_ISSUER = "https://cleanup-worker.clerk.example.test"


def _pending_lifecycle(*, subject: str, due_at: datetime) -> PrincipalLifecycle:
    return PrincipalLifecycle(
        issuer=_ISSUER,
        subject=subject,
        current_revision=1,
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
