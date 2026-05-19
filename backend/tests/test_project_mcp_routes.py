import uuid
from datetime import UTC, datetime

import pytest


async def _create_server(client, nonce: str):
    response = await client.post(
        "/api/mcp/servers",
        json={
            "slug": f"github-{nonce}",
            "name": f"GitHub {nonce}",
            "description": "GitHub MCP server",
            "transport": "stdio",
            "runtime_mode": "local",
            "default_command": "npx",
            "default_args": ["-y", "@modelcontextprotocol/server-github"],
            "required_inputs": {"env": ["GITHUB_TOKEN"]},
            "capabilities": {"tools": ["github.create_issue"]},
            "risk_metadata": {"default_risk": "write"},
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.asyncio
async def test_mcp_server_crud_and_catalog_guard(client):
    nonce = uuid.uuid4().hex[:8]

    catalog = await client.post(
        "/api/mcp/servers",
        json={
            "slug": f"catalog-{nonce}",
            "name": "Catalog Server",
            "visibility": "catalog",
            "transport": "stdio",
        },
    )
    assert catalog.status_code == 403, catalog.text

    created = await _create_server(client, nonce)
    server_id = created["id"]
    assert created["visibility"] == "private"
    assert created["default_args"] == ["-y", "@modelcontextprotocol/server-github"]

    patched = await client.patch(
        f"/api/mcp/servers/{server_id}",
        json={"name": "GitHub MCP", "default_args": ["-y", "github-mcp"]},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["name"] == "GitHub MCP"
    assert patched.json()["default_args"] == ["-y", "github-mcp"]

    listing = await client.get("/api/mcp/servers")
    assert listing.status_code == 200, listing.text
    assert any(row["id"] == server_id for row in listing.json())

    deleted = await client.delete(f"/api/mcp/servers/{server_id}")
    assert deleted.status_code == 204, deleted.text

    after_delete = await client.get("/api/mcp/servers")
    assert after_delete.status_code == 200, after_delete.text
    assert all(row["id"] != server_id for row in after_delete.json())


@pytest.mark.asyncio
async def test_project_mcp_pack_installation_bindings_and_tool_policy(
    client,
    db_session,
    seed_user,
    seed_project,
):
    from app.models.project import PROJECT_KIND_WORKSPACE, Project
    from app.models.vault import Vault, VaultItem, VaultProjectAttachment
    from app.services.vault_crypto import encrypt

    nonce = uuid.uuid4().hex[:8]
    server = await _create_server(client, nonce)

    pack_response = await client.post(
        "/api/mcp/packs",
        json={
            "slug": f"dev-tools-{nonce}",
            "name": f"Dev Tools {nonce}",
            "entries": [
                {
                    "mcp_server_id": server["id"],
                    "server_alias": f"github-{nonce}",
                    "default_tool_prefix": "gh",
                    "default_enabled": True,
                    "version_pin": "latest",
                }
            ],
        },
    )
    assert pack_response.status_code == 201, pack_response.text
    pack = pack_response.json()
    assert pack["entries"][0]["server"]["id"] == server["id"]

    install_response = await client.post(
        f"/api/projects/{seed_project.id}/mcp/packs/{pack['id']}/install"
    )
    assert install_response.status_code == 201, install_response.text
    installed = install_response.json()
    assert len(installed) == 1
    installation = installed[0]
    assert installation["source_pack_id"] == pack["id"]
    assert installation["server_alias"] == f"github-{nonce}"
    assert installation["tool_prefix"] == "gh"

    other_project = Project(
        user_id=seed_user.id,
        name=f"Other {nonce}",
        slug=f"other-{nonce}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(other_project)
    await db_session.flush()

    other_vault = Vault(
        user_id=seed_user.id,
        slug=f"other-{nonce}",
        name="Other Vault",
    )
    db_session.add(other_vault)
    await db_session.flush()
    db_session.add(VaultProjectAttachment(vault_id=other_vault.id, project_id=other_project.id))
    other_ciphertext, other_nonce = encrypt("wrong-project")
    other_item = VaultItem(
        vault_id=other_vault.id,
        section="",
        item_name="GITHUB_TOKEN",
        encrypted_value=other_ciphertext,
        nonce=other_nonce,
    )
    db_session.add(other_item)

    vault = Vault(
        user_id=seed_user.id,
        slug=f"github-{nonce}",
        name="GitHub",
    )
    db_session.add(vault)
    await db_session.flush()
    db_session.add(VaultProjectAttachment(vault_id=vault.id, project_id=seed_project.id))
    ciphertext, nonce_bytes = encrypt("secret-token")
    item = VaultItem(
        vault_id=vault.id,
        section="",
        item_name="GITHUB_TOKEN",
        encrypted_value=ciphertext,
        nonce=nonce_bytes,
    )
    db_session.add(item)
    await db_session.commit()

    rejected_binding = await client.put(
        f"/api/projects/{seed_project.id}/mcp/installations/{installation['id']}/bindings",
        json={
            "bindings": [
                {
                    "target_kind": "env",
                    "target_name": "GITHUB_TOKEN",
                    "value_source": "vault",
                    "vault_id": str(other_vault.id),
                    "vault_item_id": str(other_item.id),
                }
            ]
        },
    )
    assert rejected_binding.status_code == 404, rejected_binding.text

    binding_response = await client.put(
        f"/api/projects/{seed_project.id}/mcp/installations/{installation['id']}/bindings",
        json={
            "bindings": [
                {
                    "target_kind": "env",
                    "target_name": "GITHUB_TOKEN",
                    "value_source": "vault",
                    "vault_id": str(vault.id),
                    "vault_item_id": str(item.id),
                    "display_vault_uri": f"vault://{vault.slug}/GITHUB_TOKEN",
                },
            ]
        },
    )
    assert binding_response.status_code == 200, binding_response.text
    bindings = binding_response.json()["bindings"]
    binding = next(item for item in bindings if item["target_name"] == "GITHUB_TOKEN")
    assert binding["vault_id"] == str(vault.id)
    assert binding["vault_item_id"] == str(item.id)

    policy_response = await client.put(
        f"/api/projects/{seed_project.id}/mcp/installations/{installation['id']}/tools",
        json={
            "tools": [
                {
                    "tool_name": "github.create_issue",
                    "enabled": False,
                    "risk_level": "write",
                    "approval_policy": "always_ask",
                }
            ]
        },
    )
    assert policy_response.status_code == 200, policy_response.text
    body = policy_response.json()
    assert body["bindings"][0]["target_name"] == "GITHUB_TOKEN"
    assert body["tool_policies"][0]["approval_policy"] == "always_ask"

    listing = await client.get(f"/api/projects/{seed_project.id}/mcp")
    assert listing.status_code == 200, listing.text
    assert any(row["id"] == installation["id"] for row in listing.json())


@pytest.mark.asyncio
async def test_project_mcp_member_can_read_but_not_write_shared_installation(
    client,
    db_session,
    seed_user,
):
    from app.models.mcp import McpServer, ProjectMcpInstallation
    from app.models.project import PROJECT_KIND_WORKSPACE, Project
    from app.models.project_membership import ProjectMembership
    from app.models.user import User

    nonce = uuid.uuid4().hex[:8]
    owner = User(
        clerk_id=f"mcp_owner_{nonce}",
        email=f"mcp_owner_{nonce}@test.dev",
        name="MCP Owner",
    )
    db_session.add(owner)
    await db_session.commit()

    shared = Project(
        user_id=owner.id,
        name=f"Shared MCP {nonce}",
        slug=f"shared-mcp-{nonce}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(shared)
    await db_session.flush()
    db_session.add(
        ProjectMembership(
            project_id=shared.id,
            member_user_id=seed_user.id,
            role="viewer",
            joined_via="invite",
            joined_at=datetime.now(UTC),
            resolved_owner_handle=f"mcp-{nonce}",
        )
    )
    server = McpServer(
        owner_user_id=owner.id,
        slug=f"owner-github-{nonce}",
        name="Owner GitHub",
        transport="stdio",
        runtime_mode="local",
        default_command="npx",
    )
    db_session.add(server)
    await db_session.flush()
    installation = ProjectMcpInstallation(
        project_id=shared.id,
        mcp_server_id=server.id,
        installed_by_user_id=owner.id,
        server_alias=f"owner-github-{nonce}",
        tool_prefix="owner",
    )
    db_session.add(installation)
    await db_session.commit()

    try:
        listing = await client.get(f"/api/projects/{shared.id}/mcp")
        assert listing.status_code == 200, listing.text
        rows = listing.json()
        assert rows[0]["id"] == str(installation.id)
        assert rows[0]["server"]["owner_user_id"] == str(owner.id)

        detail = await client.get(f"/api/projects/{shared.id}/mcp/installations/{installation.id}")
        assert detail.status_code == 200, detail.text
        assert detail.json()["server_alias"] == f"owner-github-{nonce}"

        write = await client.post(
            f"/api/projects/{shared.id}/mcp/installations",
            json={
                "mcp_server_id": str(server.id),
                "server_alias": f"recipient-{nonce}",
            },
        )
        assert write.status_code == 404, write.text

        delete = await client.delete(
            f"/api/projects/{shared.id}/mcp/installations/{installation.id}"
        )
        assert delete.status_code == 404, delete.text
    finally:
        await db_session.delete(shared)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_env_bound_agent_key_cannot_list_account_mcp_library(db_session, seed_user):
    import httpx

    from app.core.auth import AuthContext, get_auth
    from app.core.database import get_session
    from app.main import app
    from app.models.api_key import ApiKey
    from tests.conftest import create_env_with_project

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"mcp-bound-{uuid.uuid4().hex[:8]}",
        machine_name="Bound Agent",
    )

    async def _override_get_session():
        yield db_session

    async def _override_get_auth() -> AuthContext:
        return AuthContext(
            user=seed_user,
            api_key=ApiKey(user_id=seed_user.id, environment_id=env.id),
        )

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.get("/api/mcp/servers")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 403, response.text
