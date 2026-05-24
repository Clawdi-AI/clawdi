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

from app.core.auth import AuthContext, get_auth, optional_web_auth
from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.user import User

TEST_DATABASE_URL = os.getenv("DATABASE_URL", settings.database_url)


@pytest.fixture(autouse=True)
def _ensure_crypto_keys():
    """Make sure vault/JWT keys are valid for the test run.

    The dev ``.env`` ships with placeholder values (comment-only); leaving
    them in place makes vault_crypto / MCP bridge tests blow up at decrypt
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


async def create_env_with_project(
    db_session,
    *,
    user_id,
    machine_id: str,
    machine_name: str,
    agent_type: str = "claude_code",
    os: str = "darwin",
):
    """Test helper: insert an AgentEnvironment together with its
    env-local project and wire `default_project_id`. Mirrors the
    `register_environment` route flow so tests don't have to
    duplicate the inline-project creation pattern. Returns the
    env (with default_project_id populated).
    """
    from app.models.project import PROJECT_KIND_ENVIRONMENT, Project
    from app.models.session import AgentEnvironment

    # Mutual FK: env.default_project_id (NOT NULL) → project.id;
    # project.origin_environment_id (NULLABLE) → env.id. Insert
    # project without origin first, then env pointing at project,
    # then back-fill project.origin_environment_id.
    pending_slug = f"env-{uuid.uuid4().hex[:12]}"
    project = Project(
        user_id=user_id,
        name=f"{machine_name} ({agent_type})",
        slug=pending_slug,
        kind=PROJECT_KIND_ENVIRONMENT,
    )
    db_session.add(project)
    await db_session.flush()

    env = AgentEnvironment(
        user_id=user_id,
        machine_id=machine_id,
        machine_name=machine_name,
        agent_type=agent_type,
        os=os,
        default_project_id=project.id,
    )
    db_session.add(env)
    await db_session.flush()

    project.origin_environment_id = env.id
    await db_session.commit()
    await db_session.refresh(env)
    return env


@pytest_asyncio.fixture
async def seed_user(db_session: AsyncSession) -> User:
    """A throwaway user row scoped to one test, cleaned up in teardown.

    Mirrors the auto-create flow in `_auth_via_clerk_jwt`: every user
    must have a Personal project so the default-project resolver has a
    fallback target. Without this, write paths that resolve project
    server-side would 500 on a fresh test user.
    """
    from app.models.project import PROJECT_KIND_PERSONAL, Project

    user = User(
        clerk_id=f"test_{uuid.uuid4().hex[:12]}",
        email=f"test_{uuid.uuid4().hex[:8]}@clawdi.local",
        name="Test User",
    )
    db_session.add(user)
    await db_session.flush()

    personal = Project(
        user_id=user.id,
        name="Personal",
        slug="personal",
        kind=PROJECT_KIND_PERSONAL,
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
async def project_id(db_session: AsyncSession, seed_user: User) -> str:
    """Personal project id for the seed user.

    Most upload/read tests target this — phase-2 routes are
    project-explicit, and the seed user's Personal project is the
    natural default for tests that don't care about multi-env
    isolation.
    """
    from sqlalchemy import select

    from app.models.project import PROJECT_KIND_PERSONAL, Project

    result = await db_session.execute(
        select(Project.id).where(
            Project.user_id == seed_user.id,
            Project.kind == PROJECT_KIND_PERSONAL,
        )
    )
    return str(result.scalar_one())


@pytest_asyncio.fixture
async def seed_project(db_session: AsyncSession, seed_user: User):
    """The Personal project created alongside seed_user."""
    from sqlalchemy import select

    from app.models.project import PROJECT_KIND_PERSONAL, Project

    result = await db_session.execute(
        select(Project).where(
            Project.user_id == seed_user.id,
            Project.kind == PROJECT_KIND_PERSONAL,
        )
    )
    return result.scalar_one()


@pytest_asyncio.fixture
async def workspace_project(db_session: AsyncSession, seed_user: User):
    """A user-created Custom Project for sharing tests."""
    from app.models.project import PROJECT_KIND_WORKSPACE, Project

    nonce = uuid.uuid4().hex[:8]
    project = Project(
        user_id=seed_user.id,
        name=f"Workspace {nonce}",
        slug=f"workspace-{nonce}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)
    return project


@pytest_asyncio.fixture
async def environment_project(db_session: AsyncSession, seed_user: User):
    """An Agent Project for non-shareable managed-project tests."""
    from sqlalchemy import select

    from app.models.project import Project

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"test-agent-{uuid.uuid4().hex[:8]}",
        machine_name="Test Agent",
    )
    result = await db_session.execute(select(Project).where(Project.id == env.default_project_id))
    return result.scalar_one()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, seed_user: User) -> AsyncIterator[httpx.AsyncClient]:
    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user)

    async def _override_optional_web_auth() -> AuthContext:
        # The dashboard `client` fixture represents a signed-in browser
        # session — public routes that take `optional_web_auth` should
        # see the same identity as `get_auth` would, so owner-detection
        # in the public route works in tests.
        return AuthContext(user=seed_user)

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth
    app.dependency_overrides[optional_web_auth] = _override_optional_web_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def anon_client(
    db_session: AsyncSession, seed_user: User
) -> AsyncIterator[httpx.AsyncClient]:
    """Anonymous client — no Clerk JWT, no API key.

    `seed_user` is still required so the public route's session-by-id
    lookups have an owner to match against, but no auth dependency
    overrides install identity for the request. `optional_web_auth`
    returns None (anonymous); `get_auth` is unset so any owner-only
    route returns 401, exactly like a browser with no cookies.
    """

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_optional_web_auth() -> None:
        return None

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[optional_web_auth] = _override_optional_web_auth
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
