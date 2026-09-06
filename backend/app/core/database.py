import asyncio
import logging
import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import anyio
from sqlalchemy import event
from sqlalchemy.engine import Connection, ExceptionContext
from sqlalchemy.engine.interfaces import DBAPIConnection, DBAPICursor, ExecutionContext
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import ConnectionPoolEntry, PoolProxiedConnection

from app.core.config import settings
from app.services.metrics import (
    db_connection_hold_duration,
    db_pool_checked_out,
    db_query_duration,
)

log = logging.getLogger(__name__)

_QUERY_STARTED_AT = "clawdi_query_started_at"
_CONNECTION_CHECKED_OUT_AT = "clawdi_connection_checked_out_at"

# Reserved for internal control, never borrowed by ordinary requests or workers.
# config/deploy.yml deducts these slots from the web role's ordinary pool budget.
CONTROL_POOL_SIZE = 1


def _create_engine(
    *, pool_size: int, max_overflow: int, lock_timeout: str | None = None
) -> AsyncEngine:
    server_settings = {
        "statement_timeout": "120s",
        "idle_in_transaction_session_timeout": "5min",
    }
    if lock_timeout is not None:
        server_settings["lock_timeout"] = lock_timeout
    return create_async_engine(
        settings.database_url,
        echo=settings.debug,
        hide_parameters=True,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_timeout=settings.db_pool_timeout,
        pool_recycle=settings.db_pool_recycle,
        pool_pre_ping=True,
        # Alembic's separate engine does not inherit runtime request safeguards.
        connect_args={"server_settings": server_settings},
    )


engine = _create_engine(pool_size=settings.db_pool_size, max_overflow=settings.db_max_overflow)
# SQLAlchemy opens connections lazily; non-API roles never check out this pool.
control_engine = _create_engine(pool_size=CONTROL_POOL_SIZE, max_overflow=0, lock_timeout="5s")
# Runtime-source reads retain an authorization transaction while opening a
# separate consistent snapshot. Reserve its slot separately to avoid nested
# checkout deadlocks between concurrent control requests.
control_snapshot_engine = _create_engine(pool_size=1, max_overflow=0)


def _finish_query(connection: Connection) -> None:
    started = connection.info.pop(_QUERY_STARTED_AT, None)
    if isinstance(started, float):
        db_query_duration.observe(time.perf_counter() - started)


def _before_cursor_execute(
    connection: Connection,
    _cursor: DBAPICursor,
    _statement: str,
    _parameters: object,
    _context: ExecutionContext | None,
    _executemany: bool,
) -> None:
    connection.info[_QUERY_STARTED_AT] = time.perf_counter()


def _after_cursor_execute(
    connection: Connection,
    _cursor: DBAPICursor,
    _statement: str,
    _parameters: object,
    _context: ExecutionContext | None,
    _executemany: bool,
) -> None:
    _finish_query(connection)


def _handle_error(exception_context: ExceptionContext) -> None:
    if exception_context.connection is not None:
        _finish_query(exception_context.connection)


def _connection_checkout(
    _dbapi_connection: DBAPIConnection,
    connection_record: ConnectionPoolEntry,
    _connection_proxy: PoolProxiedConnection,
) -> None:
    connection_record.info[_CONNECTION_CHECKED_OUT_AT] = time.perf_counter()
    db_pool_checked_out.inc()


def _connection_checkin(
    _dbapi_connection: DBAPIConnection | None,
    connection_record: ConnectionPoolEntry,
) -> None:
    started = connection_record.info.pop(_CONNECTION_CHECKED_OUT_AT, None)
    if isinstance(started, float):
        db_connection_hold_duration.observe(time.perf_counter() - started)
        db_pool_checked_out.dec()


for observed_engine in (engine, control_engine, control_snapshot_engine):
    event.listen(observed_engine.sync_engine, "before_cursor_execute", _before_cursor_execute)
    event.listen(observed_engine.sync_engine, "after_cursor_execute", _after_cursor_execute)
    event.listen(observed_engine.sync_engine, "handle_error", _handle_error)
    event.listen(observed_engine.sync_engine.pool, "checkout", _connection_checkout)
    event.listen(observed_engine.sync_engine.pool, "checkin", _connection_checkin)


async def _close_session(session: AsyncSession) -> None:
    """Return the connection before propagating request cancellation."""
    close_task = asyncio.create_task(session.close())
    cancellation: asyncio.CancelledError | None = None

    with anyio.CancelScope(shield=True):
        while not close_task.done():
            try:
                await asyncio.shield(close_task)
            except asyncio.CancelledError as exc:
                cancellation = exc
            except Exception as exc:
                if cancellation is None:
                    raise

                log.exception("Database session cleanup failed during request cancellation")
                raise cancellation from exc

    try:
        close_task.result()
    except Exception as exc:
        if cancellation is None:
            raise

        log.exception("Database session cleanup failed during request cancellation")
        raise cancellation from exc

    if cancellation is not None:
        raise cancellation


class _CancellationSafeAsyncSession(AsyncSession):
    async def __aexit__(self, type_: object, value: object, traceback: object) -> None:
        await _close_session(self)


async_session_factory: async_sessionmaker[AsyncSession] = async_sessionmaker(
    engine,
    class_=_CancellationSafeAsyncSession,
    expire_on_commit=False,
)
control_session_factory: async_sessionmaker[AsyncSession] = async_sessionmaker(
    control_engine,
    class_=_CancellationSafeAsyncSession,
    expire_on_commit=False,
)
control_snapshot_session_factory: async_sessionmaker[AsyncSession] = async_sessionmaker(
    control_snapshot_engine,
    class_=_CancellationSafeAsyncSession,
    expire_on_commit=False,
)


class ControlLockTimeoutError(RuntimeError):
    """PostgreSQL could not acquire a control transaction's lock in time."""


@asynccontextmanager
async def _control_session() -> AsyncGenerator[AsyncSession, None]:
    try:
        async with control_session_factory() as session:
            yield session
    except DBAPIError as exc:
        if getattr(exc.orig, "sqlstate", None) == "55P03":
            raise ControlLockTimeoutError() from None
        raise


async def get_control_session() -> AsyncGenerator[AsyncSession, None]:
    """Deployment/recovery control and its authentication, never channel management."""
    async with _control_session() as session:
        yield session


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    session = async_session_factory()
    try:
        yield session
    finally:
        await _close_session(session)


async def get_runtime_observation_session() -> AsyncGenerator[AsyncSession, None]:
    """Open an internal control observation snapshot that may persist expiry.

    Successful reads remain side-effect free. A known consumer presenting an
    unknown or stale cursor must, however, atomically persist its explicit reset
    boundary before returning the fail-closed protocol error, so this snapshot
    cannot be PostgreSQL read-only.
    """

    async with _control_session() as session:
        await session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        yield session


@asynccontextmanager
async def runtime_snapshot_session(
    *, session_factory: async_sessionmaker[AsyncSession] | None = None
) -> AsyncGenerator[AsyncSession, None]:
    """Open the consistent read-only snapshot shared by runtime renderers."""
    session = (session_factory or async_session_factory)()
    try:
        await _configure_runtime_snapshot(session)
        yield session
    finally:
        await _close_session(session)


async def _configure_runtime_snapshot(session: AsyncSession) -> None:
    await session.connection(
        execution_options={
            "isolation_level": "REPEATABLE READ",
            "postgresql_readonly": True,
        }
    )
