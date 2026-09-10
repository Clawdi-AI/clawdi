import asyncio
import hashlib
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.auth import AuthContext
from app.models.vault import Vault, VaultItem, VaultProjectAttachment, VaultSecretRequest
from app.routes.mcp_bridge import _tool_vault_request_create, _tool_vault_request_status
from app.schemas.vault_requests import VaultSecretRequestSupply
from app.services.vault_requests import owned_request, supply


async def make_request(client, *, fields=None):
    vault = (await client.post("/v1/vault", json={"slug": "requested", "name": "Requested"})).json()
    detail = (
        await client.get("/v1/vault/detail", params={"slug": "requested", "vault_id": vault["id"]})
    ).json()
    body = {
        "slug": "requested",
        "vault_id": vault["id"],
        "project_id": detail["project_ids"][0],
        "fields": fields or ["API_KEY", "API_SECRET"],
    }
    response = await client.post("/v1/vault/requests", json=body)
    assert response.status_code == 200, response.text
    return body, response.json()


@pytest.mark.asyncio
async def test_capability_atomic_fields_replay_and_plaintext_boundary(cli_client, db_session):
    body, created = await make_request(cli_client)
    token = created["url"].split("#")[1]
    row = await db_session.get(VaultSecretRequest, uuid.UUID(created["id"]))
    assert row.token_hash == hashlib.sha256(token.encode()).hexdigest()
    assert token not in row.token_hash
    assert (await cli_client.get("/v1/vault/requested/items")).json() == {}
    assert (await cli_client.post("/v1/vault/requests", json=body)).status_code == 409
    for prefix in ("/v1", "/api"):
        inspected = await cli_client.post(f"{prefix}/vault/requests/inspect", json={"token": token})
        assert inspected.status_code == 200
        assert inspected.json()["status"] == "pending"
        assert inspected.headers["cache-control"] == "no-store"
    invalid = await cli_client.post(
        "/v1/vault/requests/supply",
        json={"token": token, "fields": {"OTHER": "not-for-this-vault"}},
    )
    assert invalid.status_code == 422
    assert (await cli_client.get("/v1/vault/requested/items")).json() == {}
    values = {"API_KEY": "test-secret", "API_SECRET": "line1\nline2"}
    supplied = await cli_client.post(
        "/v1/vault/requests/supply", json={"token": token, "fields": values}
    )
    assert supplied.status_code == 200, supplied.text
    assert supplied.json()["status"] == "supplied"
    assert "test-secret" not in supplied.text
    for action in ("inspect", "supply"):
        payload = {"token": token, **({"fields": values} if action == "supply" else {})}
        assert (
            await cli_client.post(f"/v1/vault/requests/{action}", json=payload)
        ).status_code == 410
    assert (await cli_client.post("/v1/vault/requests", json=body)).status_code == 409
    material = await cli_client.post(
        "/v1/vault/material", json={"vault_id": body["vault_id"], "project_id": body["project_id"]}
    )
    assert material.status_code == 200, material.text
    assert material.json()["values"] == values
    assert set(material.json()["item_ids"]) == set(values)
    assert material.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_expired_invalid_detached_and_intervening_write(client, db_session):
    body, created = await make_request(client, fields=["TOKEN"])
    token = created["url"].split("#")[1]
    invalid = await client.post("/v1/vault/requests/inspect", json={"token": "a" * 43})
    assert invalid.status_code == 410
    row = await db_session.get(VaultSecretRequest, uuid.UUID(created["id"]))
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db_session.commit()
    assert (
        await client.post("/v1/vault/requests/inspect", json={"token": token})
    ).status_code == 410
    row.expires_at = datetime.now(UTC) + timedelta(hours=1)
    await db_session.commit()
    await client.put("/v1/vault/requested/items", json={"fields": {"TOKEN": "operator-value"}})
    response = await client.post(
        "/v1/vault/requests/supply", json={"token": token, "fields": {"TOKEN": "wrong"}}
    )
    assert response.status_code == 410
    assert (await client.get(f"/v1/vault/requests/{row.id}")).json()["status"] == "conflict"
    assert row.supplied_at is None
    assert (
        await client.post(
            "/v1/vault/material",
            json={"vault_id": body["vault_id"], "project_id": body["project_id"]},
        )
    ).status_code == 403
    await db_session.execute(
        delete(VaultProjectAttachment).where(VaultProjectAttachment.vault_id == row.vault_id)
    )
    await db_session.commit()
    assert (
        await client.post("/v1/vault/requests/inspect", json={"token": token})
    ).status_code == 410


@pytest.mark.asyncio
async def test_scope_mcp_status_and_validation(client, db_session, seed_user):
    body, created = await make_request(client, fields=["TOKEN"])
    row_id = uuid.UUID(created["id"])
    from app.models.user import User

    outsider = User(id=uuid.uuid4(), clerk_id="outsider", email="outsider@example.test")
    with pytest.raises(HTTPException) as exc:
        await owned_request(db_session, AuthContext(user=outsider), row_id)
    assert exc.value.status_code == 404
    forged = {**body, "project_id": str(uuid.uuid4()), "fields": ["OTHER"]}
    with pytest.raises(HTTPException) as exc:
        await _tool_vault_request_create(forged, auth=AuthContext(user=seed_user), db=db_session)
    assert exc.value.status_code == 404
    result = await _tool_vault_request_status(
        {"request_id": created["id"]}, auth=AuthContext(user=seed_user), db=db_session
    )
    assert "pending" in str(result)
    assert created["url"] not in str(result)
    bad = await client.post(
        "/v1/vault/requests/supply",
        json={"token": created["url"].split("#")[1], "fields": {"TOKEN": "\0private-input"}},
    )
    assert bad.status_code == 422
    assert "private-input" not in bad.text


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_concurrent_redemption_commits_exactly_once(cli_client, db_session, engine):
    _, created = await make_request(cli_client)
    token = created["url"].split("#")[1]
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)

    async def redeem(value):
        async with sessionmaker() as session:
            try:
                await supply(
                    session,
                    VaultSecretRequestSupply(
                        token=token, fields={"API_KEY": value, "API_SECRET": value}
                    ),
                )
                return 200
            except HTTPException as exc:
                return exc.status_code

    assert sorted(await asyncio.gather(redeem("first"), redeem("second"))) == [200, 410]
    request_id = uuid.UUID(created["id"])
    row = await db_session.get(VaultSecretRequest, request_id)
    assert row.supplied_at is not None
    assert (
        len(
            (
                await db_session.scalars(
                    select(VaultItem).where(VaultItem.vault_id == row.vault_id)
                )
            ).all()
        )
        == 2
    )
    # Vault ownership has no User FK; clean up this committed test's Vault explicitly.
    await db_session.execute(delete(Vault).where(Vault.id == row.vault_id))
    await db_session.commit()


@pytest.mark.asyncio
async def test_vault_materialization_sections_additions_and_deletions(cli_client):
    body, _ = await make_request(cli_client, fields=["PENDING"])
    for section in ("one", "two"):
        await cli_client.put(
            "/v1/vault/requested/items", json={"section": section, "fields": {"TOKEN": section}}
        )
    target = {"vault_id": body["vault_id"], "project_id": body["project_id"]}
    assert (await cli_client.post("/v1/vault/material", json=target)).status_code == 409
    material = (
        await cli_client.post("/v1/vault/material", json={**target, "section": "one"})
    ).json()
    assert material["values"] == {"TOKEN": "one"}
    await cli_client.put(
        "/v1/vault/requested/items", json={"section": "one", "fields": {"ADDED": "new"}}
    )
    await cli_client.request(
        "DELETE", "/v1/vault/requested/items", json={"section": "one", "fields": ["TOKEN"]}
    )
    assert (await cli_client.post("/v1/vault/material", json={**target, "section": "one"})).json()[
        "values"
    ] == {"ADDED": "new"}


@pytest.mark.asyncio
async def test_runtime_request_tools_require_scope_and_bound_project(db_session, seed_user):
    from app.models.api_key import ApiKey
    from app.routes.mcp_bridge import _call_clawdi_mcp_tool
    from app.schemas.vault import VaultCreate
    from app.services.vault import create_account_vault
    from tests.conftest import create_env_with_project

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="request-runtime",
        machine_name="Request runtime",
    )
    auth = AuthContext(
        user=seed_user,
        api_key=ApiKey(
            user_id=seed_user.id,
            key_hash="request-test",
            key_prefix="request-test",
            environment_id=env.id,
            scopes=["vault:write", "vault:read"],
        ),
        api_key_project_id=env.default_project_id,
    )
    vault = await create_account_vault(
        db_session,
        AuthContext(user=seed_user),
        VaultCreate(slug="runtime-request", name="Runtime request"),
        project_id=env.default_project_id,
        create_only=True,
    )
    arguments = {
        "slug": vault.slug,
        "vault_id": str(vault.id),
        "project_id": str(env.default_project_id),
        "fields": ["TOKEN"],
    }
    # Use the MCP dispatch boundary, including its advertised capability scope gates.
    result = await _call_clawdi_mcp_tool(
        "vault_request_create", arguments, auth=auth, db=db_session
    )
    assert "vault-request#" in str(result)
    with pytest.raises(HTTPException) as exc:
        await _call_clawdi_mcp_tool(
            "vault_request_create",
            {**arguments, "project_id": str(uuid.uuid4())},
            auth=auth,
            db=db_session,
        )
    assert exc.value.status_code == 404
    auth.api_key.scopes = ["vault:read"]
    with pytest.raises(HTTPException) as exc:
        await _call_clawdi_mcp_tool(
            "vault_request_create", {**arguments, "fields": ["OTHER"]}, auth=auth, db=db_session
        )
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_requests_slug_keeps_existing_vault_item_routes(cli_client):
    await cli_client.post("/v1/vault", json={"slug": "requests", "name": "Requests"})
    await cli_client.put("/v1/vault/requests/items", json={"fields": {"TOKEN": "fixture"}})
    for prefix in ("/v1", "/api"):
        response = await cli_client.get(f"{prefix}/vault/requests/items")
        assert response.status_code == 200, response.text
        assert response.json() == {"(default)": ["TOKEN"]}
