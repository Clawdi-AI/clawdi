from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

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
)
async_session_factory = async_sessionmaker(engine, expire_on_commit=False)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        yield session


async def get_runtime_snapshot_session() -> AsyncGenerator[AsyncSession, None]:
    async with runtime_snapshot_session() as session:
        yield session


async def get_runtime_observation_session() -> AsyncGenerator[AsyncSession, None]:
    """Open one repeatable-read observation snapshot that may persist expiry.

    Successful reads remain side-effect free. A known consumer presenting an
    unknown or stale cursor must, however, atomically persist its explicit reset
    boundary before returning the fail-closed protocol error, so this snapshot
    cannot be PostgreSQL read-only.
    """

    async with async_session_factory() as session:
        await session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        yield session


@asynccontextmanager
async def runtime_snapshot_session() -> AsyncIterator[AsyncSession]:
    """Open the consistent read-only snapshot shared by runtime renderers."""
    async with async_session_factory() as session:
        await _configure_runtime_snapshot(session)
        yield session


async def _configure_runtime_snapshot(session: AsyncSession) -> None:
    await session.connection(
        execution_options={
            "isolation_level": "REPEATABLE READ",
            "postgresql_readonly": True,
        }
    )
