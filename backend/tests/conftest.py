"""Pytest fixtures shared across the backend test suite.

Strategy:
- Hit the *real* Postgres (with pgvector + pg_trgm) provisioned by CI. Mocking
  the DB would diverge from production for vector / trigram queries and cascade
  semantics.
- Most tests run inside an outer transaction.  The ORM session joins it with
  ``create_savepoint``, so application commits remain test-local and teardown
  is one rollback.  Tests that need committed visibility from independent
  connections use the ``committed_db`` lane (or ``committed_db_session``
  directly) explicitly.
- Each test gets an ``AsyncClient`` with scoped dependency overrides pointing
  at its deterministic test user and session.
"""

from __future__ import annotations

import os
import secrets
import socket
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, contextmanager
from hashlib import sha256

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.auth import AuthContext, get_auth, get_auth_short_session, optional_web_auth
from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.user import User

TEST_DATABASE_URL = os.getenv("DATABASE_URL", settings.database_url)
_TEST_PUBLIC_DNS_HOSTS = {
    "api.telegram.org",
    "discord.com",
    "gateway.discord.gg",
    "graph.facebook.com",
}
_TEST_PUBLIC_DNS_SUFFIXES = (".example", ".test")


def worker_test_identity(nodeid: str, worker: str) -> str:
    digest = sha256(nodeid.encode()).hexdigest()[:16]
    return f"{worker}-{digest}"


@pytest.fixture
def test_identity(request: pytest.FixtureRequest) -> str:
    """Stable, worker-qualified identity for rows owned by one test."""
    return worker_test_identity(request.node.nodeid, os.getenv("PYTEST_XDIST_WORKER", "main"))


@pytest.fixture(autouse=True)
def _restore_dependency_overrides():
    """Restore the exact pre-test FastAPI override map, including nesting."""
    previous = dict(app.dependency_overrides)
    try:
        yield
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)


@contextmanager
def _dependency_overrides(overrides):
    previous = dict(app.dependency_overrides)
    app.dependency_overrides.update(overrides)
    try:
        yield
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)


@pytest.fixture(autouse=True)
def _test_runtime_settings():
    """Keep expensive or unsafe runtime defaults out of tests.

    The dev ``.env`` ships with placeholder values (comment-only); leaving
    them in place makes vault_crypto / MCP bridge tests blow up at decrypt
    time with cryptic errors. Override with per-run random keys so tests
    never accidentally use prod keys either.

    The production default memory embedder is a local fastembed model. It is
    intentionally warmed during ASGI lifespan, but most tests do not exercise
    semantic memory and should not pay that startup cost.
    """
    prev_vault = settings.vault_encryption_key
    prev_jwt = settings.encryption_key
    prev_embedding_mode = settings.memory_embedding_mode
    prev_channel_long_poll_max = settings.channel_long_poll_max_seconds
    prev_channel_long_poll_interval = settings.channel_long_poll_interval_seconds
    prev_discord_gateway_poll_interval = settings.discord_gateway_poll_interval_seconds
    settings.vault_encryption_key = secrets.token_hex(32)
    settings.encryption_key = secrets.token_hex(32)
    settings.memory_embedding_mode = "disabled"
    settings.channel_long_poll_max_seconds = 0.05
    settings.channel_long_poll_interval_seconds = 0.005
    settings.discord_gateway_poll_interval_seconds = 0.01
    try:
        yield
    finally:
        settings.vault_encryption_key = prev_vault
        settings.encryption_key = prev_jwt
        settings.memory_embedding_mode = prev_embedding_mode
        settings.channel_long_poll_max_seconds = prev_channel_long_poll_max
        settings.channel_long_poll_interval_seconds = prev_channel_long_poll_interval
        settings.discord_gateway_poll_interval_seconds = prev_discord_gateway_poll_interval


@pytest.fixture(autouse=True)
def _test_reserved_domain_dns(monkeypatch):
    real_getaddrinfo = socket.getaddrinfo

    def fake_getaddrinfo(host, port, *args, **kwargs):
        hostname = host.decode() if isinstance(host, bytes) else str(host)
        normalized = hostname.strip().lower().rstrip(".")
        if normalized in _TEST_PUBLIC_DNS_HOSTS or normalized.endswith(_TEST_PUBLIC_DNS_SUFFIXES):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port or 0))]
        return real_getaddrinfo(host, port, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)


@pytest_asyncio.fixture(scope="session")
async def engine():
    """Session engine bound to pytest's session-scoped event loop.

    asyncpg's pool binds futures to the event loop that created them, so this
    depends on ``asyncio_default_*_loop_scope = "session"`` in pyproject.toml.
    Individual tests still get isolated sessions and throwaway users.
    """
    eng = create_async_engine(TEST_DATABASE_URL, echo=False, future=True)
    try:
        yield eng
    finally:
        await eng.dispose()


@pytest_asyncio.fixture
async def db_session(engine, request: pytest.FixtureRequest) -> AsyncIterator[AsyncSession]:
    """Rollback-isolated session whose commits stay inside the outer transaction.

    This is SQLAlchemy's documented test-suite recipe. PostgreSQL/asyncpg have
    real SAVEPOINT support, unlike SQLite drivers with incomplete SAVEPOINT
    handling: https://docs.sqlalchemy.org/en/20/orm/session_transaction.html
    """
    if request.node.get_closest_marker("committed_db"):
        sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
        async with sessionmaker() as session:
            yield session
        return

    async with rollback_session(engine) as session:
        yield session


@asynccontextmanager
async def rollback_session(engine) -> AsyncIterator[AsyncSession]:
    """Own an outer transaction and always roll it back, including on errors."""
    async with engine.connect() as connection:
        transaction = await connection.begin()
        session = AsyncSession(
            bind=connection,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        )
        try:
            yield session
        finally:
            await session.close()
            if transaction.is_active:
                await transaction.rollback()


@pytest_asyncio.fixture
async def committed_db_session(engine) -> AsyncIterator[AsyncSession]:
    """Independent-connection lane for commit visibility and concurrency tests."""
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as session:
        try:
            yield session
        finally:
            await session.rollback()


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
    from app.services.agent_environments import local_machine_registration_key

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
        default_name=None,
        agent_type=agent_type,
        os=os,
        default_project_id=project.id,
        registration_key=local_machine_registration_key(machine_id, agent_type),
    )
    db_session.add(env)
    await db_session.flush()

    project.origin_environment_id = env.id
    await db_session.commit()
    await db_session.refresh(env)
    return env


@pytest_asyncio.fixture
async def seed_user(
    db_session: AsyncSession, test_identity: str, request: pytest.FixtureRequest
) -> User:
    """A deterministic user row scoped to one rollback-isolated test.

    Mirrors the auto-create flow in `_auth_via_clerk_jwt`: every user
    must have a Personal project so the default-project resolver has a
    fallback target. Without this, write paths that resolve project
    server-side would 500 on a fresh test user.
    """
    from app.models.project import PROJECT_KIND_PERSONAL, Project

    user = User(
        clerk_id=f"test_{test_identity}",
        email=f"test-{test_identity}@clawdi.local",
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
        if request.node.get_closest_marker("committed_db"):
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
async def channel_agent(db_session: AsyncSession, seed_user: User):
    return await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"channel-agent-{uuid.uuid4().hex[:8]}",
        machine_name="Channel Test Agent",
    )


@pytest_asyncio.fixture
async def second_channel_agent(db_session: AsyncSession, seed_user: User):
    return await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"channel-agent-2-{uuid.uuid4().hex[:8]}",
        machine_name="Second Channel Test Agent",
    )


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

    overrides = {
        get_session: _override_get_session,
        get_auth: _override_get_auth,
        get_auth_short_session: _override_get_auth,
        optional_web_auth: _override_optional_web_auth,
    }
    with _dependency_overrides(overrides):
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


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

    with _dependency_overrides(
        {
            get_session: _override_get_session,
            optional_web_auth: _override_optional_web_auth,
        }
    ):
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


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

    with _dependency_overrides(
        {
            get_session: _override_get_session,
            get_auth: _override_get_auth,
            get_auth_short_session: _override_get_auth,
        }
    ):
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
