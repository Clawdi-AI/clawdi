from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import ColumnElement, all_, and_, bindparam, delete, or_, select
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.audit import ControlPlaneAuditEvent

log = logging.getLogger(__name__)

MANAGED_PROVIDER_READ_ACTION = "ai_provider.managed.read"
MANAGED_PROVIDER_METADATA_REPLACE_ACTION = "ai_provider.managed.runtime_metadata.replace"
# Replace rows written before change fingerprints existed cannot prove a change.
LEGACY_METADATA_REPLACE_RETENTION = timedelta(days=30)
METADATA_FINGERPRINT_KEY = "metadata_before"


def _successful(action: str) -> list[ColumnElement[bool]]:
    return [
        ControlPlaneAuditEvent.action == action,
        ControlPlaneAuditEvent.details["outcome"].astext == "success",
    ]


def _legacy_metadata_replace() -> list[ColumnElement[bool]]:
    return [
        *_successful(MANAGED_PROVIDER_METADATA_REPLACE_ACTION),
        ~ControlPlaneAuditEvent.details.has_key(METADATA_FINGERPRINT_KEY),
    ]


async def latest_legacy_metadata_replace_audit_ids(db: AsyncSession) -> list[UUID]:
    """Return the newest legacy replace row for each provider and owner."""

    return list(
        (
            await db.execute(
                select(ControlPlaneAuditEvent.id)
                .where(*_legacy_metadata_replace())
                .distinct(
                    ControlPlaneAuditEvent.resource_id,
                    ControlPlaneAuditEvent.target_user_id,
                )
                .order_by(
                    ControlPlaneAuditEvent.resource_id,
                    ControlPlaneAuditEvent.target_user_id,
                    ControlPlaneAuditEvent.created_at.desc(),
                    ControlPlaneAuditEvent.id.desc(),
                )
            )
        ).scalars()
    )


async def prune_control_plane_audit_noise(
    db: AsyncSession,
    *,
    now: datetime,
    keep_ids: Sequence[UUID],
    after: UUID | None,
    limit: int,
) -> list[UUID]:
    """Delete one primary-key-ordered batch of no-op audit rows after a cursor.

    Successful managed-provider reads are always noise. Legacy replace rows are
    deleted only once aged out, and keep_ids (the newest per provider) survive.
    The keyset walk keeps each run linear on the large audit table.
    """

    if limit <= 0:
        raise ValueError("audit retention limit must be positive")
    keep = bindparam(
        "keep_ids",
        list(keep_ids),
        type_=ARRAY(PG_UUID(as_uuid=True)),
    )
    conditions: list[ColumnElement[bool]] = [
        or_(
            and_(*_successful(MANAGED_PROVIDER_READ_ACTION)),
            and_(
                *_legacy_metadata_replace(),
                ControlPlaneAuditEvent.created_at < now - LEGACY_METADATA_REPLACE_RETENTION,
                ControlPlaneAuditEvent.id != all_(keep),
            ),
        )
    ]
    if after is not None:
        conditions.append(ControlPlaneAuditEvent.id > after)
    row_ids = list(
        (
            await db.execute(
                select(ControlPlaneAuditEvent.id)
                .where(*conditions)
                .order_by(ControlPlaneAuditEvent.id)
                .limit(limit)
            )
        ).scalars()
    )
    if row_ids:
        await db.execute(
            delete(ControlPlaneAuditEvent).where(ControlPlaneAuditEvent.id.in_(row_ids))
        )
    return row_ids


class ControlPlaneAuditRetentionWorker:
    """Drain no-op managed-provider audit noise in bounded, committed batches."""

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        poll_interval_seconds: float = 60 * 60,
        drain_pause_seconds: float = 5,
        batch_size: int = 2000,
        max_batches: int = 100,
    ) -> None:
        if batch_size <= 0:
            raise ValueError("audit retention batch_size must be positive")
        if max_batches <= 0:
            raise ValueError("audit retention max_batches must be positive")
        self._sessionmaker = sessionmaker
        self._poll_interval_seconds = poll_interval_seconds
        self._drain_pause_seconds = drain_pause_seconds
        self._batch_size = batch_size
        self._max_batches = max_batches

    async def run_once(self, stop: asyncio.Event | None = None) -> tuple[int, bool]:
        """Return deleted rows and whether backlog remains after the batch budget."""

        stop_event = stop or asyncio.Event()
        now = datetime.now(UTC)
        async with self._sessionmaker() as db:
            keep_ids = await latest_legacy_metadata_replace_audit_ids(db)
            await db.rollback()
        cursor: UUID | None = None
        batches = 0
        deleted = 0
        drained = False
        while batches < self._max_batches and not stop_event.is_set():
            async with self._sessionmaker() as db:
                row_ids = await prune_control_plane_audit_noise(
                    db,
                    now=now,
                    keep_ids=keep_ids,
                    after=cursor,
                    limit=self._batch_size,
                )
                await db.commit()
            batches += 1
            deleted += len(row_ids)
            if len(row_ids) < self._batch_size:
                drained = True
                break
            cursor = row_ids[-1]
            await asyncio.sleep(0)

        if deleted:
            log.info(
                "control plane audit retention completed: deleted=%s batches=%s",
                deleted,
                batches,
            )
        return deleted, not drained

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop_event = stop or asyncio.Event()
        while not stop_event.is_set():
            try:
                _, backlog_remaining = await self.run_once(stop_event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - cleanup must not stop other workers.
                log.exception("control plane audit retention worker failed: %s", exc)
                backlog_remaining = False
            pause_seconds = (
                self._drain_pause_seconds if backlog_remaining else self._poll_interval_seconds
            )
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=pause_seconds)
            except TimeoutError:
                pass
