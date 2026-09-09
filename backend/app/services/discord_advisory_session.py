"""One PostgreSQL ownership session for a role's Discord Gateway tasks."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from app.core.database import finish_cleanup

log = logging.getLogger(__name__)


class DiscordAdvisorySessionLost(RuntimeError):
    """The PostgreSQL session cannot prove ownership of its Discord tasks."""


@dataclass
class _Session:
    connection: AsyncConnection
    leases: dict[int, DiscordAdvisoryLease] = field(default_factory=dict)
    monitor: asyncio.Task[None] | None = None
    retirement: asyncio.Task[None] | None = None
    failure: BaseException | None = None
    closing: bool = False


@dataclass(frozen=True)
class DiscordAdvisoryLease:
    key: int
    owner: asyncio.Task[None]
    session: _Session

    @property
    def failed(self) -> bool:
        return self.session.failure is not None


class DiscordAdvisorySession:
    def __init__(
        self,
        engine: AsyncEngine,
        *,
        liveness_interval_seconds: float = 1.0,
        liveness_timeout_seconds: float = 5.0,
    ) -> None:
        self._engine = engine
        self._interval = max(0.001, liveness_interval_seconds)
        self._timeout = max(0.001, liveness_timeout_seconds)
        self._serial = asyncio.Lock()
        self._lifecycle = asyncio.Lock()
        self._session: _Session | None = None
        self._closed = False

    @property
    def failed(self) -> bool:
        return self._session is not None and self._session.failure is not None

    async def _get_session(self) -> _Session:
        # Recovery must be driven by a new claimant, not an old owner whose
        # completion the retirement operation needs to join.
        if self.failed:
            self._check_lifecycle_caller()
        while True:
            async with self._lifecycle:
                if self._closed:
                    raise DiscordAdvisorySessionLost("Discord lock owner is closed")
                if self._session is None:
                    self._session = _Session(await self._engine.connect())
                    self._session.monitor = asyncio.create_task(
                        self._monitor(self._session), name="discord-advisory-session-monitor"
                    )
                if self._session.failure is None:
                    return self._session
                self._check_lifecycle_caller()
                retirement = self._session.retirement
            if retirement is None:
                raise DiscordAdvisorySessionLost("Discord lock retirement is unavailable")
            await asyncio.shield(retirement)

    async def claim(self, key: int | str) -> DiscordAdvisoryLease | None:
        owner = asyncio.current_task()
        if owner is None:
            raise RuntimeError("Discord advisory locks require an asyncio task")
        session = await self._get_session()
        async with self._connection(session) as connection:
            if isinstance(key, str):
                # Preserve the released consumer Account/Link lock identity.
                resolved = await connection.scalar(
                    text("SELECT hashtextextended(:lock_name, 0)"), {"lock_name": key}
                )
                await connection.commit()
                if not isinstance(resolved, int) or isinstance(resolved, bool):
                    raise RuntimeError("Discord consumer advisory key is invalid")
                key = resolved
            # PostgreSQL session locks are reentrant, not local task mutexes.
            if key in session.leases or not await try_advisory_lock(connection, key):
                return None
            if session.closing or session.failure is not None:
                raise DiscordAdvisorySessionLost from session.failure
            lease = DiscordAdvisoryLease(key, owner, session)
            session.leases[key] = lease
            return lease

    async def release(self, lease: DiscordAdvisoryLease) -> None:
        await finish_cleanup(lambda: self._release(lease))

    async def _release(self, lease: DiscordAdvisoryLease) -> None:
        session = lease.session
        if session.failure is not None:
            raise DiscordAdvisorySessionLost from session.failure
        if session.closing:
            return  # Shutdown invalidates the connection after joining owners.
        try:
            async with self._connection(session, lease.owner) as connection:
                if session.leases.get(lease.key) is not lease:
                    return
                if not await release_advisory_lock(connection, lease.key):
                    raise RuntimeError("Discord advisory unlock failed")
                session.leases.pop(lease.key)
        except DiscordAdvisorySessionLost:
            if not session.closing or session.failure is not None:
                raise

    @asynccontextmanager
    async def _connection(
        self, session: _Session, owner: asyncio.Task[None] | None = None
    ) -> AsyncGenerator[AsyncConnection]:
        async with self._serial:
            if session.closing or session.failure is not None:
                raise DiscordAdvisorySessionLost from session.failure
            try:
                async with asyncio.timeout(self._timeout):
                    yield session.connection
            except BaseException as exc:
                self._fail(session, exc, owner)
                if isinstance(exc, asyncio.CancelledError):
                    raise
                raise DiscordAdvisorySessionLost from exc

    def _fail(
        self, session: _Session, exc: BaseException, owner: asyncio.Task[None] | None = None
    ) -> None:
        if session.failure is None and not session.closing:
            session.failure = exc
            for task in {lease.owner for lease in session.leases.values()}:
                if task is not (owner or asyncio.current_task()):
                    task.cancel()
            # Consumers have no discovery loop to reap a failed but still-live
            # PG session. Retire it even if no new Gateway ever arrives.
            session.retirement = asyncio.create_task(
                self._retire_failed_session(session), name="discord-advisory-session-retire"
            )
            session.retirement.add_done_callback(_observe_retirement)

    async def _retire_failed_session(self, session: _Session) -> None:
        async with self._lifecycle:
            await self._retire_session(session)

    async def _monitor(self, session: _Session) -> None:
        try:
            while session.failure is None:
                await asyncio.sleep(self._interval)
                # Include time waiting for claim/release SQL. Driver/transport
                # cancellation cleanup may outlast this application deadline.
                async with asyncio.timeout(self._timeout):
                    async with self._connection(session) as connection:
                        await connection.execute(text("SELECT 1"))
                        await connection.commit()
        except (TimeoutError, DiscordAdvisorySessionLost) as exc:
            self._fail(session, exc)
            log.exception("Discord advisory session lost")

    async def close(self) -> None:
        # Check the real caller before finish_cleanup creates its child task,
        # and before waiting behind a retirement that may already join it.
        self._check_lifecycle_caller()
        await finish_cleanup(self._close)

    async def _close(self) -> None:
        async with self._lifecycle:
            self._closed = True
            retirement = self._session.retirement if self._session is not None else None
            if retirement is None:
                await self._retire_session(self._session)
        if retirement is not None:
            await asyncio.shield(retirement)

    def _check_lifecycle_caller(self) -> None:
        if self._session is not None and any(
            lease.owner is asyncio.current_task() for lease in self._session.leases.values()
        ):
            raise DiscordAdvisorySessionLost(
                "Discord lock session lifecycle requires a task that owns no lease"
            )

    async def _retire_session(self, session: _Session | None) -> None:
        if session is None or self._session is not session:
            return
        session.closing = True
        if session.monitor is not None:
            session.monitor.cancel()
            await asyncio.gather(session.monitor, return_exceptions=True)
        # Drain any claim already executing SQL before snapshotting owners.
        # Never join owners under this gate: their cleanup also needs it.
        async with self._serial:
            owners = {lease.owner for lease in session.leases.values()}
        if session.failure is None:
            for owner in owners:
                owner.cancel()
        if owners:
            await asyncio.gather(*owners, return_exceptions=True)
        async with self._serial:
            try:
                # Even orderly shutdown discards the ownership connection. Never
                # let an uncertain or remaining session lock reenter the pool.
                await session.connection.invalidate()
            finally:
                await session.connection.close()
                session.leases.clear()
                self._session = None


def _observe_retirement(task: asyncio.Task[None]) -> None:
    if not task.cancelled() and (error := task.exception()) is not None:
        log.error("Discord advisory session retirement failed", exc_info=error)


async def try_advisory_lock(connection: AsyncConnection, lock_key: int) -> bool:
    result = await connection.execute(
        text("SELECT pg_try_advisory_lock(:lock_key)"), {"lock_key": lock_key}
    )
    await connection.commit()
    return result.scalar_one() is True


async def release_advisory_lock(connection: AsyncConnection, lock_key: int) -> bool:
    result = await connection.execute(
        text("SELECT pg_advisory_unlock(:lock_key)"), {"lock_key": lock_key}
    )
    await connection.commit()
    return result.scalar_one() is True
