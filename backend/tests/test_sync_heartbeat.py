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
from datetime import UTC, datetime
from urllib.parse import urlparse

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.main import app
from app.models.api_key import ApiKey
from app.models.hosted_runtime import HostedRuntimeState

_TEST_LOCALE = {"language": "en", "timezone": "UTC"}
_TEST_SYSTEM = {
    "user": "clawdi",
    "home": "/home/clawdi",
    "workspace": "/home/clawdi/clawdi",
    "persistentPaths": ["/home/clawdi"],
}


def _test_runtimes(provider_id: str = "clawdi-managed") -> dict:
    return {
        "openclaw": {
            "enabled": True,
            "provider_ids": [provider_id],
            "primary_model": {"provider_id": provider_id, "model": "gpt-5.5"},
            "paths": {"home": "/home/clawdi", "workspace": "/home/clawdi/clawdi"},
        }
    }


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
    r = await client.post("/v1/environments", json=body)
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
    r = await client.post(f"/v1/agents/{env_id}/sync-heartbeat", json=payload)
    assert r.status_code == 204, r.text

    # Round-trip through the public env GET — what the daemon
    # wrote must be what the dashboard reads.
    detail = (await client.get(f"/v1/environments/{env_id}")).json()
    assert detail["last_revision_seen"] == 7
    assert detail["queue_depth_high_water"] == 3
    assert detail["last_sync_error"] is None
    assert detail["last_sync_at"] is not None  # was None pre-heartbeat


@pytest.mark.asyncio
async def test_environment_identity_update_round_trips(client: httpx.AsyncClient):
    env_id = await _create_env(client)

    updated = await client.patch(
        f"/v1/environments/{env_id}",
        json={"display_name": "Build runner"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["display_name"] == "Build runner"
    assert updated.json()["avatar_url"] is None

    detail = await client.get(f"/v1/environments/{env_id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["display_name"] == "Build runner"

    cleared = await client.patch(
        f"/v1/environments/{env_id}",
        json={"display_name": ""},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["display_name"] is None


@pytest.mark.asyncio
async def test_environment_update_rejects_avatar_url_field(client: httpx.AsyncClient):
    env_id = await _create_env(client)

    response = await client.patch(
        f"/v1/environments/{env_id}",
        json={"avatar_url": "https://example.com/agent.png"},
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_environment_update_rejects_avatar_preset_field(client: httpx.AsyncClient):
    env_id = await _create_env(client)

    response = await client.patch(
        f"/v1/environments/{env_id}",
        json={"avatar_preset": "aurora"},
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_environment_avatar_upload_stores_public_asset(client: httpx.AsyncClient):
    env_id = await _create_env(client)
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16

    response = await client.post(
        f"/v1/environments/{env_id}/avatar",
        files={"file": ("agent.png", png, "image/png")},
    )
    assert response.status_code == 200, response.text
    avatar_url = response.json()["avatar_url"]
    assert "/v1/assets/agent-avatars/" in avatar_url
    assert avatar_url.endswith(".png")

    path = urlparse(avatar_url).path
    asset = await client.get(path)
    assert asset.status_code == 200, asset.text
    assert asset.content == png
    assert asset.headers["content-type"].startswith("image/png")

    cleared = await client.delete(f"/v1/environments/{env_id}/avatar")
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["avatar_url"] is None


@pytest.mark.asyncio
async def test_environment_avatar_reupload_uses_new_asset_url(client: httpx.AsyncClient):
    env_id = await _create_env(client)
    first_png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
    second_png = b"\x89PNG\r\n\x1a\n" + b"\x01" * 16

    first = await client.post(
        f"/v1/environments/{env_id}/avatar",
        files={"file": ("agent.png", first_png, "image/png")},
    )
    assert first.status_code == 200, first.text
    first_path = urlparse(first.json()["avatar_url"]).path

    second = await client.post(
        f"/v1/environments/{env_id}/avatar",
        files={"file": ("agent.png", second_png, "image/png")},
    )
    assert second.status_code == 200, second.text
    second_path = urlparse(second.json()["avatar_url"]).path

    assert second_path != first_path
    old_asset = await client.get(first_path)
    assert old_asset.status_code == 404
    new_asset = await client.get(second_path)
    assert new_asset.status_code == 200
    assert new_asset.content == second_png


@pytest.mark.asyncio
async def test_environment_avatar_failed_reupload_keeps_existing_asset(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    from app.routes import sessions as sessions_routes

    env_id = await _create_env(client)
    first_png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
    second_png = b"\x89PNG\r\n\x1a\n" + b"\x01" * 16

    first = await client.post(
        f"/v1/environments/{env_id}/avatar",
        files={"file": ("agent.png", first_png, "image/png")},
    )
    assert first.status_code == 200, first.text
    first_path = urlparse(first.json()["avatar_url"]).path

    class FailingPutStore:
        def __init__(self, delegate):
            self.delegate = delegate

        async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
            del key, data, content_type
            raise RuntimeError("object store unavailable")

        async def get(self, key: str) -> bytes:
            return await self.delegate.get(key)

        async def delete(self, key: str) -> None:
            await self.delegate.delete(key)

        async def exists(self, key: str) -> bool:
            return await self.delegate.exists(key)

    monkeypatch.setattr(
        sessions_routes,
        "file_store",
        FailingPutStore(sessions_routes.file_store),
    )

    with pytest.raises(RuntimeError, match="object store unavailable"):
        await client.post(
            f"/v1/environments/{env_id}/avatar",
            files={"file": ("agent.png", second_png, "image/png")},
        )

    detail = await client.get(f"/v1/environments/{env_id}")
    assert detail.status_code == 200, detail.text
    assert urlparse(detail.json()["avatar_url"]).path == first_path

    old_asset = await client.get(first_path)
    assert old_asset.status_code == 200
    assert old_asset.content == first_png


@pytest.mark.asyncio
async def test_environment_avatar_upload_rejects_non_image(client: httpx.AsyncClient):
    env_id = await _create_env(client)

    response = await client.post(
        f"/v1/environments/{env_id}/avatar",
        files={"file": ("agent.txt", b"not an image", "text/plain")},
    )
    assert response.status_code == 415, response.text


@pytest.mark.asyncio
async def test_environment_reorder_persists_list_order(client: httpx.AsyncClient):
    first_id = await _create_env(client)
    second_id = await _create_env(client)
    third_id = await _create_env(client)

    response = await client.patch(
        "/v1/environments/order",
        json={"environment_ids": [third_id, first_id, second_id]},
    )
    assert response.status_code == 200, response.text
    assert [item["id"] for item in response.json()][:3] == [third_id, first_id, second_id]
    assert [item["sort_order"] for item in response.json()][:3] == [0, 1, 2]

    listed = await client.get("/v1/environments")
    assert listed.status_code == 200, listed.text
    assert [item["id"] for item in listed.json()][:3] == [third_id, first_id, second_id]


@pytest.mark.asyncio
async def test_environment_reorder_rejects_duplicate_ids(client: httpx.AsyncClient):
    env_id = await _create_env(client)

    response = await client.patch(
        "/v1/environments/order",
        json={"environment_ids": [env_id, env_id]},
    )
    assert response.status_code == 400, response.text


@pytest.mark.asyncio
async def test_environment_reorder_rejects_unknown_ids(client: httpx.AsyncClient):
    env_id = await _create_env(client)

    response = await client.patch(
        "/v1/environments/order",
        json={"environment_ids": [env_id, str(uuid.uuid4())]},
    )
    assert response.status_code == 404, response.text


@pytest.mark.asyncio
async def test_heartbeat_high_water_only_grows(client: httpx.AsyncClient):
    """`queue_depth_high_water` is monotonic — a heartbeat with a
    smaller queue_depth must NOT lower the recorded peak.
    Otherwise the dashboard underreports a daemon that briefly
    blew up the queue then drained it."""
    env_id = await _create_env(client)

    await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"queue_depth": 50},
    )
    await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"queue_depth": 5},
    )
    detail = (await client.get(f"/v1/environments/{env_id}")).json()
    assert detail["queue_depth_high_water"] == 50


@pytest.mark.asyncio
async def test_heartbeat_dropped_count_accumulates(client: httpx.AsyncClient):
    """The daemon sends a delta (since last heartbeat); server
    keeps a running counter. A buggy daemon that always sends 0
    won't move the needle, but a daemon dropping events will."""
    env_id = await _create_env(client)

    await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"dropped_count_delta": 3},
    )
    await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"dropped_count_delta": 2},
    )
    detail = (await client.get(f"/v1/environments/{env_id}")).json()
    assert detail["dropped_count"] == 5


@pytest.mark.asyncio
async def test_heartbeat_unknown_env_is_404(client: httpx.AsyncClient):
    fake_id = uuid.uuid4()
    r = await client.post(f"/v1/agents/{fake_id}/sync-heartbeat", json={"queue_depth": 0})
    assert r.status_code == 404


@pytest_asyncio.fixture
async def env_bound_cli_client(
    db_session: AsyncSession, seed_user
) -> AsyncIterator[tuple[httpx.AsyncClient, str, str]]:
    """A CLI-style client whose api_key is bound to a specific
    environment_id. Yields (client, bound_env_id, other_env_id) so
    tests can assert the bound key works on its own env and 403s
    on another env owned by the same user."""
    from tests.conftest import create_env_with_project

    bound_env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="bound",
        machine_name="bound",
    )
    other_env = await create_env_with_project(
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
    r = await client.post(f"/v1/agents/{bound_id}/sync-heartbeat", json={"queue_depth": 1})
    assert r.status_code == 204, r.text


@pytest.mark.asyncio
async def test_bound_key_heartbeat_updates_hosted_runtime_observed(
    env_bound_cli_client, db_session: AsyncSession
):
    client, bound_id, _other_id = env_bound_cli_client
    state = HostedRuntimeState(
        environment_id=uuid.UUID(bound_id),
        deployment_id="dep-observed",
        instance_id="iid-observed",
        generation=1,
        locale=_TEST_LOCALE,
        system=_TEST_SYSTEM,
        live_sync={"enabled": False, "agents": []},
        recovery={"cacheManifest": True, "allowOfflineBoot": True},
        runtimes=_test_runtimes(),
    )
    db_session.add(state)
    await db_session.commit()

    observed = {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v1",
        "status": "ok",
        "manifest": {"etag": '"manifest-etag"'},
        "channels": {"etag": '"channels-etag"'},
    }
    r = await client.post(
        f"/v1/agents/{bound_id}/sync-heartbeat",
        json={"queue_depth": 1, "runtime_observed": observed},
    )
    assert r.status_code == 204, r.text

    await db_session.refresh(state)
    assert state.observed == observed


@pytest.mark.asyncio
async def test_runtime_observed_endpoint_returns_desired_observed_health(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    env_id = await _create_env(client)
    state = HostedRuntimeState(
        environment_id=uuid.UUID(env_id),
        deployment_id="dep-observed-api",
        instance_id="iid-observed-api",
        generation=4,
        locale=_TEST_LOCALE,
        system=_TEST_SYSTEM,
        live_sync={"enabled": False, "agents": []},
        recovery={"cacheManifest": True, "allowOfflineBoot": True},
        runtimes=_test_runtimes(),
        mcp={"enabled": True},
        tools={"catalog": "clawdi-default"},
    )
    db_session.add(state)
    await db_session.commit()

    observed = {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v1",
        "reportedAt": datetime.now(UTC).isoformat(),
        "status": "ok",
        "manifest": {"etag": '"manifest-etag"'},
        "channels": {"etag": '"channels-etag"'},
    }
    heartbeat = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"queue_depth": 1, "runtime_observed": observed},
    )
    assert heartbeat.status_code == 204, heartbeat.text

    response = await client.get(f"/v1/environments/{env_id}/runtime-observed")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["environment"]["id"] == env_id
    assert payload["desired"] == {
        "deployment_id": "dep-observed-api",
        "instance_id": "iid-observed-api",
        "generation": 4,
        "provider_id": "clawdi-managed",
        "enabled_runtimes": ["openclaw"],
        "has_mcp": True,
        "has_tools": True,
        "updated_at": payload["desired"]["updated_at"],
    }
    assert payload["observed"] == observed
    assert payload["health"]["status"] == "ok"
    assert payload["health"]["reasons"] == []
    assert payload["health"]["reported_at"] is not None


@pytest.mark.asyncio
async def test_sync_heartbeat_ignores_reported_at_only_observed_changes(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    env_id = await _create_env(client)
    state = HostedRuntimeState(
        environment_id=uuid.UUID(env_id),
        deployment_id="dep-observed-dedupe",
        instance_id="iid-observed-dedupe",
        generation=4,
        locale=_TEST_LOCALE,
        system=_TEST_SYSTEM,
        live_sync={"enabled": False, "agents": []},
        recovery={"cacheManifest": True, "allowOfflineBoot": True},
        runtimes=_test_runtimes(),
    )
    db_session.add(state)
    await db_session.commit()

    observed = {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v1",
        "reportedAt": "2026-06-11T00:00:00+00:00",
        "status": "ok",
        "manifest": {"etag": '"manifest-etag"'},
    }
    first = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"queue_depth": 1, "runtime_observed": observed},
    )
    assert first.status_code == 204, first.text
    await db_session.refresh(state)
    assert state.observed == observed

    second = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={
            "runtime_observed": {
                **observed,
                "reportedAt": "2026-06-11T00:00:30+00:00",
            }
        },
    )
    assert second.status_code == 204, second.text
    await db_session.refresh(state)
    assert state.observed == observed


@pytest.mark.asyncio
async def test_runtime_observed_endpoint_surfaces_supervisor_errors(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    env_id = await _create_env(client)
    state = HostedRuntimeState(
        environment_id=uuid.UUID(env_id),
        deployment_id="dep-supervisor-error",
        instance_id="iid-supervisor-error",
        generation=5,
        locale=_TEST_LOCALE,
        system=_TEST_SYSTEM,
        live_sync={"enabled": False, "agents": []},
        recovery={"cacheManifest": True, "allowOfflineBoot": True},
        runtimes=_test_runtimes(),
    )
    db_session.add(state)
    await db_session.commit()

    observed = {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v1",
        "reportedAt": datetime.now(UTC).isoformat(),
        "status": "ok",
        "supervisor": {
            "status": "error",
            "programs": [
                {
                    "name": "clawdi-openclaw",
                    "state": "FATAL",
                    "status": "error",
                    "description": "Exited too quickly",
                }
            ],
        },
    }
    heartbeat = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"queue_depth": 1, "runtime_observed": observed},
    )
    assert heartbeat.status_code == 204, heartbeat.text

    response = await client.get(f"/v1/environments/{env_id}/runtime-observed")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["health"]["status"] == "error"
    assert "supervisor_error" in payload["health"]["reasons"]
    assert payload["observed"]["supervisor"]["programs"][0]["name"] == "clawdi-openclaw"


@pytest.mark.asyncio
async def test_runtime_observed_endpoint_surfaces_provider_errors(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    env_id = await _create_env(client)
    state = HostedRuntimeState(
        environment_id=uuid.UUID(env_id),
        deployment_id="dep-provider-error",
        instance_id="iid-provider-error",
        generation=6,
        locale=_TEST_LOCALE,
        system=_TEST_SYSTEM,
        live_sync={"enabled": False, "agents": []},
        recovery={"cacheManifest": True, "allowOfflineBoot": True},
        runtimes=_test_runtimes(),
    )
    db_session.add(state)
    await db_session.commit()

    observed = {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v1",
        "reportedAt": datetime.now(UTC).isoformat(),
        "status": "ok",
        "providers": {
            "clawdi-managed": {
                "status": "error",
                "baseUrl": "https://sub2api.test/v1",
                "model": "gpt-5.5",
                "apiKeySecretRef": "provider.clawdi-managed.apiKey",
                "secretAvailable": False,
                "reasons": ["secret_missing"],
            }
        },
    }
    heartbeat = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"queue_depth": 1, "runtime_observed": observed},
    )
    assert heartbeat.status_code == 204, heartbeat.text

    response = await client.get(f"/v1/environments/{env_id}/runtime-observed")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["health"]["status"] == "error"
    assert "provider_error" in payload["health"]["reasons"]
    assert payload["provider_health"] == [
        {
            "provider_id": "clawdi-managed",
            "status": "error",
            "reasons": ["provider_secret_missing", "secret_missing"],
            "desired": {
                "selected": True,
                "primary": True,
            },
            "observed": observed["providers"]["clawdi-managed"],
        }
    ]


@pytest.mark.asyncio
async def test_runtime_observed_endpoint_reports_not_configured(
    client: httpx.AsyncClient,
):
    env_id = await _create_env(client)

    response = await client.get(f"/v1/environments/{env_id}/runtime-observed")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["environment"]["id"] == env_id
    assert payload["desired"] is None
    assert payload["observed"] is None
    assert payload["health"] == {
        "status": "not_configured",
        "reasons": ["hosted_runtime_state_missing"],
        "reported_at": None,
    }


@pytest.mark.asyncio
async def test_bound_key_runtime_observed_is_env_scoped(env_bound_cli_client):
    client, bound_id, other_id = env_bound_cli_client

    own = await client.get(f"/v1/environments/{bound_id}/runtime-observed")
    assert own.status_code == 200, own.text
    assert own.json()["environment"]["id"] == bound_id

    other = await client.get(f"/v1/environments/{other_id}/runtime-observed")
    assert other.status_code == 404, other.text


@pytest.mark.asyncio
async def test_runtime_observed_summary_counts_health_by_environment(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    ok_env_id = await _create_env(client)
    error_env_id = await _create_env(client)
    missing_state_env_id = await _create_env(client)
    db_session.add_all(
        [
            HostedRuntimeState(
                environment_id=uuid.UUID(ok_env_id),
                deployment_id="dep-summary-ok",
                instance_id="iid-summary-ok",
                generation=1,
                locale=_TEST_LOCALE,
                system=_TEST_SYSTEM,
                live_sync={"enabled": False, "agents": []},
                recovery={"cacheManifest": True, "allowOfflineBoot": True},
                runtimes=_test_runtimes(),
            ),
            HostedRuntimeState(
                environment_id=uuid.UUID(error_env_id),
                deployment_id="dep-summary-error",
                instance_id="iid-summary-error",
                generation=1,
                locale=_TEST_LOCALE,
                system=_TEST_SYSTEM,
                live_sync={"enabled": False, "agents": []},
                recovery={"cacheManifest": True, "allowOfflineBoot": True},
                runtimes=_test_runtimes(),
            ),
        ]
    )
    await db_session.commit()
    ok_observed = {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v1",
        "reportedAt": datetime.now(UTC).isoformat(),
        "status": "ok",
    }
    error_observed = {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v1",
        "reportedAt": datetime.now(UTC).isoformat(),
        "status": "ok",
        "providers": {
            "default": {
                "status": "error",
                "apiKeySecretRef": "provider.default.apiKey",
                "secretAvailable": False,
            }
        },
    }
    ok_heartbeat = await client.post(
        f"/v1/agents/{ok_env_id}/sync-heartbeat",
        json={"queue_depth": 1, "runtime_observed": ok_observed},
    )
    assert ok_heartbeat.status_code == 204, ok_heartbeat.text
    error_heartbeat = await client.post(
        f"/v1/agents/{error_env_id}/sync-heartbeat",
        json={"queue_depth": 1, "runtime_observed": error_observed},
    )
    assert error_heartbeat.status_code == 204, error_heartbeat.text

    response = await client.get("/v1/environments/runtime-observed")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["counts"] == {
        "ok": 1,
        "error": 1,
        "stale": 0,
        "unknown": 0,
        "not_configured": 1,
    }
    by_env = {item["environment"]["id"]: item for item in payload["items"]}
    assert by_env[ok_env_id]["health"]["status"] == "ok"
    assert by_env[error_env_id]["provider_health"][0]["status"] == "error"
    assert by_env[missing_state_env_id]["health"]["status"] == "not_configured"


@pytest.mark.asyncio
async def test_bound_key_cannot_heartbeat_another_env(env_bound_cli_client):
    client, _bound_id, other_id = env_bound_cli_client
    r = await client.post(f"/v1/agents/{other_id}/sync-heartbeat", json={"queue_depth": 1})
    assert r.status_code == 403, r.text
