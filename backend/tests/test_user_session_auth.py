"""CLI OAuth is user-equivalent for data, but cannot manage credentials."""

from __future__ import annotations

import uuid

import httpx
import pytest
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute, iter_route_contexts
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_web_auth
from app.main import app
from app.models.user import User
from tests.conftest import create_env_with_project
from tests.test_agent_endpoints import _register_agent, _set_oauth_cli_auth
from tests.test_session_deletion import _create_session


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path", ["/v1/agents", "/v1/environments", "/api/agents", "/api/environments"]
)
async def test_oauth_cli_can_disconnect_agent(
    client: httpx.AsyncClient, seed_user: User, path: str
) -> None:
    agent_id = await _register_agent(client)
    restore_auth = _set_oauth_cli_auth(seed_user)
    try:
        response = await client.delete(f"{path}/{agent_id}")
        assert response.status_code == 204, response.text
        listing = await client.get("/v1/agents")
        assert agent_id not in {agent["id"] for agent in listing.json()}
    finally:
        restore_auth()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path", ["/v1/agents", "/v1/environments", "/api/agents", "/api/environments"]
)
async def test_api_key_cannot_disconnect_agent(
    cli_client: httpx.AsyncClient, db_session: AsyncSession, seed_user: User, path: str
) -> None:
    agent = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=uuid.uuid4().hex,
        machine_name="Permission test laptop",
        agent_type="codex",
    )
    response = await cli_client.delete(f"{path}/{agent.id}")
    assert response.status_code == 403, response.text
    assert response.json()["detail"] == "This endpoint is not available to API keys"
    await db_session.refresh(agent)
    assert agent.archived_at is None


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["/v1", "/api"])
async def test_oauth_cli_can_delete_session(
    client: httpx.AsyncClient, db_session: AsyncSession, seed_user: User, prefix: str
) -> None:
    session = await _create_session(
        db_session, user_id=seed_user.id, local_session_id=f"oauth-delete-{uuid.uuid4().hex}"
    )
    restore_auth = _set_oauth_cli_auth(seed_user)
    try:
        response = await client.delete(f"{prefix}/sessions/{session.id}")
        assert response.status_code == 204, response.text
        assert (await client.get(f"/v1/sessions/{session.id}")).status_code == 404
    finally:
        restore_auth()


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["/v1", "/api"])
async def test_api_key_cannot_delete_session(
    cli_client: httpx.AsyncClient, db_session: AsyncSession, seed_user: User, prefix: str
) -> None:
    session = await _create_session(
        db_session, user_id=seed_user.id, local_session_id=f"key-delete-{uuid.uuid4().hex}"
    )
    response = await cli_client.delete(f"{prefix}/sessions/{session.id}")
    assert response.status_code == 403, response.text
    await db_session.refresh(session)


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["/v1", "/api"])
@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/auth/keys"),
        ("DELETE", "/auth/keys/test-key"),
    ],
)
async def test_oauth_cli_cannot_manage_credentials(
    client: httpx.AsyncClient, seed_user: User, prefix: str, method: str, path: str
) -> None:
    restore_auth = _set_oauth_cli_auth(seed_user)
    try:
        response = await client.request(
            method,
            f"{prefix}{path}",
            params={"code": "ABCD-EFGH"} if path.endswith("lookup") else None,
            json={"user_code": "ABCD-EFGH"} if method == "POST" else None,
        )
        assert response.status_code == 403, response.text
        assert response.json()["detail"] == "This endpoint requires dashboard authentication"
    finally:
        restore_auth()


def _requires_web_auth(dependant: Dependant) -> bool:
    return dependant.call is require_web_auth or any(
        _requires_web_auth(child) for child in dependant.dependencies
    )


def test_only_credential_and_device_routes_require_browser_auth() -> None:
    expected = {
        (method, f"{prefix}{path}")
        for prefix in ("/v1", "/api")
        for method, path in (
            ("GET", "/auth/keys"),
            ("DELETE", "/auth/keys/{key_id}"),
        )
    }
    actual = {
        (method, route.path)
        for route in iter_route_contexts(app.routes)
        if isinstance(route.original_route, APIRoute) and _requires_web_auth(route.dependant)
        for method in route.methods
    }
    assert actual == expected
