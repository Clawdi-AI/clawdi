"""Real stdio + HTTP + PostgreSQL flow; only the credential injector is a fixture."""

import asyncio
import json
import os
import shutil
import socket

import httpx
import pytest
import uvicorn
from fastapi import HTTPException, Request

from app.core.auth import get_auth_short_session
from app.core.database import get_session
from app.main import app
from tests.conftest import create_env_with_project
from tests.test_mcp_capability_parity import _runtime_auth


@pytest.mark.committed_db
async def test_stdio_vault_flow_without_cli(db_session, seed_user, tmp_path):
    artifact = os.environ.get("CLAWDI_MCP_TEST_ARTIFACT")
    if not artifact:
        pytest.skip("Build the standalone artifact and set CLAWDI_MCP_TEST_ARTIFACT")
    node = shutil.which("node")
    assert node
    tenant_path = "/usr/bin:/bin"
    assert shutil.which("clawdi", path=tenant_path) is None
    executable = tmp_path / "mcp.mjs"
    shutil.copyfile(artifact, executable)
    workspace = tmp_path / "workspace"
    workspace.mkdir(mode=0o700)
    (workspace / ".env").write_text("UNRELATED='keep'\n")
    agent = await create_env_with_project(
        db_session, user_id=seed_user.id, machine_id="mcp-runtime", machine_name="MCP runtime"
    )
    other = await create_env_with_project(
        db_session, user_id=seed_user.id, machine_id="mcp-other", machine_name="Other runtime"
    )
    auth = _runtime_auth(seed_user, agent.id, scopes=["vault:read", "vault:write", "projects:read"])
    seen_paths = []

    async def authenticated(request: Request):
        # Test egress authority is deliberately restricted to this exact route/header.
        seen_paths.append(request.url.path)
        if (
            request.url.path != "/v1/mcp/clawdi"
            or request.headers.get("authorization") != "Bearer fixture-placeholder"
        ):
            raise HTTPException(401)
        return auth

    async def session():
        yield db_session

    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_auth_short_session] = authenticated
    app.dependency_overrides[get_session] = session
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(app, lifespan="off", access_log=False, log_level="error")
    )
    task = asyncio.create_task(server.serve(sockets=[sock]))
    process = None
    request_id = 0

    async def start(agent_id):
        return await asyncio.create_subprocess_exec(
            node,
            str(executable),
            "--api-url",
            f"http://127.0.0.1:{port}",
            "--agent-id",
            str(agent_id),
            "--workspace",
            str(workspace),
            env={"PATH": tenant_path, "CLAWDI_MCP_AUTHORIZATION": "Bearer fixture-placeholder"},
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

    async def rpc(method, params):
        nonlocal request_id
        request_id += 1
        process.stdin.write(
            (
                json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
                + "\n"
            ).encode()
        )
        await process.stdin.drain()
        result = json.loads(await asyncio.wait_for(process.stdout.readline(), 15))
        assert "error" not in result, result
        return result["result"]

    async def tool(name, arguments, *, error=False):
        result = await rpc("tools/call", {"name": name, "arguments": arguments})
        assert bool(result.get("isError")) == error, result
        if name in ("vault_bind", "vault_pull") or error:
            assert "first-secret" not in json.dumps(result)
            assert "second-secret" not in json.dumps(result)
            assert "fresh-secret" not in json.dumps(result)
        return result if error else json.loads(result["content"][0]["text"])

    async def stop():
        process.stdin.close()
        await asyncio.wait_for(process.wait(), 10)
        assert process.returncode == 0, (await process.stderr.read()).decode()

    try:
        async with asyncio.timeout(10):
            while not server.started:
                await asyncio.sleep(0.01)
        process = await start(agent.id)
        await rpc(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "fixture", "version": "1"},
            },
        )
        listing = await rpc("tools/list", {})
        assert {"vault_bind", "vault_pull", "vault_resolve"}.issubset(
            {t["name"] for t in listing["tools"]}
        )
        vault = await tool(
            "vault_create",
            {
                "project_id": str(agent.default_project_id),
                "slug": "runtime-env",
                "name": "Runtime env",
            },
        )
        identity = {
            "project_id": str(agent.default_project_id),
            "vault_id": vault["vault"]["id"],
            "slug": "runtime-env",
        }
        created = await tool("vault_request_create", {**identity, "fields": ["TOKEN", "REMOVE"]})
        token = created["url"].split("#")[1]
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as public:
            supplied = await public.post(
                "/v1/vault/requests/supply",
                json={
                    "token": token,
                    "fields": {"TOKEN": "first-secret", "REMOVE": "second-secret"},
                },
            )
            assert supplied.status_code == 200, supplied.text
            assert "first-secret" not in supplied.text
            assert (
                await public.post("/v1/vault/requests/inspect", json={"token": token})
            ).status_code == 410
        status = await tool("vault_request_status", {"request_id": created["id"]})
        assert status["status"] == "supplied"
        source = {"project_id": identity["project_id"], "vault_id": identity["vault_id"]}
        bound = await tool("vault_bind", {**source, "path": ".env"})
        assert bound["added"] == 2
        assert (workspace / ".env").stat().st_mode & 0o777 == 0o600
        assert "TOKEN='first-secret'" in (workspace / ".env").read_text()
        await tool(
            "vault_item_upsert", {**identity, "fields": {"TOKEN": "fresh-secret", "ADDED": "new"}}
        )
        await tool("vault_item_delete", {**identity, "fields": ["REMOVE"]})
        await stop()
        process = await start(agent.id)
        pulled = await tool("vault_pull", {"path": ".env"})
        assert (pulled["added"], pulled["updated"], pulled["deleted"]) == (1, 1, 1)
        content = (workspace / ".env").read_text()
        assert "UNRELATED='keep'" in content and "REMOVE=" not in content
        assert "TOKEN='fresh-secret'" in content
        (workspace / ".env").write_text(content.replace("TOKEN='fresh-secret'", "TOKEN='local'"))
        conflict = await tool("vault_pull", {"path": ".env"}, error=True)
        assert "Local conflict" in conflict["content"][0]["text"]
        before = (workspace / ".env").read_bytes()
        for path in ("../escape.env", str(tmp_path / "escape.env"), ".env/../escape.env"):
            await tool("vault_bind", {**source, "path": path}, error=True)
        outside = tmp_path / "outside"
        outside.write_text("unchanged")
        (workspace / "linked.env").symlink_to(outside)
        await tool("vault_bind", {**source, "path": "linked.env"}, error=True)
        assert outside.read_text() == "unchanged"
        await tool(
            "vault_bind",
            {**source, "project_id": str(other.default_project_id), "path": "other.env"},
            error=True,
        )
        await stop()
        process = await start(other.id)
        await tool("vault_bind", {**source, "path": "other.env"}, error=True)
        assert not (workspace / "other.env").exists()
        assert (workspace / ".env").read_bytes() == before
        assert set(seen_paths) == {"/v1/mcp/clawdi"}
        await stop()
        process = None
    finally:
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        server.should_exit = True
        await asyncio.wait_for(task, 10)
        sock.close()
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
