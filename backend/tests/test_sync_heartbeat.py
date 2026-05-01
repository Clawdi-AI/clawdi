"""sync-heartbeat endpoint + EnvironmentResponse sync fields.

Daemons hit this every ~30s. The dashboard reads
EnvironmentResponse to paint its "online / errored / offline"
badges. Both sides must round-trip: what the daemon writes is
what the dashboard sees.

Plus: an api_key bound to environment A must NOT be allowed to
heartbeat environment B. Without this, a leaked deploy-key from
one pod could overwrite another pod's observability fields and
disguise a broken sync as healthy.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.main import app
from app.models.api_key import ApiKey


async def _create_env(client: httpx.AsyncClient) -> str:
    """Register an env via the public route — fixture-style helper.
    Returns the new env_id. Uses a random machine_id so concurrent
    test runs don't collide in the shared test DB."""
    body = {
        "machine_id": uuid.uuid4().hex,
        "machine_name": "test-laptop",
        "agent_type": "claude_code",
        "os": "darwin",
    }
    r = await client.post("/api/environments", json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


@pytest.mark.asyncio
async def test_heartbeat_writes_observability_fields(
    client: httpx.AsyncClient,
):
    env_id = await _create_env(client)

    payload = {
        "last_revision_seen": 7,
        "last_sync_error": None,
        "queue_depth": 3,
        "dropped_count_delta": 0,
    }
    r = await client.post(f"/api/agents/{env_id}/sync-heartbeat", json=payload)
    assert r.status_code == 204, r.text

    # Round-trip through the public env GET — what the daemon
    # wrote must be what the dashboard reads.
    detail = (await client.get(f"/api/environments/{env_id}")).json()
    assert detail["last_revision_seen"] == 7
    assert detail["queue_depth_high_water"] == 3
    assert detail["last_sync_error"] is None
    assert detail["last_sync_at"] is not None  # was None pre-heartbeat


@pytest.mark.asyncio
async def test_heartbeat_high_water_only_grows(client: httpx.AsyncClient):
    """`queue_depth_high_water` is monotonic — a heartbeat with a
    smaller queue_depth must NOT lower the recorded peak.
    Otherwise the dashboard underreports a daemon that briefly
    blew up the queue then drained it."""
    env_id = await _create_env(client)

    await client.post(
        f"/api/agents/{env_id}/sync-heartbeat",
        json={"queue_depth": 50},
    )
    await client.post(
        f"/api/agents/{env_id}/sync-heartbeat",
        json={"queue_depth": 5},
    )
    detail = (await client.get(f"/api/environments/{env_id}")).json()
    assert detail["queue_depth_high_water"] == 50


@pytest.mark.asyncio
async def test_heartbeat_dropped_count_accumulates(client: httpx.AsyncClient):
    """The daemon sends a delta (since last heartbeat); server
    keeps a running counter. A buggy daemon that always sends 0
    won't move the needle, but a daemon dropping events will."""
    env_id = await _create_env(client)

    await client.post(
        f"/api/agents/{env_id}/sync-heartbeat",
        json={"dropped_count_delta": 3},
    )
    await client.post(
        f"/api/agents/{env_id}/sync-heartbeat",
        json={"dropped_count_delta": 2},
    )
    detail = (await client.get(f"/api/environments/{env_id}")).json()
    assert detail["dropped_count"] == 5


@pytest.mark.asyncio
async def test_heartbeat_unknown_env_is_404(client: httpx.AsyncClient):
    fake_id = uuid.uuid4()
    r = await client.post(f"/api/agents/{fake_id}/sync-heartbeat", json={"queue_depth": 0})
    assert r.status_code == 404


@pytest_asyncio.fixture
async def env_bound_cli_client(
    db_session: AsyncSession, seed_user
) -> AsyncIterator[tuple[httpx.AsyncClient, str, str]]:
    """A CLI-style client whose api_key is bound to a specific
    environment_id. Yields (client, bound_env_id, other_env_id) so
    tests can assert the bound key works on its own env and 403s
    on another env owned by the same user."""
    from tests.conftest import create_env_with_scope

    bound_env = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="bound",
        machine_name="bound",
    )
    other_env = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="other",
        machine_name="other",
    )

    bound_id = str(bound_env.id)
    other_id = str(other_env.id)

    # Build an api_key bound to bound_env. We don't insert it —
    # the auth override returns it directly, which is enough for
    # the 403 path because the route only inspects api_key fields.
    placeholder_key = ApiKey(
        user_id=seed_user.id,
        key_hash="x" * 64,
        key_prefix="x" * 16,
        label="bound-test",
        scopes=["sessions:write", "skills:read", "skills:write"],
        environment_id=bound_env.id,
    )

    async def _override_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=placeholder_key)

    app.dependency_overrides[get_session] = _override_session
    app.dependency_overrides[get_auth] = _override_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac, bound_id, other_id
    finally:
        app.dependency_overrides.clear()
        # Best-effort cleanup so we don't leave envs littered.
        await db_session.delete(bound_env)
        await db_session.delete(other_env)
        await db_session.commit()


@pytest.mark.asyncio
async def test_bound_key_can_heartbeat_its_own_env(env_bound_cli_client):
    client, bound_id, _other_id = env_bound_cli_client
    r = await client.post(f"/api/agents/{bound_id}/sync-heartbeat", json={"queue_depth": 1})
    assert r.status_code == 204, r.text


@pytest.mark.asyncio
async def test_bound_key_cannot_heartbeat_another_env(env_bound_cli_client):
    client, _bound_id, other_id = env_bound_cli_client
    r = await client.post(f"/api/agents/{other_id}/sync-heartbeat", json={"queue_depth": 1})
    assert r.status_code == 403, r.text
