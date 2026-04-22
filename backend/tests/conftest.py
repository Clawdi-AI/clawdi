"""Pytest fixtures shared across the backend test suite.

Strategy:
- Hit the *real* Postgres (with pgvector + pg_trgm) provisioned by CI. Mocking
  the DB would diverge from production for vector / trigram queries and cascade
  semantics.
- Each test gets an ``AsyncClient`` with ``get_auth`` and ``get_session``
  overridden to point at an on-the-fly test user + session.
- We deliberately skip nested-SAVEPOINT rollback isolation: async SQLAlchemy +
  asyncpg doesn't cleanly support it and our smoke tests are self-contained
  enough that per-test cleanup is cheaper than transactional gymnastics.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator

import httpx
import pytest_asyncio
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.user import User

TEST_DATABASE_URL = os.getenv("DATABASE_URL", settings.database_url)


@pytest_asyncio.fixture
async def engine():
    """Per-test engine bound to the test's event loop.

    A session-scoped engine would be cheaper, but asyncpg's connection pool
    binds futures to the loop that created them and blows up when a later
    test tries to reuse the connection from a different loop. Per-test is
    the least-surprising option for small test suites; revisit if test
    startup time becomes a real bottleneck.
    """
    eng = create_async_engine(TEST_DATABASE_URL, echo=False, future=True)
    try:
        yield eng
    finally:
        await eng.dispose()


@pytest_asyncio.fixture
async def db_session(engine) -> AsyncIterator[AsyncSession]:
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as session:
        yield session


@pytest_asyncio.fixture
async def seed_user(db_session: AsyncSession) -> User:
    """A throwaway user row scoped to one test, cleaned up in teardown."""
    user = User(
        clerk_id=f"test_{uuid.uuid4().hex[:12]}",
        email=f"test_{uuid.uuid4().hex[:8]}@clawdi.local",
        name="Test User",
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    try:
        yield user
    finally:
        # Best-effort cleanup so the test DB doesn't grow unbounded. Cascade
        # FKs handle related rows; the user row itself is the root.
        await db_session.delete(user)
        await db_session.commit()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, seed_user: User) -> AsyncIterator[httpx.AsyncClient]:
    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user)

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.clear()
