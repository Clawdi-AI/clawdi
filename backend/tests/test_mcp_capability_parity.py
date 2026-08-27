from __future__ import annotations

import json
import sys
import uuid
from datetime import UTC, datetime, timedelta
from types import ModuleType
from typing import Any

import httpx
import pytest
from fastapi import HTTPException
from httpx import ASGITransport
from sqlalchemy import select

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.main import app
from app.models.agent_project_binding import AgentProjectBinding
from app.models.api_key import RUNTIME_DEPLOYMENT_KEY_SCOPES, ApiKey
from app.models.memory import Memory
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.project_membership import ProjectMembership
from app.models.session import Session
from app.models.user import User
from app.models.vault import Vault, VaultItem, VaultProjectAttachment
from app.routes import mcp_bridge
from app.routes import memories as memory_routes
from app.services.memory_provider import Mem0Provider
from tests.conftest import create_env_with_project

pytestmark = pytest.mark.committed_db


class _FakeMem0Module(ModuleType):
    MemoryClient: object


class _FakeMem0ExceptionsModule(ModuleType):
    MemoryError: type[Exception]
    NetworkError: type[Exception]
    RateLimitError: type[Exception]


def _runtime_auth(user, environment_id, *, scopes: list[str] | None = None) -> AuthContext:
    return AuthContext(
        user=user,
        api_key=ApiKey(
            user_id=user.id,
            environment_id=environment_id,
            managed=True,
            runtime_deployment_id=f"deployment-{environment_id}",
            scopes=list(RUNTIME_DEPLOYMENT_KEY_SCOPES) if scopes is None else scopes,
        ),
    )


async def _rpc(client: httpx.AsyncClient, request_id: int, method: str, params: dict) -> dict:
    response = await client.post(
        "/v1/mcp/clawdi",
        json={"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
    )
    assert response.status_code == 200, response.text
    return response.json()["result"]


async def _tool_call(
    client: httpx.AsyncClient,
    request_id: int,
    name: str,
    arguments: dict[str, Any] | None = None,
) -> dict:
    return await _rpc(
        client,
        request_id,
        "tools/call",
        {"name": name, "arguments": arguments or {}},
    )


def _tool_json(result: dict) -> Any:
    return json.loads(result["content"][0]["text"])


def _assert_no_vault_values(value: object) -> None:
    if isinstance(value, dict):
        assert not ({"value", "encrypted_value", "nonce", "secret"} & value.keys())
        for child in value.values():
            _assert_no_vault_values(child)
    elif isinstance(value, list):
        for child in value:
            _assert_no_vault_values(child)


def test_vault_resolve_accepts_only_canonical_project_references() -> None:
    project_id = uuid.uuid4()
    reference = (
        f"clawdi://project/{project_id}/vault/runtime-a/section/stripe%20prod/field/SECRET%2FKEY"
    )
    assert mcp_bridge._parse_exact_project_vault_reference(reference) == (
        project_id,
        "runtime-a",
        "stripe prod",
        "SECRET/KEY",
    )

    for invalid in (
        reference.replace("%2F", "/"),
        reference.replace("%2F", "%2f"),
        f"{reference}?raw=true",
        f"{reference}#fragment",
        reference.replace("clawdi://project/", "clawdi://vault/"),
    ):
        with pytest.raises(HTTPException, match="Invalid Vault reference"):
            mcp_bridge._parse_exact_project_vault_reference(invalid)


@pytest.mark.asyncio
async def test_hosted_account_memory_and_project_vault_mcp_boundaries(
    db_session,
    seed_user,
    monkeypatch,
) -> None:
    env_a = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="mcp-parity-a",
        machine_name="MCP Parity A",
        agent_type="openclaw",
    )
    env_b = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="mcp-parity-b",
        machine_name="MCP Parity B",
        agent_type="hermes",
    )
    now = datetime.now(UTC)
    session_a = Session(
        user_id=seed_user.id,
        environment_id=env_a.id,
        local_session_id="mcp-parity-session-a",
        started_at=now,
    )
    session_b = Session(
        user_id=seed_user.id,
        environment_id=env_b.id,
        local_session_id="mcp-parity-session-b",
        started_at=now,
    )
    db_session.add_all([session_a, session_b])
    await db_session.flush()
    db_session.add_all(
        [
            Memory(
                user_id=seed_user.id,
                content="Legacy parity marker belongs to environment A.",
                source="session",
                source_session_id=session_a.id,
            ),
            Memory(
                user_id=seed_user.id,
                content="Legacy parity marker belongs to environment B.",
                source="session",
                source_session_id=session_b.id,
            ),
        ]
    )

    vault_a = Vault(user_id=seed_user.id, slug="runtime-a", name="Runtime A")
    vault_b = Vault(user_id=seed_user.id, slug="runtime-b", name="Runtime B")
    linked_owner = User(
        clerk_id="mcp_parity_linked_owner",
        email="mcp_parity_linked_owner@test.dev",
        name="MCP Parity Linked Owner",
    )
    db_session.add(linked_owner)
    await db_session.flush()
    linked_project = Project(
        user_id=linked_owner.id,
        slug="mcp-parity-linked",
        name="MCP Parity Linked",
        kind=PROJECT_KIND_WORKSPACE,
    )
    linked_vault = Vault(user_id=linked_owner.id, slug="runtime-linked", name="Runtime Linked")
    db_session.add_all([vault_a, vault_b, linked_project, linked_vault])
    await db_session.flush()
    db_session.add_all(
        [
            ProjectMembership(
                project_id=linked_project.id,
                member_user_id=seed_user.id,
                role="viewer",
                joined_via="link",
                joined_at=now,
                resolved_owner_handle="mcp-parity-linked-owner",
            ),
            AgentProjectBinding(
                agent_id=env_a.id,
                project_id=linked_project.id,
                binding_type="context",
                priority=1,
                default_write_enabled=False,
                created_by_user_id=seed_user.id,
            ),
            VaultProjectAttachment(vault_id=vault_a.id, project_id=env_a.default_project_id),
            VaultProjectAttachment(vault_id=vault_b.id, project_id=env_b.default_project_id),
            VaultProjectAttachment(vault_id=linked_vault.id, project_id=linked_project.id),
            VaultItem(
                vault_id=vault_a.id,
                section="",
                item_name="DEFAULT_TOKEN",
                encrypted_value=b"runtime-a-default-secret",
                nonce=b"a" * 12,
            ),
            VaultItem(
                vault_id=vault_a.id,
                section="stripe prod",
                item_name="SECRET/KEY",
                encrypted_value=b"runtime-a-named-secret",
                nonce=b"b" * 12,
            ),
            VaultItem(
                vault_id=vault_b.id,
                section="",
                item_name="OTHER_TOKEN",
                encrypted_value=b"runtime-b-secret",
                nonce=b"c" * 12,
            ),
            VaultItem(
                vault_id=linked_vault.id,
                section="",
                item_name="LINKED_TOKEN",
                encrypted_value=b"runtime-linked-secret",
                nonce=b"d" * 12,
            ),
        ]
    )
    await db_session.commit()

    active_auth = {"value": _runtime_auth(seed_user, env_a.id)}

    async def override_session():
        yield db_session

    async def override_auth() -> AuthContext:
        return active_auth["value"]

    async def no_connectors(_auth: AuthContext) -> list[dict[str, Any]]:
        return []

    monkeypatch.setattr(mcp_bridge, "_connector_mcp_tools", no_connectors)
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth] = override_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            listed = await _rpc(client, 1, "tools/list", {})
            names = {tool["name"] for tool in listed["tools"]}
            assert {
                "memory_search",
                "memory_add",
                "project_current",
                "project_list",
                "project_get",
                "vault_list",
                "vault_get",
                "vault_resolve",
            } <= names

            added = await _tool_call(
                client,
                2,
                "memory_add",
                {"content": "Hosted direct parity marker is shared across the account."},
            )
            assert "Memory stored" in added["content"][0]["text"]
            direct_memory = (
                await db_session.execute(
                    select(Memory).where(
                        Memory.content
                        == "Hosted direct parity marker is shared across the account."
                    )
                )
            ).scalar_one()
            assert direct_memory.source_environment_id == env_a.id
            assert direct_memory.source_session_id is None

            direct_search = await _tool_call(
                client,
                3,
                "memory_search",
                {"query": "Hosted direct parity marker"},
            )
            assert "shared across the account" in direct_search["content"][0]["text"]
            legacy_search = await _tool_call(
                client,
                4,
                "memory_search",
                {"query": "Legacy parity marker"},
            )
            assert "environment A" in legacy_search["content"][0]["text"]
            assert "environment B" in legacy_search["content"][0]["text"]

            current = _tool_json(await _tool_call(client, 5, "project_current"))
            projects = _tool_json(await _tool_call(client, 6, "project_list"))["projects"]
            assert current["id"] == str(env_a.default_project_id)
            assert {project["id"] for project in projects} == {
                str(env_a.default_project_id),
                str(linked_project.id),
            }

            vaults = _tool_json(await _tool_call(client, 7, "vault_list"))["vaults"]
            assert {entry["vault"]["id"] for entry in vaults} == {
                str(vault_a.id),
                str(linked_vault.id),
            }
            vault_result = _tool_json(
                await _tool_call(
                    client,
                    8,
                    "vault_get",
                    {
                        "project_id": str(env_a.default_project_id),
                        "vault_id": str(vault_a.id),
                    },
                )
            )
            references = {entry["reference"] for entry in vault_result["keys"]}
            assert references == {
                (
                    f"clawdi://project/{env_a.default_project_id}/vault/runtime-a/"
                    "field/DEFAULT_TOKEN"
                ),
                (
                    f"clawdi://project/{env_a.default_project_id}/vault/runtime-a/"
                    "section/stripe%20prod/field/SECRET%2FKEY"
                ),
            }
            _assert_no_vault_values(vault_result)
            serialized_vault_result = json.dumps(vault_result)
            assert "runtime-a-default-secret" not in serialized_vault_result
            assert "runtime-a-named-secret" not in serialized_vault_result

            monkeypatch.setattr(
                mcp_bridge,
                "decrypt",
                lambda encrypted_value, _nonce: encrypted_value.decode(),
            )
            default_reference = next(
                reference for reference in references if reference.endswith("/DEFAULT_TOKEN")
            )
            resolved = _tool_json(
                await _tool_call(
                    client,
                    81,
                    "vault_resolve",
                    {"reference": default_reference},
                )
            )
            assert resolved == {
                "reference": default_reference,
                "value": "runtime-a-default-secret",
            }
            linked_reference = (
                f"clawdi://project/{linked_project.id}/vault/runtime-linked/field/LINKED_TOKEN"
            )
            linked_result = _tool_json(
                await _tool_call(
                    client,
                    82,
                    "vault_resolve",
                    {"reference": linked_reference},
                )
            )
            assert linked_result == {
                "reference": linked_reference,
                "value": "runtime-linked-secret",
            }

            active_auth["value"] = AuthContext(
                user=seed_user,
                api_key=ApiKey(
                    user_id=seed_user.id,
                    environment_id=env_a.id,
                    scopes=None,
                ),
            )
            legacy_projects = _tool_json(await _tool_call(client, 84, "project_list"))["projects"]
            assert [project["id"] for project in legacy_projects] == [str(env_a.default_project_id)]

            active_auth["value"] = _runtime_auth(seed_user, env_b.id)
            other_search = await _tool_call(
                client,
                9,
                "memory_search",
                {"query": "Hosted direct parity marker"},
            )
            assert "shared across the account" in other_search["content"][0]["text"]
            assert (await client.get(f"/v1/memories/{direct_memory.id}")).status_code == 200

            inaccessible_project = await _tool_call(
                client,
                10,
                "project_get",
                {"project_id": str(env_a.default_project_id)},
            )
            assert inaccessible_project["isError"] is True
            assert "Project not found" in inaccessible_project["content"][0]["text"]
            inaccessible_vault = await _tool_call(
                client,
                11,
                "vault_get",
                {
                    "project_id": str(env_a.default_project_id),
                    "vault_id": str(vault_a.id),
                },
            )
            assert inaccessible_vault["isError"] is True
            assert "Project not found" in inaccessible_vault["content"][0]["text"]
            inaccessible_secret = await _tool_call(
                client,
                83,
                "vault_resolve",
                {"reference": default_reference},
            )
            assert inaccessible_secret["isError"] is True
            assert "Project not found" in inaccessible_secret["content"][0]["text"]
            unknown_vault = await _tool_call(
                client,
                12,
                "vault_get",
                {
                    "project_id": str(env_b.default_project_id),
                    "vault_id": str(uuid.uuid4()),
                },
            )
            assert unknown_vault["isError"] is True
            assert "Vault not found" in unknown_vault["content"][0]["text"]
            unknown_project = await _tool_call(
                client,
                13,
                "project_get",
                {"project_id": str(uuid.uuid4())},
            )
            assert unknown_project["isError"] is True
            assert "Project not found" in unknown_project["content"][0]["text"]

            active_auth["value"] = AuthContext(
                user=seed_user,
                api_key=ApiKey(user_id=seed_user.id, scopes=None),
            )
            cli_listed = await _rpc(client, 14, "tools/list", {})
            cli_names = {tool["name"] for tool in cli_listed["tools"]}
            assert {"memory_search", "project_list", "vault_list", "vault_resolve"} <= cli_names
            cli_search = await _tool_call(
                client,
                15,
                "memory_search",
                {"query": "Hosted direct parity marker"},
            )
            assert "shared across the account" in cli_search["content"][0]["text"]
            assert (await client.get(f"/v1/memories/{direct_memory.id}")).status_code == 200

            active_auth["value"] = AuthContext(
                user=seed_user,
                oauth_cli=True,
                oauth_access_expires_at=datetime.now(UTC) + timedelta(minutes=5),
            )
            oauth_listed = await _rpc(client, 16, "tools/list", {})
            oauth_names = {tool["name"] for tool in oauth_listed["tools"]}
            assert {"memory_search", "project_list", "vault_list", "vault_resolve"} <= oauth_names
            oauth_projects = _tool_json(await _tool_call(client, 17, "project_list"))["projects"]
            oauth_project_ids = {project["id"] for project in oauth_projects}
            assert str(env_a.default_project_id) in oauth_project_ids
            assert str(env_b.default_project_id) in oauth_project_ids

            active_auth["value"] = _runtime_auth(seed_user, env_a.id)
            assert (await client.delete(f"/v1/memories/{direct_memory.id}")).status_code == 200
    finally:
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(get_auth, None)


@pytest.mark.asyncio
async def test_environment_bound_mem0_delete_uses_account_scope(
    db_session,
    seed_user,
    monkeypatch,
) -> None:
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="mcp-parity-mem0-delete",
        machine_name="MCP Parity Mem0 Delete",
        agent_type="openclaw",
    )
    memory_id = uuid.uuid4()

    class Mem0DeleteClient:
        def __init__(self) -> None:
            self.get_calls: list[str] = []
            self.delete_calls: list[str] = []

        def get(self, requested_memory_id: str) -> dict[str, str]:
            self.get_calls.append(requested_memory_id)
            return {"id": str(memory_id), "user_id": str(seed_user.id)}

        def delete(self, requested_memory_id: str) -> dict[str, str]:
            self.delete_calls.append(requested_memory_id)
            return {"status": "deleted"}

        def add(
            self,
            messages: list[dict[str, object]],
            *,
            filters: dict[str, object],
            metadata: dict[str, object],
        ) -> object:
            raise AssertionError((messages, filters, metadata))

        def search(
            self,
            query: str,
            *,
            filters: dict[str, object],
            top_k: int,
        ) -> object:
            raise AssertionError((query, filters, top_k))

        def get_all(
            self,
            *,
            filters: dict[str, object],
            page: int,
            page_size: int,
        ) -> object:
            raise AssertionError((filters, page, page_size))

    mem0_client = Mem0DeleteClient()

    def memory_client_factory(*, api_key: str) -> Mem0DeleteClient:
        assert api_key == "test-api-key"
        return mem0_client

    mem0_module = _FakeMem0Module("mem0")
    mem0_module.MemoryClient = memory_client_factory
    exceptions_module = _FakeMem0ExceptionsModule("mem0.exceptions")
    exceptions_module.MemoryError = RuntimeError
    exceptions_module.NetworkError = ConnectionError
    exceptions_module.RateLimitError = TimeoutError
    monkeypatch.setitem(sys.modules, "mem0", mem0_module)
    monkeypatch.setitem(sys.modules, "mem0.exceptions", exceptions_module)
    provider = Mem0Provider(api_key="test-api-key")

    async def override_session():
        yield db_session

    async def override_auth() -> AuthContext:
        return _runtime_auth(seed_user, env.id, scopes=["memories:write"])

    async def mem0_provider(_user_id: str, _db) -> Mem0Provider:
        return provider

    monkeypatch.setattr(memory_routes, "get_memory_provider", mem0_provider)
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth] = override_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.delete(f"/v1/memories/{memory_id}")
    finally:
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(get_auth, None)

    assert response.status_code == 200
    assert mem0_client.get_calls == [str(memory_id)]
    assert mem0_client.delete_calls == [str(memory_id)]


@pytest.mark.asyncio
async def test_mcp_scope_listing_strict_arguments_and_native_name_reservation(
    db_session,
    seed_user,
    monkeypatch,
) -> None:
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="mcp-parity-scopes",
        machine_name="MCP Parity Scopes",
        agent_type="openclaw",
    )
    runtime_auth = _runtime_auth(seed_user, env.id, scopes=["connectors:read"])

    async def override_session():
        yield db_session

    async def override_auth() -> AuthContext:
        return runtime_auth

    async def colliding_connectors(_auth: AuthContext) -> list[dict[str, Any]]:
        return [
            {"name": "memory_search", "inputSchema": {"type": "object"}},
            {"name": "project_get", "inputSchema": {"type": "object"}},
            {"name": "connector_safe", "inputSchema": {"type": "object"}},
        ]

    monkeypatch.setattr(mcp_bridge, "_connector_mcp_tools", colliding_connectors)
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth] = override_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            listed = await _rpc(client, 1, "tools/list", {})
            names = [tool["name"] for tool in listed["tools"]]
            assert "connector_safe" in names
            assert "memory_search" not in names
            assert "project_get" not in names
            assert "vault_list" not in names
            assert "vault_resolve" not in names

            missing_memory = await _tool_call(
                client,
                2,
                "memory_search",
                {"query": "hidden collision"},
            )
            assert missing_memory["isError"] is True
            assert "missing scope: memories:read" in missing_memory["content"][0]["text"]
            missing_project = await _tool_call(
                client,
                3,
                "project_get",
                {"project_id": str(env.default_project_id)},
            )
            assert missing_project["isError"] is True
            assert "missing scope: projects:read" in missing_project["content"][0]["text"]
            missing_vault = await _tool_call(client, 4, "vault_list")
            assert missing_vault["isError"] is True
            assert "missing scope: vault:read" in missing_vault["content"][0]["text"]
            missing_plaintext = await _tool_call(
                client,
                41,
                "vault_resolve",
                {
                    "reference": (
                        f"clawdi://project/{env.default_project_id}/vault/default/field/TOKEN"
                    )
                },
            )
            assert missing_plaintext["isError"] is True
            assert "missing scope: vault:read" in missing_plaintext["content"][0]["text"]

            runtime_auth.api_key.scopes = ["projects:read"]
            invalid = await _tool_call(
                client,
                5,
                "project_list",
                {"unexpected": True},
            )
            assert invalid["isError"] is True
            assert invalid["content"][0]["text"] == "Error: Invalid tool arguments"
    finally:
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(get_auth, None)
