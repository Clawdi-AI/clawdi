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
import secrets
import uuid
from collections.abc import AsyncIterator

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.user import User

TEST_DATABASE_URL = os.getenv("DATABASE_URL", settings.database_url)


@pytest.fixture(autouse=True, scope="session")
def _ensure_crypto_keys():
    """Make sure vault/JWT keys are valid for the test run.

    The dev ``.env`` ships with placeholder values (comment-only); leaving
    them in place makes vault_crypto / MCP proxy tests blow up at decrypt
    time with cryptic errors. Override with per-run random keys so tests
    never accidentally use prod keys either.
    """
    prev_vault = settings.vault_encryption_key
    prev_jwt = settings.encryption_key
    settings.vault_encryption_key = secrets.token_hex(32)
    settings.encryption_key = secrets.token_hex(32)
    try:
        yield
    finally:
        settings.vault_encryption_key = prev_vault
        settings.encryption_key = prev_jwt


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


async def create_env_with_scope(
    db_session,
    *,
    user_id,
    machine_id: str,
    machine_name: str,
    agent_type: str = "claude_code",
    os: str = "darwin",
):
    """Test helper: insert an AgentEnvironment together with its
    env-local scope and wire `default_scope_id`. Mirrors the
    `register_environment` route flow so tests don't have to
    duplicate the inline-scope creation pattern. Returns the
    env (with default_scope_id populated).
    """
    from app.models.scope import SCOPE_KIND_ENVIRONMENT, Scope
    from app.models.session import AgentEnvironment

    # Mutual FK: env.default_scope_id (NOT NULL) → scope.id;
    # scope.origin_environment_id (NULLABLE) → env.id. Insert
    # scope without origin first, then env pointing at scope,
    # then back-fill scope.origin_environment_id.
    pending_slug = f"env-{uuid.uuid4().hex[:12]}"
    scope = Scope(
        user_id=user_id,
        name=f"{machine_name} ({agent_type})",
        slug=pending_slug,
        kind=SCOPE_KIND_ENVIRONMENT,
    )
    db_session.add(scope)
    await db_session.flush()

    env = AgentEnvironment(
        user_id=user_id,
        machine_id=machine_id,
        machine_name=machine_name,
        agent_type=agent_type,
        os=os,
        default_scope_id=scope.id,
    )
    db_session.add(env)
    await db_session.flush()

    scope.origin_environment_id = env.id
    await db_session.commit()
    await db_session.refresh(env)
    return env


@pytest_asyncio.fixture
async def seed_user(db_session: AsyncSession) -> User:
    """A throwaway user row scoped to one test, cleaned up in teardown.

    Mirrors the auto-create flow in `_auth_via_clerk_jwt`: every user
    must have a Personal scope so the default-scope resolver has a
    fallback target. Without this, write paths that resolve scope
    server-side would 500 on a fresh test user.
    """
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope

    user = User(
        clerk_id=f"test_{uuid.uuid4().hex[:12]}",
        email=f"test_{uuid.uuid4().hex[:8]}@clawdi.local",
        name="Test User",
    )
    db_session.add(user)
    await db_session.flush()

    personal = Scope(
        user_id=user.id,
        name="Personal",
        slug="personal",
        kind=SCOPE_KIND_PERSONAL,
    )
    db_session.add(personal)
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
async def scope_id(db_session: AsyncSession, seed_user: User) -> str:
    """Personal scope id for the seed user. Most upload / read tests
    target this — phase-2 routes are scope-explicit, so the URL needs
    a scope_id and the seed user's Personal scope is the natural
    default for tests that don't care about multi-env isolation."""
    from sqlalchemy import select

    from app.models.scope import SCOPE_KIND_PERSONAL, Scope

    result = await db_session.execute(
        select(Scope.id).where(Scope.user_id == seed_user.id, Scope.kind == SCOPE_KIND_PERSONAL)
    )
    return str(result.scalar_one())


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


@pytest_asyncio.fixture
async def cli_client(db_session: AsyncSession, seed_user: User) -> AsyncIterator[httpx.AsyncClient]:
    """Like ``client`` but the auth context advertises CLI (ApiKey) auth.

    Used to exercise endpoints guarded by ``require_cli_auth``. We don't
    persist a real ApiKey row because ``require_cli_auth`` only checks the
    ``is_cli`` flag — a placeholder ApiKey object is enough.
    """
    from app.models.api_key import ApiKey

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_get_auth() -> AuthContext:
        # ApiKey instance is not persisted; only ``is_cli`` branching matters
        # to the routes we exercise. See app.core.auth.require_cli_auth.
        return AuthContext(user=seed_user, api_key=ApiKey(user_id=seed_user.id))

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.clear()
