"""PostgreSQL permission graph, conditional delivery and mutation signals."""

import uuid
from contextlib import asynccontextmanager

import httpx
import pytest
from sqlalchemy import event

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.main import app
from app.models.agent_project_binding import AgentProjectBinding
from app.models.api_key import ApiKey
from app.models.project import Project
from app.models.vault import Vault, VaultProjectAttachment
from app.services import runtime_vaults, sync_events
from tests.conftest import create_env_with_project

pytestmark = [pytest.mark.asyncio, pytest.mark.committed_db]


@asynccontextmanager
async def agent_client(db, user, agent):
    auth = AuthContext(
        user=user,
        api_key=ApiKey(
            user_id=user.id,
            environment_id=agent.id,
            managed=True,
            runtime_deployment_id="fixture",
            scopes=["vault:read"],
        ),
    )

    async def session():
        yield db

    async def identity():
        return AuthContext(user=user, api_key=auth.api_key)

    previous = app.dependency_overrides.copy()
    app.dependency_overrides.update({get_session: session, get_auth: identity})
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            yield client, auth
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)


async def test_snapshot_scope_revision_mutations_and_fanout(
    db_session, seed_user, monkeypatch, engine
):
    agents = [
        await create_env_with_project(
            db_session, user_id=seed_user.id, machine_id=str(uuid.uuid4()), machine_name=name
        )
        for name in ("a", "b", "denied")
    ]
    shared = Project(
        user_id=seed_user.id, name="Shared", slug=f"shared-{uuid.uuid4().hex}", kind="workspace"
    )
    db_session.add(shared)
    await db_session.flush()
    for agent in agents[:2]:
        db_session.add(
            AgentProjectBinding(
                agent_id=agent.id,
                project_id=shared.id,
                binding_type="context",
                priority=1,
                default_write_enabled=False,
                created_by_user_id=seed_user.id,
            )
        )
    await db_session.commit()
    signals = []
    monkeypatch.setattr(
        sync_events, "_broadcast", lambda user_id, payload: signals.append((user_id, payload))
    )

    async def forbidden_render(*args, **kwargs):
        raise AssertionError("Vault changes must not render manifests")

    monkeypatch.setattr(
        "app.services.runtime_source_revision.refresh_runtime_source_revisions", forbidden_render
    )
    async with agent_client(db_session, seed_user, agents[0]) as (client, auth):
        # Owner web mutation authority; bound read authority is restored below.
        auth.api_key = None
        create = await client.post(
            "/v1/vault",
            params={"project_id": str(shared.id)},
            json={"slug": "sync", "name": "Sync"},
        )
        assert create.status_code == 200, create.text
        vault_id = create.json()["id"]
        params = {"vault_id": vault_id}
        assert (
            await client.put(
                "/v1/vault/sync/items",
                params=params,
                json={"section": "one", "fields": {"TOKEN": "first"}},
            )
        ).status_code == 200
        assert (
            await client.put(
                "/v1/vault/sync/items",
                params=params,
                json={"section": "two", "fields": {"TOKEN": "other"}},
            )
        ).status_code == 200
        db_session.add(
            VaultProjectAttachment(
                vault_id=uuid.UUID(vault_id), project_id=agents[0].default_project_id
            )
        )
        await db_session.commit()
        auth.api_key = ApiKey(
            user_id=seed_user.id,
            environment_id=agents[0].id,
            managed=True,
            runtime_deployment_id="fixture",
            scopes=["vault:read"],
        )
        first = await client.get("/v1/runtime/vaults")
        assert first.status_code == 200, first.text
        material = await client.post(
            "/v1/runtime/vaults/material", json={"etag": first.headers["etag"], "revisions": {}}
        )
        assert material.status_code == 200, material.text
        payload = material.json()
        assert payload["complete"] is True and len(payload["vaults"]) == 1
        assert len(payload["vaults"][0]["project_ids"]) == 2
        assert {field["value"] for field in payload["vaults"][0]["fields"]} == {"first", "other"}
        # Legacy Agent-bound keys must neither read linked Projects nor reuse their material ETag.
        auth.api_key.managed = False
        legacy = await client.get("/v1/runtime/vaults")
        assert legacy.status_code == 200
        assert legacy.json()["vaults"][0]["project_ids"] == [str(agents[0].default_project_id)]
        assert (
            await client.post(
                "/v1/runtime/vaults/material", json={"etag": first.headers["etag"], "revisions": {}}
            )
        ).status_code == 409
        auth.api_key.environment_id = agents[1].id
        assert (await client.get("/v1/runtime/vaults")).json()["vaults"] == []
        auth.api_key.environment_id = agents[0].id
        auth.api_key.managed = True
        etag = first.headers["etag"]
        sql = []

        def count(_conn, _cursor, statement, _parameters, _context, _many):
            sql.append(statement)

        # Snapshot sessions use the application engine, not the fixture engine.
        from app.core.database import engine as app_engine

        event.listen(app_engine.sync_engine, "before_cursor_execute", count)
        original_decrypt = runtime_vaults.decrypt
        monkeypatch.setattr(
            runtime_vaults,
            "decrypt",
            lambda *args: (_ for _ in ()).throw(AssertionError("304 decrypted")),
        )
        try:
            unchanged = await client.get("/v1/runtime/vaults", headers={"If-None-Match": etag})
            assert unchanged.status_code == 304 and unchanged.content == b""
            assert not any("vault_items" in statement for statement in sql)
            reuse = await client.post(
                "/v1/runtime/vaults/material",
                json={"etag": etag, "revisions": {vault_id: payload["vaults"][0]["revision"]}},
            )
            assert reuse.status_code == 200 and reuse.json()["vaults"][0]["fields"] is None
            assert not any("vault_items" in statement for statement in sql)
            print(
                f"runtime-vault fixture conditional + reuse: {len(sql)} snapshot DB statements; "
                "zero item reads/decryptions"
            )
        finally:
            event.remove(app_engine.sync_engine, "before_cursor_execute", count)
            monkeypatch.setattr(runtime_vaults, "decrypt", original_decrypt)
        auth.api_key.environment_id = agents[2].id
        denied = await client.get("/v1/runtime/vaults")
        assert denied.json()["vaults"] == []
        auth.api_key.environment_id = agents[1].id
        assert len((await client.get("/v1/runtime/vaults")).json()["vaults"]) == 1
        auth.api_key = None
        signals.clear()
        changed = await client.put(
            "/v1/vault/sync/items",
            params=params,
            json={"section": "one", "fields": {"TOKEN": "rotated", "NEW": "added"}},
        )
        assert changed.status_code == 200, changed.text
        assert {p["environment_id"] for _, p in signals} == {str(a.id) for a in agents[:2]}
        assert all(
            set(p) == {"type", "environment_id"} and p["type"] == "runtime_vaults_changed"
            for _, p in signals
        )
        auth.api_key = ApiKey(
            user_id=seed_user.id,
            environment_id=agents[0].id,
            managed=True,
            runtime_deployment_id="fixture",
            scopes=["vault:read"],
        )
        updated = await client.get("/v1/runtime/vaults", headers={"If-None-Match": etag})
        assert updated.status_code == 200 and updated.headers["etag"] != etag
        auth.api_key = None
        assert (
            await client.request(
                "DELETE",
                "/v1/vault/sync/items",
                params={**params, "global_delete": True},
                json={"section": "one", "fields": ["TOKEN"]},
            )
        ).status_code == 200
        assert (await client.delete("/v1/vault/sync", params=params)).status_code == 200
        auth.api_key = ApiKey(
            user_id=seed_user.id,
            environment_id=agents[0].id,
            managed=True,
            runtime_deployment_id="fixture",
            scopes=["vault:read"],
        )
        assert (await client.get("/v1/runtime/vaults")).json()["vaults"] == []
        auth.api_key.scopes = []
        assert (await client.get("/v1/runtime/vaults")).status_code == 403
        auth.api_key.environment_id = None
        auth.api_key.scopes = ["vault:read"]
        assert (await client.get("/v1/runtime/vaults")).status_code == 403


@pytest.mark.parametrize("connected", [False, True])
async def test_real_http_runtime_watch(db_session, seed_user, monkeypatch, connected):
    """Run the actual watch loop against HTTP/PG; native service operations are fixtures."""
    import asyncio
    import hashlib
    import os
    import secrets
    import shutil
    import socket
    from datetime import UTC, datetime
    from pathlib import Path

    import uvicorn

    from app.models.vault import VaultItem
    from app.services.vault_crypto import encrypt

    repo = Path(__file__).resolve().parents[2]
    if not shutil.which("bun") or not (repo / "node_modules").exists():
        pytest.skip("Combined Docker fixture requires locked JS dependencies")
    agent = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=str(uuid.uuid4()),
        machine_name="live",
        agent_type="pi" if connected else "claude_code",
    )
    if connected:
        agent.connected_agent_registered_at = datetime.now(UTC)
        agent.machine_fence_required = True
    runtime_token, owner_token = ["clawdi_" + secrets.token_hex(24) for _ in range(2)]
    for token, bound, scopes in [
        (
            runtime_token,
            None if connected else agent.id,
            None if connected else ["vault:read", "skills:read"],
        ),
        (owner_token, None, None),
    ]:
        db_session.add(
            ApiKey(
                user_id=seed_user.id,
                key_hash=hashlib.sha256(token.encode()).hexdigest(),
                key_prefix=token[:12],
                label="isolated-vault-fixture",
                environment_id=bound,
                scopes=scopes,
            )
        )
    vault = Vault(user_id=seed_user.id, slug="live", name="Live")
    db_session.add(vault)
    await db_session.flush()
    ciphertext, nonce = encrypt("initial")
    db_session.add_all(
        [
            VaultProjectAttachment(vault_id=vault.id, project_id=agent.default_project_id),
            VaultItem(
                vault_id=vault.id,
                item_name="TOKEN",
                section="",
                encrypted_value=ciphertext,
                nonce=nonce,
            ),
        ]
    )
    await db_session.commit()
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    port = listener.getsockname()[1]
    from collections import Counter
    from contextvars import ContextVar

    from app.core.database import engine as app_engine

    active_path = ContextVar("vault_fixture_path", default="")
    missed_event = ContextVar("vault_fixture_missed", default=False)
    broadcast = sync_events._broadcast

    def deliver(user_id, payload):
        if not missed_event.get():
            broadcast(user_id, payload)

    monkeypatch.setattr(sync_events, "_broadcast", deliver)
    requests, statements = Counter(), Counter()

    async def metered(scope, receive, send):
        path = scope.get("path", "")
        token = active_path.set(path)
        missed_token = missed_event.set((b"x-fixture-missed", b"true") in scope.get("headers", []))
        requests[path] += 1
        try:
            await app(scope, receive, send)
        finally:
            active_path.reset(token)
            missed_event.reset(missed_token)

    def count_sql(*args):
        statements[active_path.get()] += 1

    event.listen(app_engine.sync_engine, "before_cursor_execute", count_sql)
    server = uvicorn.Server(
        uvicorn.Config(metered, lifespan="off", log_level="error", timeout_graceful_shutdown=2)
    )
    server_task = asyncio.create_task(server.serve(sockets=[listener]))
    process = None
    try:
        async with asyncio.timeout(5):
            while not server.started:
                await asyncio.sleep(0.01)
        process = await asyncio.create_subprocess_exec(
            "bun",
            "test",
            "src/serve/vault-daemon.test.ts" if connected else "tests/runtime.test.ts",
            "--test-name-pattern",
            "connected daemon Vault delivery"
            if connected
            else "runtime Vault delivery over PostgreSQL",
            cwd=repo / "packages/cli",
            env={
                **os.environ,
                "CLAWDI_VAULT_FIXTURE_URL": f"http://127.0.0.1:{port}",
                "CLAWDI_VAULT_FIXTURE_AGENT": str(agent.id),
                "CLAWDI_VAULT_FIXTURE_VAULT": str(vault.id),
                "CLAWDI_VAULT_FIXTURE_TOKEN": runtime_token,
                "CLAWDI_VAULT_FIXTURE_OWNER": owner_token,
                "CLAWDI_VAULT_FIXTURE_MACHINE": agent.machine_id,
                "CLAWDI_VAULT_FIXTURE_USER": str(seed_user.id),
            },
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        output, _ = await asyncio.wait_for(process.communicate(), 40)
        text = output.decode().replace(runtime_token, "[fixture]").replace(owner_token, "[fixture]")
        assert process.returncode == 0, text
        print(text)
        print({"fixture_requests": dict(requests), "fixture_db_statements": dict(statements)})
    finally:
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        server.should_exit = True
        await asyncio.wait_for(server_task, 5)
        listener.close()
        event.remove(app_engine.sync_engine, "before_cursor_execute", count_sql)
        await db_session.delete(vault)
        await db_session.commit()


async def test_shared_membership_is_rechecked_and_unchanged_vaults_are_not_decrypted(
    db_session, seed_user, monkeypatch
):
    from datetime import UTC, datetime

    from sqlalchemy import delete

    from app.models.project_membership import ProjectMembership
    from app.models.user import User
    from app.models.vault import VaultItem
    from app.services.vault_crypto import encrypt

    viewer = User(clerk_id=f"vault-viewer-{uuid.uuid4().hex}")
    db_session.add(viewer)
    await db_session.flush()
    agent = await create_env_with_project(
        db_session, user_id=viewer.id, machine_id=str(uuid.uuid4()), machine_name="viewer"
    )
    other = await create_env_with_project(
        db_session, user_id=seed_user.id, machine_id=str(uuid.uuid4()), machine_name="private"
    )
    project = Project(user_id=seed_user.id, name="Shared", slug=uuid.uuid4().hex, kind="workspace")
    db_session.add(project)
    await db_session.flush()
    membership = ProjectMembership(
        project_id=project.id,
        member_user_id=viewer.id,
        role="viewer",
        joined_via="link",
        joined_at=datetime.now(UTC),
        resolved_owner_handle="fixture",
    )
    db_session.add(membership)
    # A corrupt/legacy binding to another Agent's private Workspace still grants nothing.
    for priority, project_id in enumerate([project.id, other.default_project_id], 1):
        db_session.add(
            AgentProjectBinding(
                agent_id=agent.id,
                project_id=project_id,
                binding_type="context",
                priority=priority,
                default_write_enabled=False,
                created_by_user_id=viewer.id,
            )
        )
    vaults = []
    for name, project_id in [
        ("changed", project.id),
        ("unchanged", project.id),
        ("private", other.default_project_id),
    ]:
        vault = Vault(user_id=seed_user.id, slug=name, name=name)
        db_session.add(vault)
        await db_session.flush()
        ciphertext, nonce = encrypt(name)
        db_session.add_all(
            [
                VaultProjectAttachment(vault_id=vault.id, project_id=project_id),
                VaultItem(
                    vault_id=vault.id,
                    item_name="TOKEN",
                    section="",
                    encrypted_value=ciphertext,
                    nonce=nonce,
                ),
            ]
        )
        vaults.append(vault)
    await db_session.commit()
    try:
        inventory, _ = await runtime_vaults.vault_snapshot_metadata(
            db_session, viewer.id, agent.id, allow_linked_projects=True
        )
        assert set(inventory) == {v.id for v in vaults[:2]}
        revisions = {key: value.revision for key, value in inventory.items()}
        await runtime_vaults.notify_vault_changed(db_session, vaults[0].id, values_changed=True)
        await db_session.commit()
        inventory, _ = await runtime_vaults.vault_snapshot_metadata(
            db_session, viewer.id, agent.id, allow_linked_projects=True
        )
        decrypted = []
        original = runtime_vaults.decrypt

        def decrypt_once(value, nonce):
            decrypted.append(1)
            return original(value, nonce)

        monkeypatch.setattr(runtime_vaults, "decrypt", decrypt_once)
        snapshot = await runtime_vaults.vault_snapshot_values(
            db_session, viewer.id, agent.id, inventory, revisions
        )
        assert len(decrypted) == 1
        assert next(v for v in snapshot.vaults if v.id == vaults[1].id).fields is None
        await db_session.delete(membership)
        await db_session.commit()
        revoked, _ = await runtime_vaults.vault_snapshot_metadata(
            db_session, viewer.id, agent.id, allow_linked_projects=True
        )
        assert not revoked  # Stale binding must not retain plaintext access.
    finally:
        for vault in vaults:
            await db_session.delete(vault)
        await db_session.execute(delete(User).where(User.id == viewer.id))
        await db_session.commit()


async def test_connected_snapshot_requires_owned_registered_machine_identity(db_session, seed_user):
    from datetime import UTC, datetime, timedelta

    agent = await create_env_with_project(
        db_session, user_id=seed_user.id, machine_id=str(uuid.uuid4()), machine_name="connected"
    )
    agent.connected_agent_registered_at = datetime.now(UTC)
    agent.machine_fence_required = True
    await db_session.commit()
    async with agent_client(db_session, seed_user, agent) as (client, auth):
        auth.api_key = ApiKey(user_id=seed_user.id, scopes=["vault:read"])
        params = {"agent_id": str(agent.id)}
        assert (await client.get("/v1/runtime/vaults", params=params)).status_code == 403
        assert (
            await client.get(
                "/v1/runtime/vaults", params=params, headers={"X-Clawdi-Machine-Id": "wrong"}
            )
        ).status_code == 403
        headers = {"X-Clawdi-Machine-Id": agent.machine_id}
        metadata = await client.get("/v1/runtime/vaults", params=params, headers=headers)
        assert metadata.status_code == 200, metadata.text
        material = await client.post(
            "/v1/runtime/vaults/material",
            params=params,
            headers=headers,
            json={"etag": metadata.headers["etag"]},
        )
        assert material.status_code == 200, material.text
        assert material.json()["agent_id"] == str(agent.id)
        assert (
            await client.get(
                "/v1/runtime/vaults", params={"agent_id": str(uuid.uuid4())}, headers=headers
            )
        ).status_code == 404
        agent.connected_agent_registered_at = None
        await db_session.commit()
        assert (
            await client.get("/v1/runtime/vaults", params=params, headers=headers)
        ).status_code == 409
        agent.connected_agent_registered_at = datetime.now(UTC)
        await db_session.commit()
        previous = app.dependency_overrides[get_auth]

        async def oauth_identity():
            return AuthContext(
                user=seed_user,
                oauth_cli=True,
                oauth_access_expires_at=datetime.now(UTC) + timedelta(minutes=5),
            )

        app.dependency_overrides[get_auth] = oauth_identity
        try:
            assert (
                await client.get("/v1/runtime/vaults", params=params, headers=headers)
            ).status_code == 200
            assert (await client.get("/v1/runtime/vaults", params=params)).status_code == 403
        finally:
            app.dependency_overrides[get_auth] = previous
