from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import urlparse

import httpx
import pytest
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth, get_auth_short_session
from app.main import app
from app.models.api_key import ApiKey
from app.models.hosted_runtime import HostedRuntimeState
from app.models.user import User
from app.services.runtime_source import expected_runtime_bundle_v2_etag

_DEPRECATED_HOSTED_FIELDS = {"hosted_managed", "hosted_deployment_id"}
_TEST_LOCALE = {"language": "en", "timezone": "UTC"}
_TEST_CLI_PACKAGE_SPEC = "clawdi@1.2.3-test"
_TEST_SYSTEM = {}


def _agent_body(machine_id: str) -> dict[str, str]:
    return {
        "machine_id": machine_id,
        "machine_name": "Agent Alias Laptop",
        "agent_type": "codex",
        "agent_version": "1.2.3",
        "os": "linux",
    }


async def _register_agent(client: httpx.AsyncClient, machine_id: str | None = None) -> str:
    response = await client.post("/v1/agents", json=_agent_body(machine_id or uuid.uuid4().hex))
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _set_oauth_cli_auth(seed_user: User):
    async def _oauth_cli_auth() -> AuthContext:
        return AuthContext(
            user=seed_user,
            oauth_cli=True,
            oauth_access_expires_at=datetime.now(UTC) + timedelta(minutes=5),
        )

    previous = app.dependency_overrides.get(get_auth)
    app.dependency_overrides[get_auth] = _oauth_cli_auth

    def restore() -> None:
        if previous is None:
            app.dependency_overrides.pop(get_auth, None)
        else:
            app.dependency_overrides[get_auth] = previous

    return restore


def _assert_same_response(left: httpx.Response, right: httpx.Response) -> None:
    assert left.status_code == right.status_code
    assert left.content == right.content
    if left.status_code == 200:
        assert left.headers.get("ETag") == right.headers.get("ETag")


def _assert_agent_response_matches_environment(
    agent_response: httpx.Response,
    environment_response: httpx.Response,
) -> None:
    assert agent_response.status_code == environment_response.status_code
    if agent_response.status_code != 200:
        assert agent_response.content == environment_response.content
        return
    agent_body = agent_response.json()
    environment_body = environment_response.json()
    assert not _DEPRECATED_HOSTED_FIELDS.intersection(agent_body)
    assert agent_body == {
        key: value
        for key, value in environment_body.items()
        if key not in _DEPRECATED_HOSTED_FIELDS
    }


def _assert_agent_list_response_matches_environment(
    agent_response: httpx.Response,
    environment_response: httpx.Response,
) -> None:
    assert agent_response.status_code == environment_response.status_code
    if agent_response.status_code != 200:
        assert agent_response.content == environment_response.content
        return
    assert [
        {key: value for key, value in item.items() if key not in _DEPRECATED_HOSTED_FIELDS}
        for item in environment_response.json()
    ] == agent_response.json()
    assert all(not _DEPRECATED_HOSTED_FIELDS.intersection(item) for item in agent_response.json())


@pytest.mark.asyncio
async def test_oauth_cli_rebind_preserves_agent_identity(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
):
    from app.models.session import AgentEnvironment
    from app.services.agent_environments import local_machine_registration_key

    restore_auth = _set_oauth_cli_auth(seed_user)
    try:
        agent_id = await _register_agent(client, "lost-installation")
        stale_env = await db_session.get(AgentEnvironment, uuid.UUID(agent_id))
        assert stale_env is not None
        stale_env.last_sync_at = datetime.now(UTC) - timedelta(hours=1)
        stale_env.last_sync_error = "old installation failed"
        stale_env.last_revision_seen = 17
        stale_env.queue_depth_high_water_since_start = 9
        stale_env.dropped_count_since_start = 3
        stale_env.project_skill_reconcile_version = 1
        stale_env.project_skill_reconcile_observed_at = datetime.now(UTC) - timedelta(hours=1)
        await db_session.commit()
        candidates = await client.get("/v1/agents", params={"reconnectable": "true"})
        body = _agent_body("replacement-installation")
        body["machine_name"] = "Recovered Laptop"
        response = await client.post(f"/v1/agents/{agent_id}/rebind", json=body)
    finally:
        restore_auth()

    assert candidates.status_code == 200, candidates.text
    assert [agent["id"] for agent in candidates.json()] == [agent_id]
    assert response.status_code == 200, response.text
    assert response.json() == {"id": agent_id}
    env = await db_session.get(AgentEnvironment, uuid.UUID(agent_id))
    assert env is not None
    assert env.machine_id == "replacement-installation"
    assert env.machine_name == "Recovered Laptop"
    assert env.registration_key == local_machine_registration_key(
        "replacement-installation", "codex"
    )
    assert env.last_sync_at is None
    assert env.last_sync_error is None
    assert env.last_revision_seen is None
    assert env.queue_depth_high_water_since_start == 0
    assert env.dropped_count_since_start == 0
    assert env.project_skill_reconcile_version is None
    assert env.project_skill_reconcile_observed_at is None

    repeated = await client.post("/v1/agents", json=_agent_body("replacement-installation"))
    assert repeated.status_code == 200, repeated.text
    assert repeated.json() == {"id": agent_id}


@pytest.mark.asyncio
async def test_agent_rebind_requires_oauth_cli_auth(
    client: httpx.AsyncClient,
    seed_user: User,
):
    restore_auth = _set_oauth_cli_auth(seed_user)
    try:
        agent_id = await _register_agent(client)
    finally:
        restore_auth()

    response = await client.post(
        f"/v1/agents/{agent_id}/rebind",
        json=_agent_body("replacement-installation"),
    )
    candidates = await client.get("/v1/agents", params={"reconnectable": "true"})

    assert response.status_code == 403
    assert candidates.status_code == 403


@pytest.mark.asyncio
async def test_agent_rebind_refuses_an_installation_identity_conflict(
    client: httpx.AsyncClient,
    seed_user: User,
):
    restore_auth = _set_oauth_cli_auth(seed_user)
    try:
        target_id = await _register_agent(client, "lost-installation")
        conflicting_id = await _register_agent(client, "replacement-installation")
        response = await client.post(
            f"/v1/agents/{target_id}/rebind",
            json=_agent_body("replacement-installation"),
        )
    finally:
        restore_auth()

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "agent_rebind_conflict",
        "message": "This installation is already connected to another Agent.",
        "conflicting_agent_id": conflicting_id,
    }


@pytest.mark.asyncio
async def test_agent_rebind_rejects_ambiguous_legacy_identity(
    client: httpx.AsyncClient,
    seed_user: User,
):
    agent_id = await _register_agent(client, "legacy-installation")
    restore_auth = _set_oauth_cli_auth(seed_user)
    try:
        candidates = await client.get("/v1/agents", params={"reconnectable": "true"})
        response = await client.post(
            f"/v1/agents/{agent_id}/rebind",
            json=_agent_body("replacement-installation"),
        )
    finally:
        restore_auth()

    assert candidates.status_code == 200, candidates.text
    assert candidates.json() == []
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "agent_not_reconnectable"


@pytest.mark.asyncio
async def test_agent_and_environment_routes_share_non_deprecated_payloads(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    machine_id = f"agent-alias-{uuid.uuid4().hex}"
    body = _agent_body(machine_id)

    registered_agent = await client.post("/v1/agents", json=body)
    registered_environment = await client.post("/v1/environments", json=body)
    registered_api_environment = await client.post("/api/environments", json=body)
    _assert_same_response(registered_agent, registered_environment)
    _assert_same_response(registered_environment, registered_api_environment)
    agent_id = registered_agent.json()["id"]

    db_session.add(
        HostedRuntimeState(
            environment_id=uuid.UUID(agent_id),
            deployment_id="dep-agent-alias",
            instance_id="iid-agent-alias",
            generation=3,
            cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
            locale=_TEST_LOCALE,
            system=_TEST_SYSTEM,
            live_sync={"enabled": False, "agents": []},
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
            runtimes={
                "openclaw": {
                    "enabled": True,
                    "providerMode": "configured",
                    "provider_ids": ["clawdi-managed"],
                    "primary_model": {
                        "provider_id": "clawdi-managed",
                        "model": "gpt-5.5",
                    },
                    "install": {"source": "official"},
                }
            },
        )
    )
    await db_session.commit()
    source_revision = "a" * 64
    observed = {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v2",
        "reportedAt": datetime.now(UTC).isoformat(),
        "runtimeMode": "hosted",
        "status": "ok",
        "activeCliVersion": "1.2.3-test",
        "applied": {
            "etag": expected_runtime_bundle_v2_etag(source_revision),
            "sourceRevision": source_revision,
            "generation": 3,
            "instanceId": "iid-agent-alias",
            "appliedProviderIds": ["clawdi-managed"],
        },
        "boot": None,
        "cli": None,
        "providers": {
            "clawdi-managed": {
                "status": "ok",
                "configured": True,
                "secretAvailable": True,
            }
        },
    }
    heartbeat = await client.post(
        f"/v1/agents/{agent_id}/sync-heartbeat",
        json={"queue_depth": 2, "runtime_observed": observed},
    )
    assert heartbeat.status_code == 204, heartbeat.text

    _assert_agent_list_response_matches_environment(
        await client.get("/v1/agents"),
        await client.get("/v1/environments"),
    )
    _assert_same_response(
        await client.get("/v1/environments"),
        await client.get("/api/environments"),
    )
    _assert_same_response(await client.get("/v1/agents"), await client.get("/api/agents"))
    _assert_agent_response_matches_environment(
        await client.get(f"/v1/agents/{agent_id}"),
        await client.get(f"/v1/environments/{agent_id}"),
    )
    _assert_same_response(
        await client.get(f"/v1/environments/{agent_id}"),
        await client.get(f"/api/environments/{agent_id}"),
    )
    _assert_agent_response_matches_environment(
        await client.get(f"/v1/agents/{agent_id}"),
        await client.get(f"/api/agents/{agent_id}"),
    )

    patched_agent = await client.patch(
        f"/v1/agents/{agent_id}",
        json={"display_name": "Agent Alias"},
    )
    patched_environment = await client.patch(
        f"/v1/environments/{agent_id}",
        json={"display_name": "Agent Alias"},
    )
    _assert_agent_response_matches_environment(patched_agent, patched_environment)

    cleared_agent = await client.delete(f"/v1/agents/{agent_id}/avatar")
    cleared_environment = await client.delete(f"/v1/environments/{agent_id}/avatar")
    _assert_agent_response_matches_environment(cleared_agent, cleared_environment)

    second_id = await _register_agent(client)
    reordered_agents = await client.patch(
        "/v1/agents/order",
        json={"agent_ids": [second_id, agent_id]},
    )
    reordered_environments = await client.patch(
        "/v1/environments/order",
        json={"environment_ids": [second_id, agent_id]},
    )
    _assert_agent_list_response_matches_environment(reordered_agents, reordered_environments)


@pytest.mark.asyncio
async def test_environment_detail_projects_only_hosted_deployment_id(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    engine,
):
    agent_id = await _register_agent(client)
    db_session.add(
        HostedRuntimeState(
            environment_id=uuid.UUID(agent_id),
            deployment_id="dep-narrow-environment-read",
            instance_id="iid-narrow-environment-read",
            generation=1,
            cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
            locale=_TEST_LOCALE,
            system=_TEST_SYSTEM,
            live_sync={"enabled": False, "agents": []},
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
            runtimes={"wide": {"payload": "not-needed-by-environment-response"}},
            skills={"entries": {"wide": {"enabled": True}}},
            tools={"catalog": "not-needed-by-environment-response"},
        )
    )
    await db_session.commit()

    statements: list[str] = []

    def capture_statement(_conn, _cursor, statement, _params, _context, _many) -> None:
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", capture_statement)
    try:
        response = await client.get(f"/api/environments/{agent_id}")
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", capture_statement)

    assert response.status_code == 200, response.text
    assert response.json()["hosted_managed"] is True
    assert response.json()["hosted_deployment_id"] == "dep-narrow-environment-read"
    selects = [
        statement.lower()
        for statement in statements
        if statement.lstrip().upper().startswith("SELECT")
    ]
    assert len(selects) == 1
    statement = selects[0]
    assert "hosted_runtime_states.deployment_id" in statement
    for unneeded_column in ("runtimes", "live_sync", "recovery", "mcp", "skills", "tools"):
        assert f"hosted_runtime_states.{unneeded_column}" not in statement


@pytest.mark.asyncio
async def test_agent_avatar_upload_stores_public_asset(client: httpx.AsyncClient):
    agent_id = await _register_agent(client)
    png = b"\x89PNG\r\n\x1a\n" + b"\x02" * 16

    response = await client.post(
        f"/v1/agents/{agent_id}/avatar",
        files={"file": ("agent.png", png, "image/png")},
    )
    assert response.status_code == 200, response.text
    avatar_url = response.json()["avatar_url"]
    assert "/v1/assets/agent-avatars/" in avatar_url

    asset = await client.get(urlparse(avatar_url).path)
    assert asset.status_code == 200, asset.text
    assert asset.content == png


@pytest.mark.asyncio
async def test_agent_delete_disconnects_self_managed_agent(client: httpx.AsyncClient):
    agent_id = await _register_agent(client)
    response = await client.delete(f"/v1/agents/{agent_id}")
    assert response.status_code == 204, response.text

    expected_detail = {
        "detail": {
            "code": "agent_disconnected",
            "message": "Agent is disconnected",
        }
    }
    for path in (
        f"/v1/agents/{agent_id}",
        f"/v1/environments/{agent_id}",
        f"/api/agents/{agent_id}",
        f"/api/environments/{agent_id}",
    ):
        detail = await client.get(path)
        assert detail.status_code == 403, (path, detail.text)
        assert detail.json() == expected_detail

    assert (await client.get("/v1/agents")).json() == []
    assert (await client.get("/v1/environments")).json() == []


@pytest.mark.asyncio
async def test_archived_agent_detail_does_not_leak_to_missing_wrong_owner_or_bound_mismatch(
    client: httpx.AsyncClient,
    seed_user,
):
    agent_id = await _register_agent(client)
    disconnected = await client.delete(f"/v1/agents/{agent_id}")
    assert disconnected.status_code == 204, disconnected.text

    missing_id = uuid.uuid4()
    assert (await client.get(f"/v1/agents/{missing_id}")).status_code == 404
    assert (await client.get(f"/v1/environments/{missing_id}")).status_code == 404

    other_user = User(
        id=uuid.uuid4(),
        clerk_id=f"other_{uuid.uuid4().hex}",
        email="other@example.test",
        name="Other",
    )

    async def wrong_owner_auth() -> AuthContext:
        return AuthContext(user=other_user)

    app.dependency_overrides[get_auth] = wrong_owner_auth
    app.dependency_overrides[get_auth_short_session] = wrong_owner_auth
    assert (await client.get(f"/v1/agents/{agent_id}")).status_code == 404
    assert (await client.get(f"/v1/environments/{agent_id}")).status_code == 404

    mismatched_key = ApiKey(
        user_id=seed_user.id,
        environment_id=uuid.uuid4(),
    )

    async def mismatched_bound_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=mismatched_key)

    app.dependency_overrides[get_auth] = mismatched_bound_auth
    app.dependency_overrides[get_auth_short_session] = mismatched_bound_auth
    assert (await client.get(f"/v1/agents/{agent_id}")).status_code == 404
    assert (await client.get(f"/v1/environments/{agent_id}")).status_code == 404


@pytest.mark.asyncio
async def test_agent_delete_rejects_explicit_agent_identity(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    from app.models.session import AgentEnvironment
    from app.services.agent_environments import register_agent_environment

    registered = await register_agent_environment(
        db_session,
        user_id=seed_user.id,
        environment_id=uuid.uuid4(),
        machine_id="explicit-agent-machine",
        machine_name="Explicit Agent",
        agent_type="codex",
        agent_version="1.0.0",
        os_name="linux",
        sort_order=0,
        registration_key=None,
    )

    response = await client.delete(f"/v1/agents/{registered.env.id}")
    assert response.status_code == 409, response.text

    env = (
        await db_session.execute(
            select(AgentEnvironment).where(AgentEnvironment.id == registered.env.id)
        )
    ).scalar_one_or_none()
    assert env is not None
    assert env.registration_key is None
