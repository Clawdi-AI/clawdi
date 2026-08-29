import asyncio
import logging
import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from sqlalchemy import event
from sqlalchemy.engine import Connection, ExceptionContext
from sqlalchemy.engine.interfaces import DBAPIConnection, DBAPICursor, ExecutionContext
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
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

# Explicit pool sizing — sqlalchemy's defaults (5+10) starve at
# ~10k daemons since each SSE refresh tick burns one connection
# for the duration of the visibility query. Production should
# size DB_POOL_SIZE / DB_MAX_OVERFLOW from the expected concurrent
# daemon population (rule of thumb: pool_size = peak_concurrent_qps
# * avg_query_duration_ms / 1000 + safety margin).
engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    hide_parameters=True,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_timeout=settings.db_pool_timeout,
    pool_recycle=settings.db_pool_recycle,
    pool_pre_ping=True,
    # Alembic creates a separate synchronous engine, so long-running DDL does
    # not inherit these runtime request safeguards.
    connect_args={
        "server_settings": {
            "statement_timeout": "120s",
            "idle_in_transaction_session_timeout": "5min",
        }
    },
)


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


event.listen(engine.sync_engine, "before_cursor_execute", _before_cursor_execute)
event.listen(engine.sync_engine, "after_cursor_execute", _after_cursor_execute)
event.listen(engine.sync_engine, "handle_error", _handle_error)
event.listen(engine.sync_engine.pool, "checkout", _connection_checkout)
event.listen(engine.sync_engine.pool, "checkin", _connection_checkin)

async_session_factory = async_sessionmaker(engine, expire_on_commit=False)


async def _close_session(session: AsyncSession) -> None:
    """Return the connection before propagating request cancellation."""
    close_task = asyncio.create_task(session.close())
    cancellation: asyncio.CancelledError | None = None
    while not close_task.done():
        try:
            await asyncio.shield(close_task)
        except asyncio.CancelledError as exc:
            cancellation = exc
        except Exception:
            if cancellation is None:
                raise
            log.exception("Database session cleanup failed during request cancellation")
            raise cancellation from None

    if cancellation is not None:
        try:
            close_task.result()
        except Exception:
            log.exception("Database session cleanup failed during request cancellation")
        raise cancellation
    close_task.result()


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    session = async_session_factory()
    try:
        yield session
    finally:
        await _close_session(session)


async def get_runtime_observation_session() -> AsyncGenerator[AsyncSession, None]:
    """Open one repeatable-read observation snapshot that may persist expiry.

    Successful reads remain side-effect free. A known consumer presenting an
    unknown or stale cursor must, however, atomically persist its explicit reset
    boundary before returning the fail-closed protocol error, so this snapshot
    cannot be PostgreSQL read-only.
    """

    session = async_session_factory()
    try:
        await session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        yield session
    finally:
        await _close_session(session)


@asynccontextmanager
async def runtime_snapshot_session() -> AsyncGenerator[AsyncSession, None]:
    """Open the consistent read-only snapshot shared by runtime renderers."""
    session = async_session_factory()
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
