from collections.abc import AsyncGenerator

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
