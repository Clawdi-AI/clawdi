from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import settings
from app.services.channels import channel_queue_snapshots, prune_channel_retention_batch
from app.services.metrics import (
    channel_queue_oldest_pending_age,
    channel_queue_pending,
    channel_queue_stuck_pending,
    channel_retention_budget_exhaustions,
    channel_retention_deletions,
)

log = logging.getLogger(__name__)


class ChannelMessageRetentionWorker:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        poll_interval_seconds: float = 60 * 60,
        batch_size: int | None = None,
        max_batches: int | None = None,
        stuck_pending_hours: int | None = None,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._poll_interval_seconds = poll_interval_seconds
        self._batch_size = (
            settings.channel_message_cleanup_batch_size if batch_size is None else batch_size
        )
        self._max_batches = (
            settings.channel_message_cleanup_max_batches if max_batches is None else max_batches
        )
        self._stuck_pending_hours = (
            settings.channel_message_stuck_pending_hours
            if stuck_pending_hours is None
            else stuck_pending_hours
        )
        if self._batch_size <= 0:
            raise ValueError("channel retention batch_size must be positive")
        if self._max_batches <= 0:
            raise ValueError("channel retention max_batches must be positive")
        if self._stuck_pending_hours <= 0:
            raise ValueError("channel retention stuck_pending_hours must be positive")

    async def run_once(self, stop: asyncio.Event | None = None) -> int:
        stop_event = stop or asyncio.Event()
        current_time = datetime.now(UTC)
        deleted_total = 0
        last_saturated: tuple[str, ...] = ()
        batches = 0
        while batches < self._max_batches and not stop_event.is_set():
            async with self._sessionmaker() as db:
                batch = await prune_channel_retention_batch(
                    db,
                    now=current_time,
                    limit=self._batch_size,
                )
                await db.commit()
            batches += 1
            deleted_total += batch.total
            for record_kind, deleted in (
                ("messages", batch.messages),
                ("debug_events", batch.debug_events),
                ("pair_codes", batch.pair_codes),
                ("agent_references", batch.agent_references),
            ):
                if deleted:
                    channel_retention_deletions.labels(record_kind=record_kind).inc(deleted)
            last_saturated = batch.saturated_kinds(self._batch_size)
            if not last_saturated:
                break
            await asyncio.sleep(0)

        if batches == self._max_batches and last_saturated:
            for record_kind in last_saturated:
                channel_retention_budget_exhaustions.labels(record_kind=record_kind).inc()
            log.warning(
                "channel retention batch budget exhausted: record_kinds=%s batches=%s "
                "batch_size=%s deleted=%s",
                ",".join(last_saturated),
                batches,
                self._batch_size,
                deleted_total,
            )
        if not stop_event.is_set():
            await self._observe_queues(now=datetime.now(UTC))
        if deleted_total:
            log.info(
                "channel retention completed: deleted=%s batches=%s",
                deleted_total,
                batches,
            )
        return deleted_total

    async def _observe_queues(self, *, now: datetime) -> None:
        async with self._sessionmaker() as db:
            snapshots = await channel_queue_snapshots(
                db,
                now=now,
                stuck_after=timedelta(hours=self._stuck_pending_hours),
            )
            await db.rollback()
        for snapshot in snapshots:
            labels = {"provider": snapshot.provider, "queue": snapshot.queue}
            oldest_age_seconds = (
                max(0.0, (now - snapshot.oldest_pending_at).total_seconds())
                if snapshot.oldest_pending_at is not None
                else 0.0
            )
            channel_queue_pending.labels(**labels).set(snapshot.pending_count)
            channel_queue_stuck_pending.labels(**labels).set(snapshot.stuck_count)
            channel_queue_oldest_pending_age.labels(**labels).set(oldest_age_seconds)
            if snapshot.stuck_count:
                log.warning(
                    "channel queue has stuck pending rows: provider=%s queue=%s pending=%s "
                    "stuck=%s oldest_age_seconds=%.0f threshold_hours=%s",
                    snapshot.provider,
                    snapshot.queue,
                    snapshot.pending_count,
                    snapshot.stuck_count,
                    oldest_age_seconds,
                    self._stuck_pending_hours,
                )

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop_event = stop or asyncio.Event()
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=self._poll_interval_seconds)
            return
        except TimeoutError:
            pass
        while not stop_event.is_set():
            try:
                await self.run_once(stop_event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - cleanup must not stop channel workers.
                log.exception("channel message retention worker failed: %s", exc)
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self._poll_interval_seconds)
            except TimeoutError:
                pass
