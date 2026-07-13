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
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.ext.asyncio.engine import AsyncEngine

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.main import app
from app.models.api_key import ApiKey
from app.models.hosted_runtime import HostedRuntimeConfigObservation, HostedRuntimeState
from app.services.runtime_source import expected_runtime_bundle_v2_etag

_TEST_LOCALE = {"language": "en", "timezone": "UTC"}
_TEST_CLI_PACKAGE_SPEC = "clawdi@0.12.10-beta.51"
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
            "install": {"source": "official"},
            "paths": {"home": "/home/clawdi", "workspace": "/home/clawdi/clawdi"},
        }
    }


def _runtime_observed(
    *,
    reported_at: str | None = None,
    status: str = "ok",
    manifest_etag: str | None = '"manifest-etag"',
    channels_etag: str | None = '"channels-etag"',
    boot_generation: int | None = 3,
    boot_instance_id: str | None = "iid-boot",
    watch_status: str | None = "applied",
    watch_generation: int | None = 4,
    watch_instance_id: str | None = "iid-watch",
    providers: dict | None = None,
    supervisor: dict | None = None,
) -> dict:
    payload = {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v1",
        "reportedAt": reported_at or datetime.now(UTC).isoformat(),
        "runtimeMode": "hosted",
        "status": status,
        "manifest": {"etag": manifest_etag, "lastGoodExists": True},
        "channels": {"etag": channels_etag},
        "boot": {
            "status": "ok",
            "mode": "normal",
            "stage": "final",
            "timestamp": "2026-07-13T00:00:00Z",
            "activeGeneration": boot_generation,
            "instanceId": boot_instance_id,
            "enabledRuntimes": ["openclaw"],
            "errors": [],
        },
        "watch": (
            {
                "status": watch_status,
                "stage": "apply",
                "etag": manifest_etag,
                "channelsEtag": channels_etag,
                "generation": watch_generation,
                "instanceId": watch_instance_id,
                "selfReexec": False,
                "error": None,
                "errors": [],
                "cliUpdate": None,
            }
            if watch_status is not None
            else None
        ),
        "cli": None,
    }
    if providers is not None:
        payload["providers"] = providers
    if supervisor is not None:
        payload["supervisor"] = supervisor
    return payload


def _runtime_observed_v2(
    *,
    source_revision: str,
    active_cli_version: str | None = "0.12.10-beta.51",
    applied: bool = True,
    manifest_etag: str | None = None,
    applied_provider_ids: list[str] | None = None,
    providers: dict | None = None,
) -> dict:
    return {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v2",
        "reportedAt": datetime.now(UTC).isoformat(),
        "runtimeMode": "hosted",
        "status": "ok",
        "activeCliVersion": active_cli_version,
        "applied": (
            {
                "etag": manifest_etag or expected_runtime_bundle_v2_etag(source_revision),
                "sourceRevision": source_revision,
                "generation": 4,
                "instanceId": "iid-observed-v2",
                "appliedProviderIds": applied_provider_ids
                if applied_provider_ids is not None
                else ["clawdi-managed"],
            }
            if applied
            else None
        ),
        "boot": None,
        "cli": None,
        "providers": providers
        if providers is not None
        else {
            "clawdi-managed": {
                "status": "ok",
                "configured": True,
                "secretAvailable": True,
            }
        },
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
async def test_bound_key_heartbeat_updates_hosted_runtime_config_observation(
    env_bound_cli_client, db_session: AsyncSession
):
    client, bound_id, _other_id = env_bound_cli_client
    state = HostedRuntimeState(
        environment_id=uuid.UUID(bound_id),
        deployment_id="dep-observed",
        instance_id="iid-observed",
        generation=1,
        cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
        locale=_TEST_LOCALE,
        system=_TEST_SYSTEM,
        live_sync={"enabled": False, "agents": []},
        recovery={"cacheManifest": True, "allowOfflineBoot": True},
        runtimes=_test_runtimes(),
    )
    db_session.add(state)
    await db_session.commit()
    await db_session.refresh(state)
    desired_updated_at = state.updated_at

    observed = _runtime_observed()
    received_at_lower_bound = datetime.now(UTC)
    r = await client.post(
        f"/v1/agents/{bound_id}/sync-heartbeat",
        json={"queue_depth": 1, "runtime_observed": observed},
    )
    received_at_upper_bound = datetime.now(UTC)
    assert r.status_code == 204, r.text

    await db_session.refresh(state)
    assert state.updated_at == desired_updated_at
    observation = await db_session.get(HostedRuntimeConfigObservation, uuid.UUID(bound_id))
    assert observation is not None
    assert observation.observed_config_generation == 4
    assert observation.observed_manifest_etag == '"manifest-etag"'
    assert observation.observed_at is not None
    assert received_at_lower_bound <= observation.observed_at <= received_at_upper_bound
    assert observation.diagnostics == {
        **observed,
        "reportedAt": datetime.fromisoformat(observed["reportedAt"])
        .astimezone(UTC)
        .isoformat()
        .replace("+00:00", "Z"),
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("watch_status", "watch_generation", "watch_instance_id", "expected_generation"),
    [
        ("not_modified", 99, "iid-not-modified", 99),
        ("error", 99, "iid-error", 8),
        ("applied", None, None, 8),
    ],
)
async def test_config_observation_uses_confirmed_watch_identity_or_falls_back_to_boot(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    watch_status: str,
    watch_generation: int | None,
    watch_instance_id: str | None,
    expected_generation: int,
):
    env_id = await _create_env(client)
    db_session.add(
        HostedRuntimeState(
            environment_id=uuid.UUID(env_id),
            deployment_id="dep-config-fallback",
            instance_id="iid-desired-config",
            generation=8,
            cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
            locale=_TEST_LOCALE,
            system=_TEST_SYSTEM,
            live_sync={"enabled": False, "agents": []},
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
            runtimes=_test_runtimes(),
        )
    )
    await db_session.commit()
    observed = _runtime_observed(
        manifest_etag='"manifest-source-etag"',
        boot_generation=8,
        boot_instance_id="iid-boot-config",
        watch_status=watch_status,
        watch_generation=watch_generation,
        watch_instance_id=watch_instance_id,
    )
    observed["watch"]["etag"] = '"watch-diagnostic-etag"'

    heartbeat = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"runtime_observed": observed},
    )

    assert heartbeat.status_code == 204, heartbeat.text
    observation = await db_session.get(HostedRuntimeConfigObservation, uuid.UUID(env_id))
    assert observation is not None
    assert observation.observed_config_generation == expected_generation
    assert observation.observed_manifest_etag == '"manifest-source-etag"'


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
        cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
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

    observed = _runtime_observed(
        boot_generation=3,
        boot_instance_id="iid-boot-api",
        watch_generation=4,
        watch_instance_id="iid-watch-api",
    )
    received_at_lower_bound = datetime.now(UTC)
    heartbeat = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"queue_depth": 1, "runtime_observed": observed},
    )
    received_at_upper_bound = datetime.now(UTC)
    assert heartbeat.status_code == 204, heartbeat.text

    response = await client.get(f"/v1/environments/{env_id}/runtime-observed")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["environment"]["id"] == env_id
    assert payload["desired"] == {
        "deployment_id": "dep-observed-api",
        "instance_id": "iid-observed-api",
        "desired_config_generation": 4,
        "desired_source_revision": payload["desired"]["desired_source_revision"],
        "provider_id": "clawdi-managed",
        "enabled_runtimes": ["openclaw"],
        "has_mcp": True,
        "has_tools": True,
        "updated_at": payload["desired"]["updated_at"],
    }
    observed_at = datetime.fromisoformat(payload["observed"]["observed_at"].replace("Z", "+00:00"))
    assert received_at_lower_bound <= observed_at <= received_at_upper_bound
    assert datetime.fromisoformat(
        payload["observed"]["diagnostics"]["reportedAt"].replace("Z", "+00:00")
    ) == datetime.fromisoformat(observed["reportedAt"])
    assert payload["observed"]["observed_config_generation"] == 4
    assert payload["observed"]["observed_manifest_etag"] == '"manifest-etag"'
    assert payload["observed"]["observed_source_revision"] is None
    assert payload["observed"]["diagnostics"]["schemaVersion"] == (
        "clawdi.hostedRuntimeObserved.v1"
    )
    assert payload["observed"]["diagnostics"]["watch"]["generation"] == 4
    assert payload["health"]["status"] == "unknown"
    assert payload["health"]["reasons"] == [
        "observed_source_revision_missing",
        "provider_status_unknown",
    ]
    assert payload["health"]["observed_at"] is not None


@pytest.mark.asyncio
async def test_v2_applied_authority_persists_and_drives_health(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    env_id = await _create_env(client)
    db_session.add(
        HostedRuntimeState(
            environment_id=uuid.UUID(env_id),
            deployment_id="dep-observed-v2",
            instance_id="iid-observed-v2",
            generation=4,
            cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
            locale=_TEST_LOCALE,
            system=_TEST_SYSTEM,
            live_sync={"enabled": False, "agents": []},
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
            runtimes=_test_runtimes(),
        )
    )
    await db_session.commit()
    desired = (await client.get(f"/v1/environments/{env_id}/runtime-observed")).json()["desired"]
    source_revision = desired["desired_source_revision"]

    heartbeat = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"runtime_observed": _runtime_observed_v2(source_revision=source_revision)},
    )
    assert heartbeat.status_code == 204, heartbeat.text
    observation = await db_session.get(HostedRuntimeConfigObservation, uuid.UUID(env_id))
    assert observation is not None
    assert observation.observed_config_generation == 4
    assert observation.observed_manifest_etag == expected_runtime_bundle_v2_etag(source_revision)
    assert observation.observed_source_revision == source_revision
    assert observation.diagnostics["activeCliVersion"] == "0.12.10-beta.51"
    healthy = (await client.get(f"/v1/environments/{env_id}/runtime-observed")).json()
    assert healthy["health"] == {
        "status": "ok",
        "reasons": [],
        "observed_at": healthy["health"]["observed_at"],
    }

    mismatch = _runtime_observed_v2(
        source_revision=source_revision,
        active_cli_version="0.12.10-beta.50",
        providers={},
    )
    response = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"runtime_observed": mismatch},
    )
    assert response.status_code == 204, response.text
    await db_session.refresh(observation)
    unhealthy = (await client.get(f"/v1/environments/{env_id}/runtime-observed")).json()
    assert unhealthy["health"]["status"] == "unknown"
    assert "active_cli_version_mismatch" in unhealthy["health"]["reasons"]
    assert "provider_status_unknown" in unhealthy["health"]["reasons"]
    provider_health = {
        provider["provider_id"]: provider for provider in unhealthy["provider_health"]
    }
    assert provider_health["clawdi-managed"]["reasons"] == ["provider_observation_missing"]

    missing = _runtime_observed_v2(
        source_revision=source_revision,
        active_cli_version=None,
        applied=False,
    )
    response = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"runtime_observed": missing},
    )
    assert response.status_code == 204, response.text
    await db_session.refresh(observation)
    unknown = (await client.get(f"/v1/environments/{env_id}/runtime-observed")).json()
    assert unknown["health"]["status"] == "unknown"
    assert "observed_source_revision_missing" in unknown["health"]["reasons"]
    assert "observed_manifest_etag_missing" in unknown["health"]["reasons"]
    assert "active_cli_version_missing" in unknown["health"]["reasons"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("manifest_etag", "applied_provider_ids", "expected_reason", "absent_reason"),
    [
        ('"wrong-bundle-etag"', ["clawdi-managed"], "observed_manifest_etag_mismatch", None),
        (None, [], "applied_provider_ids_missing_desired", "applied_provider_ids_extra"),
        (
            None,
            ["clawdi-managed", "stale-provider"],
            "applied_provider_ids_extra",
            "applied_provider_ids_missing_desired",
        ),
    ],
)
async def test_v2_health_requires_expected_etag_and_exact_source_provider_set(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    manifest_etag: str | None,
    applied_provider_ids: list[str],
    expected_reason: str,
    absent_reason: str | None,
):
    env_id = await _create_env(client)
    db_session.add(
        HostedRuntimeState(
            environment_id=uuid.UUID(env_id),
            deployment_id="dep-observed-v2-equality",
            instance_id="iid-observed-v2-equality",
            generation=4,
            cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
            locale=_TEST_LOCALE,
            system=_TEST_SYSTEM,
            live_sync={"enabled": False, "agents": []},
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
            runtimes=_test_runtimes(),
        )
    )
    await db_session.commit()
    desired = (await client.get(f"/v1/environments/{env_id}/runtime-observed")).json()["desired"]
    source_revision = desired["desired_source_revision"]

    heartbeat = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={
            "runtime_observed": _runtime_observed_v2(
                source_revision=source_revision,
                manifest_etag=manifest_etag,
                applied_provider_ids=applied_provider_ids,
            )
        },
    )

    assert heartbeat.status_code == 204, heartbeat.text
    health = (await client.get(f"/v1/environments/{env_id}/runtime-observed")).json()["health"]
    assert expected_reason in health["reasons"]
    if absent_reason is not None:
        assert absent_reason not in health["reasons"]


@pytest.mark.asyncio
async def test_runtime_observed_health_uses_typed_config_generation(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    env_id = await _create_env(client)
    db_session.add(
        HostedRuntimeState(
            environment_id=uuid.UUID(env_id),
            deployment_id="dep-config-convergence",
            instance_id="iid-config-convergence",
            generation=5,
            cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
            locale=_TEST_LOCALE,
            system=_TEST_SYSTEM,
            live_sync={"enabled": False, "agents": []},
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
            runtimes=_test_runtimes(),
        )
    )
    await db_session.commit()

    heartbeat = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"runtime_observed": _runtime_observed(watch_generation=4)},
    )
    assert heartbeat.status_code == 204, heartbeat.text

    observation = await db_session.get(HostedRuntimeConfigObservation, uuid.UUID(env_id))
    assert observation is not None
    diagnostics = observation.diagnostics
    assert isinstance(diagnostics, dict)
    watch = diagnostics["watch"]
    assert isinstance(watch, dict)
    observation.diagnostics = {
        **diagnostics,
        "watch": {**watch, "generation": 5},
    }
    await db_session.commit()

    response = await client.get(f"/v1/environments/{env_id}/runtime-observed")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["desired"]["desired_config_generation"] == 5
    assert payload["observed"]["observed_config_generation"] == 4
    assert payload["health"]["status"] == "unknown"
    assert "config_generation_mismatch" in payload["health"]["reasons"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "legacy_diagnostics",
    ["legacy-scalar", ["legacy-list", {"preserved": True}]],
    ids=["scalar", "list"],
)
async def test_sync_heartbeat_repairs_migrated_non_object_diagnostics(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    legacy_diagnostics,
):
    env_id = await _create_env(client)
    db_session.add(
        HostedRuntimeState(
            environment_id=uuid.UUID(env_id),
            deployment_id="dep-legacy-json-value",
            instance_id="iid-legacy-json-value",
            generation=4,
            cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
            locale=_TEST_LOCALE,
            system=_TEST_SYSTEM,
            live_sync={"enabled": False, "agents": []},
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
            runtimes=_test_runtimes(),
        )
    )
    await db_session.commit()
    db_session.add(
        HostedRuntimeConfigObservation(
            environment_id=uuid.UUID(env_id),
            observed_at=None,
            observed_config_generation=None,
            observed_manifest_etag=None,
            diagnostics=legacy_diagnostics,
        )
    )
    await db_session.commit()

    heartbeat = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"runtime_observed": _runtime_observed(watch_generation=4)},
    )

    assert heartbeat.status_code == 204, heartbeat.text
    observation = await db_session.get(HostedRuntimeConfigObservation, uuid.UUID(env_id))
    assert observation is not None
    await db_session.refresh(observation)
    assert observation.observed_config_generation == 4
    assert observation.observed_manifest_etag == '"manifest-etag"'
    assert isinstance(observation.diagnostics, dict)
    assert observation.diagnostics["schemaVersion"] == "clawdi.hostedRuntimeObserved.v1"


@pytest.mark.asyncio
async def test_config_generation_and_manifest_etag_are_stored_independently(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    env_id = await _create_env(client)
    state = HostedRuntimeState(
        environment_id=uuid.UUID(env_id),
        deployment_id="dep-config-etag-independent",
        instance_id="iid-config-etag-independent",
        generation=4,
        cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
        locale=_TEST_LOCALE,
        system=_TEST_SYSTEM,
        live_sync={"enabled": False, "agents": []},
        recovery={"cacheManifest": True, "allowOfflineBoot": True},
        runtimes=_test_runtimes(),
    )
    db_session.add(state)
    await db_session.commit()
    await db_session.refresh(state)
    desired_updated_at = state.updated_at

    first = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={
            "runtime_observed": _runtime_observed(
                watch_generation=4,
                manifest_etag='"manifest-etag-a"',
            )
        },
    )
    assert first.status_code == 204, first.text
    second = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={
            "runtime_observed": _runtime_observed(
                watch_generation=4,
                manifest_etag='"manifest-etag-b"',
            )
        },
    )
    assert second.status_code == 204, second.text

    observation = await db_session.get(HostedRuntimeConfigObservation, uuid.UUID(env_id))
    assert observation is not None
    assert observation.observed_config_generation == 4
    assert observation.observed_manifest_etag == '"manifest-etag-b"'
    await db_session.refresh(state)
    assert state.updated_at == desired_updated_at


@pytest.mark.asyncio
async def test_runtime_observed_endpoint_safely_degrades_migrated_legacy_diagnostics(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    env_id = await _create_env(client)
    db_session.add(
        HostedRuntimeState(
            environment_id=uuid.UUID(env_id),
            deployment_id="dep-legacy-diagnostics",
            instance_id="iid-legacy-diagnostics",
            generation=4,
            cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
            locale=_TEST_LOCALE,
            system=_TEST_SYSTEM,
            live_sync={"enabled": False, "agents": []},
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
            runtimes=_test_runtimes(),
        )
    )
    await db_session.commit()
    heartbeat = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"queue_depth": 0},
    )
    assert heartbeat.status_code == 204, heartbeat.text
    legacy_diagnostics = {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v1",
        "status": "ok",
        "legacyField": {"preserved": True},
    }
    db_session.add(
        HostedRuntimeConfigObservation(
            environment_id=uuid.UUID(env_id),
            observed_at=None,
            observed_config_generation=None,
            observed_manifest_etag=None,
            diagnostics=legacy_diagnostics,
        )
    )
    await db_session.commit()

    response = await client.get(f"/v1/environments/{env_id}/runtime-observed")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["observed"] == {
        "observed_at": None,
        "observed_config_generation": None,
        "observed_manifest_etag": None,
        "diagnostics": None,
    }
    assert payload["health"]["status"] == "unknown"
    assert {
        "runtime_diagnostics_invalid",
        "observed_config_generation_missing",
        "observed_manifest_etag_missing",
        "runtime_observed_at_missing",
    }.issubset(payload["health"]["reasons"])
    observation = await db_session.get(HostedRuntimeConfigObservation, uuid.UUID(env_id))
    assert observation is not None
    assert observation.diagnostics == legacy_diagnostics


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
        cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
        locale=_TEST_LOCALE,
        system=_TEST_SYSTEM,
        live_sync={"enabled": False, "agents": []},
        recovery={"cacheManifest": True, "allowOfflineBoot": True},
        runtimes=_test_runtimes(),
    )
    db_session.add(state)
    await db_session.commit()

    observed = _runtime_observed(reported_at="2026-06-11T00:00:00+00:00")
    first = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"queue_depth": 1, "runtime_observed": observed},
    )
    assert first.status_code == 204, first.text
    observation = await db_session.get(HostedRuntimeConfigObservation, uuid.UUID(env_id))
    assert observation is not None
    first_updated_at = observation.updated_at
    first_diagnostics = observation.diagnostics

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
    await db_session.refresh(observation)
    assert observation.updated_at == first_updated_at
    assert observation.diagnostics == first_diagnostics


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
        cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
        locale=_TEST_LOCALE,
        system=_TEST_SYSTEM,
        live_sync={"enabled": False, "agents": []},
        recovery={"cacheManifest": True, "allowOfflineBoot": True},
        runtimes=_test_runtimes(),
    )
    db_session.add(state)
    await db_session.commit()

    observed = _runtime_observed(
        supervisor={
            "status": "error",
            "programs": [
                {
                    "name": "clawdi-openclaw",
                    "state": "FATAL",
                    "status": "error",
                    "description": "Exited too quickly",
                }
            ],
        }
    )
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
    assert payload["observed"]["diagnostics"]["supervisor"]["programs"][0]["name"] == (
        "clawdi-openclaw"
    )


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
        cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
        locale=_TEST_LOCALE,
        system=_TEST_SYSTEM,
        live_sync={"enabled": False, "agents": []},
        recovery={"cacheManifest": True, "allowOfflineBoot": True},
        runtimes=_test_runtimes(),
    )
    db_session.add(state)
    await db_session.commit()

    observed = _runtime_observed(
        providers={
            "clawdi-managed": {
                "status": "error",
                "baseUrl": "https://sub2api.test/v1",
                "model": "gpt-5.5",
                "apiKeySecretRef": "provider.clawdi-managed.apiKey",
                "secretAvailable": False,
                "reasons": ["secret_missing"],
            }
        }
    )
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
        "observed_at": None,
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
async def test_runtime_observed_summary_has_bounded_queries_without_secret_decryption(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
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
                cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
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
                cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
                locale=_TEST_LOCALE,
                system=_TEST_SYSTEM,
                live_sync={"enabled": False, "agents": []},
                recovery={"cacheManifest": True, "allowOfflineBoot": True},
                runtimes=_test_runtimes(),
            ),
        ]
    )
    await db_session.commit()
    ok_observed = _runtime_observed(boot_generation=1, watch_generation=1)
    error_observed = _runtime_observed(
        boot_generation=1,
        watch_generation=1,
        providers={
            "default": {
                "status": "error",
                "apiKeySecretRef": "provider.default.apiKey",
                "secretAvailable": False,
            }
        },
    )
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

    def reject_decrypt(*_args, **_kwargs):
        raise AssertionError("runtime observed summary must not decrypt secrets")

    monkeypatch.setattr("app.services.runtime_source.decrypt", reject_decrypt)
    query_count = 0

    def count_query(*_args, **_kwargs) -> None:
        nonlocal query_count
        query_count += 1

    event.listen(engine.sync_engine, "before_cursor_execute", count_query)
    try:
        response = await client.get("/v1/environments/runtime-observed")
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", count_query)
    assert response.status_code == 200, response.text
    assert query_count <= 8
    payload = response.json()
    assert payload["counts"] == {
        "ok": 0,
        "error": 1,
        "stale": 0,
        "unknown": 1,
        "not_configured": 1,
    }
    by_env = {item["environment"]["id"]: item for item in payload["items"]}
    assert by_env[ok_env_id]["health"]["status"] == "unknown"
    assert "observed_source_revision_missing" in by_env[ok_env_id]["health"]["reasons"]
    assert by_env[ok_env_id]["observed"]["observed_config_generation"] == 1
    assert any(
        provider["status"] == "error" for provider in by_env[error_env_id]["provider_health"]
    )
    assert by_env[missing_state_env_id]["health"]["status"] == "not_configured"


@pytest.mark.asyncio
async def test_sync_heartbeat_rejects_malformed_observed_scalar(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    env_id = await _create_env(client)
    db_session.add(
        HostedRuntimeState(
            environment_id=uuid.UUID(env_id),
            deployment_id="dep-observed-strict",
            instance_id="iid-observed-strict",
            generation=4,
            cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
            locale=_TEST_LOCALE,
            system=_TEST_SYSTEM,
            live_sync={"enabled": False, "agents": []},
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
            runtimes=_test_runtimes(),
        )
    )
    await db_session.commit()
    observed = _runtime_observed()
    observed["watch"]["generation"] = "4"

    response = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"runtime_observed": observed},
    )

    assert response.status_code == 422, response.text
    assert await db_session.get(HostedRuntimeConfigObservation, uuid.UUID(env_id)) is None


@pytest.mark.asyncio
async def test_sync_heartbeat_bounds_oversized_observed_payload(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    env_id = await _create_env(client)
    db_session.add(
        HostedRuntimeState(
            environment_id=uuid.UUID(env_id),
            deployment_id="dep-observed-bounded",
            instance_id="iid-observed-bounded",
            generation=4,
            cli_package_spec=_TEST_CLI_PACKAGE_SPEC,
            locale=_TEST_LOCALE,
            system=_TEST_SYSTEM,
            live_sync={"enabled": False, "agents": []},
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
            runtimes=_test_runtimes(),
        )
    )
    await db_session.commit()
    observed = _runtime_observed()
    observed["error"] = "x" * (70 * 1024)

    response = await client.post(
        f"/v1/agents/{env_id}/sync-heartbeat",
        json={"runtime_observed": observed},
    )

    assert response.status_code == 204, response.text
    observation = await db_session.get(HostedRuntimeConfigObservation, uuid.UUID(env_id))
    assert observation is not None
    assert observation.diagnostics["truncated"] is True
    assert observation.diagnostics["error"] == "runtime observed payload exceeded size limit"


@pytest.mark.asyncio
async def test_bound_key_cannot_heartbeat_another_env(env_bound_cli_client):
    client, _bound_id, other_id = env_bound_cli_client
    r = await client.post(f"/v1/agents/{other_id}/sync-heartbeat", json={"queue_depth": 1})
    assert r.status_code == 403, r.text
