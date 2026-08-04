from __future__ import annotations

import asyncio
import logging
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.services.principal_lifecycle import (
    claim_principal_cleanup,
    complete_principal_cleanup,
    record_principal_cleanup_failure,
)

log = logging.getLogger(__name__)


class PrincipalLifecycleCleanupWorker:
    """Recover durable principal cleanup work after route/process failure."""

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        poll_interval_seconds: float = 1.0,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._poll_interval_seconds = poll_interval_seconds

    async def run_once(self) -> UUID | None:
        async with self._sessionmaker() as db:
            claim = await claim_principal_cleanup(db)
            await db.commit()
        if claim is None:
            return None

        try:
            async with self._sessionmaker() as db:
                await complete_principal_cleanup(
                    db,
                    lifecycle_id=claim.lifecycle_id,
                    expected_claim_id=claim.claim_id,
                )
                await db.commit()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - every failed cleanup remains durable retry work.
            log.exception(
                "principal lifecycle cleanup failed lifecycle_id=%s",
                claim.lifecycle_id,
            )
            async with self._sessionmaker() as db:
                recorded = await record_principal_cleanup_failure(
                    db,
                    lifecycle_id=claim.lifecycle_id,
                    expected_claim_id=claim.claim_id,
                )
                await db.commit()
            if not recorded:
                log.info(
                    "principal cleanup failure ignored after claim changed lifecycle_id=%s",
                    claim.lifecycle_id,
                )
        return claim.lifecycle_id

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop_event = stop or asyncio.Event()
        while not stop_event.is_set():
            try:
                lifecycle_id = await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - one row cannot stop durable recovery.
                log.exception("principal lifecycle cleanup worker iteration failed")
                lifecycle_id = None
            if lifecycle_id is None:
                try:
                    await asyncio.wait_for(
                        stop_event.wait(),
                        timeout=self._poll_interval_seconds,
                    )
                except TimeoutError:
                    pass


__all__ = ["PrincipalLifecycleCleanupWorker"]
