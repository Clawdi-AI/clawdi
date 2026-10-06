from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from app.models.audit import ControlPlaneAuditEvent
from app.services import control_plane_audit_retention_worker as retention
from app.services.control_plane_audit_retention_worker import (
    MANAGED_PROVIDER_METADATA_REPLACE_ACTION,
    MANAGED_PROVIDER_READ_ACTION,
    ControlPlaneAuditRetentionWorker,
)


def _event(
    *,
    action: str,
    resource_id: str,
    target_user_id: uuid.UUID,
    created_at: datetime,
    outcome: str = "success",
    fingerprinted: bool = False,
) -> ControlPlaneAuditEvent:
    details: dict[str, object] = {"provider_id": resource_id, "outcome": outcome}
    if fingerprinted:
        details["metadata_before"] = "a" * 64
        details["metadata_after"] = "b" * 64
    return ControlPlaneAuditEvent(
        actor_type="admin",
        source="api.admin",
        action=action,
        resource_type="ai_provider",
        resource_id=resource_id,
        target_user_id=target_user_id,
        details=details,
        created_at=created_at,
    )


@pytest.mark.asyncio
async def test_audit_retention_deletes_only_noise_and_keeps_latest_replace(
    db_session,
    seed_user,
):
    now = datetime.now(UTC)
    old = now - timedelta(days=60)
    recent = now - timedelta(days=1)
    first = f"clawdi-v2-deployment-{uuid.uuid4().hex[:8]}"
    second = f"clawdi-v2-deployment-{uuid.uuid4().hex[:8]}"
    rows = {
        "read_success": _event(
            action=MANAGED_PROVIDER_READ_ACTION,
            resource_id=first,
            target_user_id=seed_user.id,
            created_at=recent,
        ),
        "read_denied": _event(
            action=MANAGED_PROVIDER_READ_ACTION,
            resource_id=first,
            target_user_id=seed_user.id,
            created_at=old,
            outcome="cross_owner_denied",
        ),
        "first_old_replace": _event(
            action=MANAGED_PROVIDER_METADATA_REPLACE_ACTION,
            resource_id=first,
            target_user_id=seed_user.id,
            created_at=old,
        ),
        "first_older_replace": _event(
            action=MANAGED_PROVIDER_METADATA_REPLACE_ACTION,
            resource_id=first,
            target_user_id=seed_user.id,
            created_at=old - timedelta(minutes=5),
        ),
        "first_recent_replace": _event(
            action=MANAGED_PROVIDER_METADATA_REPLACE_ACTION,
            resource_id=first,
            target_user_id=seed_user.id,
            created_at=recent - timedelta(minutes=5),
        ),
        "first_latest_replace": _event(
            action=MANAGED_PROVIDER_METADATA_REPLACE_ACTION,
            resource_id=first,
            target_user_id=seed_user.id,
            created_at=recent,
        ),
        "first_failed_replace": _event(
            action=MANAGED_PROVIDER_METADATA_REPLACE_ACTION,
            resource_id=first,
            target_user_id=seed_user.id,
            created_at=old,
            outcome="failed",
        ),
        "first_fingerprinted_replace": _event(
            action=MANAGED_PROVIDER_METADATA_REPLACE_ACTION,
            resource_id=first,
            target_user_id=seed_user.id,
            created_at=old,
            fingerprinted=True,
        ),
        "second_old_replace": _event(
            action=MANAGED_PROVIDER_METADATA_REPLACE_ACTION,
            resource_id=second,
            target_user_id=seed_user.id,
            created_at=old - timedelta(minutes=5),
        ),
        "second_latest_replace": _event(
            action=MANAGED_PROVIDER_METADATA_REPLACE_ACTION,
            resource_id=second,
            target_user_id=seed_user.id,
            created_at=old,
        ),
        "upsert": _event(
            action="ai_provider.managed.upsert",
            resource_id=first,
            target_user_id=seed_user.id,
            created_at=old,
        ),
    }
    db_session.add_all(rows.values())
    await db_session.commit()
    ids = {name: row.id for name, row in rows.items()}

    @asynccontextmanager
    async def shared_session():
        yield db_session

    worker = ControlPlaneAuditRetentionWorker(shared_session, batch_size=1, max_batches=1000)
    _, backlog_remaining = await worker.run_once()
    assert backlog_remaining is False

    remaining = set(
        (
            await db_session.execute(
                select(ControlPlaneAuditEvent.id).where(ControlPlaneAuditEvent.id.in_(ids.values()))
            )
        ).scalars()
    )
    assert {name for name, row_id in ids.items() if row_id in remaining} == {
        "read_denied",
        "first_recent_replace",
        "first_latest_replace",
        "first_failed_replace",
        "first_fingerprinted_replace",
        "second_latest_replace",
        "upsert",
    }

    _, backlog_remaining = await worker.run_once()
    assert backlog_remaining is False
    assert (
        set(
            (
                await db_session.execute(
                    select(ControlPlaneAuditEvent.id).where(
                        ControlPlaneAuditEvent.id.in_(ids.values())
                    )
                )
            ).scalars()
        )
        == remaining
    )


class _FakeSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    async def commit(self) -> None:
        return None

    async def rollback(self) -> None:
        return None


@pytest.mark.asyncio
async def test_audit_retention_respects_batch_budget(monkeypatch):
    prune = AsyncMock(side_effect=lambda *_args, **_kwargs: [uuid.uuid4() for _ in range(5)])
    monkeypatch.setattr(retention, "prune_control_plane_audit_noise", prune)
    monkeypatch.setattr(
        retention, "latest_legacy_metadata_replace_audit_ids", AsyncMock(return_value=[])
    )
    worker = ControlPlaneAuditRetentionWorker(lambda: _FakeSession(), batch_size=5, max_batches=3)

    deleted, backlog_remaining = await worker.run_once()

    assert (deleted, backlog_remaining) == (15, True)
    assert prune.await_count == 3


@pytest.mark.asyncio
async def test_audit_retention_advances_cursor_and_terminates(monkeypatch):
    first = sorted(uuid.uuid4() for _ in range(5))
    second = [uuid.uuid4() for _ in range(2)]
    prune = AsyncMock(side_effect=[first, second])
    keep_ids = [uuid.uuid4()]
    monkeypatch.setattr(retention, "prune_control_plane_audit_noise", prune)
    monkeypatch.setattr(
        retention, "latest_legacy_metadata_replace_audit_ids", AsyncMock(return_value=keep_ids)
    )
    worker = ControlPlaneAuditRetentionWorker(lambda: _FakeSession(), batch_size=5, max_batches=10)

    deleted, backlog_remaining = await worker.run_once()

    assert (deleted, backlog_remaining) == (7, False)
    assert [call.kwargs["after"] for call in prune.await_args_list] == [None, first[-1]]
    assert all(call.kwargs["keep_ids"] == keep_ids for call in prune.await_args_list)


@pytest.mark.asyncio
async def test_audit_retention_worker_waits_poll_interval_once_drained(monkeypatch):
    stop = asyncio.Event()
    worker = ControlPlaneAuditRetentionWorker(
        None,
        poll_interval_seconds=60,
        drain_pause_seconds=0,
    )
    runs = 0

    async def fake_run_once(_stop):
        nonlocal runs
        runs += 1
        return 0, False

    monkeypatch.setattr(worker, "run_once", fake_run_once)
    task = asyncio.create_task(worker.run_forever(stop))
    await asyncio.sleep(0.05)
    stop.set()
    await task
    assert runs == 1


@pytest.mark.parametrize("kwargs", [{"batch_size": 0}, {"max_batches": 0}])
def test_audit_retention_rejects_non_positive_bounds(kwargs):
    with pytest.raises(ValueError, match=next(iter(kwargs))):
        ControlPlaneAuditRetentionWorker(None, **kwargs)
