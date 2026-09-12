import asyncio
import hashlib
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.auth import AuthContext
from app.models.vault import Vault, VaultItem, VaultProjectAttachment, VaultSecretRequest
from app.routes.mcp_bridge import _tool_vault_request_create, _tool_vault_request_status
from app.schemas.vault_requests import VaultSecretRequestSupply
from app.services.vault_requests import owned_request, supply


async def make_request(client, *, fields=None, section="", existing=None):
    vault = (await client.post("/v1/vault", json={"slug": "requested", "name": "Requested"})).json()
    detail = (
        await client.get("/v1/vault/detail", params={"slug": "requested", "vault_id": vault["id"]})
    ).json()
    body = {
        "slug": "requested",
        "vault_id": vault["id"],
        "project_id": detail["project_ids"][0],
        "fields": fields or ["API_KEY", "API_SECRET"],
        "section": section,
    }
    if existing:
        response = await client.put(
            "/v1/vault/requested/items", json={"section": section, "fields": existing}
        )
        assert response.status_code == 200, response.text
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
    assert row.field_baselines == {"API_KEY": None, "API_SECRET": None}
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
    update = await cli_client.post("/v1/vault/requests", json=body)
    assert update.status_code == 200, update.text
    assert update.json()["update_fields"] == body["fields"]
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
    invalid = await client.post("/v1/vault/requests/inspect", json={"token": "v2_" + "a" * 43})
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


@pytest.mark.asyncio
async def test_bound_request_listing_defaults_to_its_project(cli_client, db_session, seed_user):
    from app.core.auth import get_auth
    from app.main import app
    from app.models.api_key import ApiKey
    from tests.conftest import create_env_with_project

    body, other_request = await make_request(cli_client, fields=["OTHER_PROJECT_TOKEN"])
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="request-list-bound",
        machine_name="Request listing Agent",
    )
    db_session.add(
        VaultProjectAttachment(
            vault_id=uuid.UUID(body["vault_id"]),
            project_id=env.default_project_id,
        )
    )
    await db_session.commit()
    response = await cli_client.post(
        "/v1/vault/requests",
        json={
            **body,
            "project_id": str(env.default_project_id),
            "fields": ["BOUND_TOKEN"],
        },
    )
    assert response.status_code == 200, response.text
    own_request = response.json()
    query = {"slug": body["slug"], "vault_id": body["vault_id"]}
    # An unbound owner still sees both Projects on the shared Vault.
    assert {
        row["id"] for row in (await cli_client.get("/v1/vault/requests", params=query)).json()
    } == {
        other_request["id"],
        own_request["id"],
    }
    bound = AuthContext(
        user=seed_user,
        api_key=ApiKey(
            user_id=seed_user.id,
            key_hash="listing-test",
            key_prefix="listing-test",
            environment_id=env.id,
            scopes=None,
        ),
        api_key_project_id=env.default_project_id,
    )
    app.dependency_overrides[get_auth] = lambda: bound
    for prefix in ("/v1", "/api"):
        response = await cli_client.get(f"{prefix}/vault/requests", params=query)
        assert response.status_code == 200, response.text
        assert response.json() == [
            {key: value for key, value in own_request.items() if key != "url"}
        ]
        forbidden = await cli_client.get(
            f"{prefix}/vault/requests",
            params={
                **query,
                "project_id": body["project_id"],
            },
        )
        assert forbidden.status_code == 404


@pytest.mark.asyncio
async def test_mixed_request_preserves_old_values_and_exposes_only_update_names(
    cli_client, db_session, seed_user
):
    body, created = await make_request(
        cli_client, fields=["NEW", "TOKEN"], existing={"TOKEN": "old-secret"}, section="live"
    )
    token = created["url"].split("#")[1]
    row = await db_session.get(VaultSecretRequest, uuid.UUID(created["id"]))
    baseline = row.field_baselines["TOKEN"]
    assert isinstance(baseline, str)
    assert row.field_baselines["NEW"] is None
    assert created["content_version"] == 1
    target = {"vault_id": body["vault_id"], "project_id": body["project_id"], "section": "live"}
    assert (await cli_client.post("/v1/vault/material", json=target)).json()["values"] == {
        "TOKEN": "old-secret"
    }
    for response in (
        await cli_client.post("/v1/vault/requests/inspect", json={"token": token}),
        await cli_client.get(f"/v1/vault/requests/{created['id']}"),
    ):
        assert response.json()["update_fields"] == ["TOKEN"]
        assert baseline not in response.text and "old-secret" not in response.text
        assert "field_baselines" not in response.text
    mcp = await _tool_vault_request_status(
        {"request_id": created["id"]}, auth=AuthContext(user=seed_user), db=db_session
    )
    assert baseline not in str(mcp) and "old-secret" not in str(mcp)
    # Neither other fields in this section nor the same name in another section invalidate it.
    for section, fields in (("live", {"OTHER": "keep"}), ("other", {"TOKEN": "elsewhere"})):
        assert (
            await cli_client.put(
                "/v1/vault/requested/items", json={"section": section, "fields": fields}
            )
        ).status_code == 200
    response = await cli_client.post(
        "/api/vault/requests/supply",
        json={"token": token, "fields": {"NEW": "added", "TOKEN": "replacement"}},
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "supplied"
    assert response.json()["content_version"] == 4
    assert (await cli_client.post("/v1/vault/material", json=target)).json()["values"] == {
        "NEW": "added",
        "TOKEN": "replacement",
        "OTHER": "keep",
    }
    # Status reports current content, including writes after this request was supplied.
    await cli_client.put(
        "/v1/vault/requested/items", json={"section": "live", "fields": {"OTHER": "later"}}
    )
    assert (await cli_client.get(f"/v1/vault/requests/{created['id']}")).json()[
        "content_version"
    ] == 5


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["update", "delete", "recreate", "new", "incomplete"])
async def test_mixed_request_conflicts_atomically(cli_client, db_session, change):
    body, created = await make_request(
        cli_client, fields=["NEW", "TOKEN"], existing={"TOKEN": "old"}
    )
    row = await db_session.get(VaultSecretRequest, uuid.UUID(created["id"]))
    if change == "incomplete":
        row.field_baselines = {"TOKEN": row.field_baselines["TOKEN"]}
        await db_session.commit()
    if change in ("delete", "recreate"):
        assert (
            await cli_client.request(
                "DELETE", "/v1/vault/requested/items", json={"fields": ["TOKEN"]}
            )
        ).status_code == 200
    if change in ("update", "recreate", "new"):
        field = "NEW" if change == "new" else "TOKEN"
        # Re-encrypting even the same plaintext must invalidate the baseline.
        assert (
            await cli_client.put("/v1/vault/requested/items", json={"fields": {field: "old"}})
        ).status_code == 200
    target = {"vault_id": body["vault_id"], "project_id": body["project_id"]}
    before = (await cli_client.post("/v1/vault/material", json=target)).json()["values"]
    response = await cli_client.post(
        "/v1/vault/requests/supply",
        json={"token": created["url"].split("#")[1], "fields": {"NEW": "wrong", "TOKEN": "wrong"}},
    )
    assert response.status_code == 410, response.text
    assert (await cli_client.get(f"/v1/vault/requests/{created['id']}")).json()[
        "status"
    ] == "conflict"
    assert (await cli_client.post("/v1/vault/material", json=target)).json()["values"] == before
    await db_session.refresh(row)
    assert row.supplied_at is None


@pytest.mark.asyncio
async def test_request_uses_normalized_vault_names_for_existing_and_new_keys(cli_client):
    body, created = await make_request(
        cli_client,
        fields=[" api-key ", "api.token", "new.key"],
        existing={"api-key": "old-key", "api.token": "old-token"},
    )
    assert created["fields"] == ["api-key", "api.token", "new.key"]
    assert created["update_fields"] == ["api-key", "api.token"]
    assert (await cli_client.post("/v1/vault/requests", json=body)).status_code == 409
    for fields in (
        ["api-key", " api-key "],
        ["unsupported/key"],
        [" "],
        ["x" * 201],
        [f"key-{index}" for index in range(33)],
    ):
        invalid = await cli_client.post("/v1/vault/requests", json={**body, "fields": fields})
        assert invalid.status_code == 422, invalid.text

    async def resolve_fields(expected):
        for field, value in expected.items():
            resolved = await cli_client.post(
                "/v1/vault/resolve",
                params={
                    "vault_slug": body["slug"],
                    "project_id": body["project_id"],
                    "field": field,
                },
            )
            assert resolved.status_code == 200, resolved.text
            assert resolved.json()["value"] == value

    await resolve_fields({"api-key": "old-key", "api.token": "old-token"})
    values = {"api-key": "new-key", "api.token": "new-token", "new.key": "new-value"}
    response = await cli_client.post(
        "/v1/vault/requests/supply",
        json={"token": created["url"].split("#")[1], "fields": values},
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "supplied"
    await resolve_fields(values)


async def wait_for_database_lock(engine, pid):
    async with engine.connect() as observer:
        async with asyncio.timeout(5):
            while not await observer.scalar(
                text("SELECT cardinality(pg_blocking_pids(:pid)) > 0"), {"pid": pid}
            ):
                await asyncio.sleep(0.01)


@pytest.mark.asyncio
@pytest.mark.committed_db
@pytest.mark.parametrize("operation", ["upsert", "delete", "copy"])
@pytest.mark.parametrize("supply_first", [False, True])
async def test_request_serializes_with_vault_mutations(
    cli_client, db_session, engine, seed_user, monkeypatch, operation, supply_first
):
    from app.routes.vault import copy_vault_items
    from app.schemas.vault import VaultItemDelete, VaultItemsCopy, VaultItemUpsert
    from app.services import vault_requests
    from app.services.vault import delete_owned_vault_items, upsert_owned_vault_items

    body, created = await make_request(
        cli_client, fields=["NEW", "TOKEN"], existing={"TOKEN": "old"}
    )
    vault_id = uuid.UUID(body["vault_id"])
    auth = AuthContext(user=seed_user)
    source_id = None
    if operation == "copy":
        source = (
            await cli_client.post("/v1/vault", json={"slug": "source", "name": "Source"})
        ).json()
        source_id = uuid.UUID(source["id"])
        await cli_client.put("/v1/vault/source/items", json={"fields": {"TOKEN": "operator"}})
    # Release the fixture connection before independent transactions contend.
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def mutate(session):
        args = {"project_id": uuid.UUID(body["project_id"]), "vault_id": vault_id}
        if operation == "upsert":
            await upsert_owned_vault_items(
                session, auth, "requested", VaultItemUpsert(fields={"TOKEN": "operator"}), **args
            )
        elif operation == "delete":
            await delete_owned_vault_items(
                session,
                auth,
                "requested",
                VaultItemDelete(fields=["TOKEN"]),
                global_delete=False,
                **args,
            )
        else:
            await copy_vault_items(
                "source",
                VaultItemsCopy(target_slug="requested", fields=["TOKEN"]),
                project_id=None,
                vault_id=source_id,
                target_vault_id=vault_id,
                auth=auth,
                db=session,
            )

    async def redeem(session):
        try:
            await supply(
                session,
                VaultSecretRequestSupply(
                    token=created["url"].split("#")[1],
                    fields={"NEW": "supplied", "TOKEN": "supplied"},
                ),
            )
            return 200
        except HTTPException as exc:
            await session.rollback()
            return exc.status_code

    tasks = []
    try:
        async with sessions() as first, sessions() as second:
            pid = await second.scalar(text("SELECT pg_backend_pid()"))
            if supply_first:
                locked, release = asyncio.Event(), asyncio.Event()
                original = vault_requests.describe

                async def hold_supply(session, row):
                    result = await original(session, row)
                    if session is first and not row.supplied_at:
                        locked.set()
                        await release.wait()
                    return result

                monkeypatch.setattr(vault_requests, "describe", hold_supply)
                winner = asyncio.create_task(redeem(first))
                tasks.append(winner)
                await asyncio.wait_for(locked.wait(), 5)
                waiter = asyncio.create_task(mutate(second))
                tasks.append(waiter)
                await wait_for_database_lock(engine, pid)
                release.set()
                assert await asyncio.wait_for(winner, 5) == 200
                await asyncio.wait_for(waiter, 5)
            else:
                await first.execute(select(Vault.id).where(Vault.id == vault_id).with_for_update())
                waiter = asyncio.create_task(redeem(second))
                tasks.append(waiter)
                await wait_for_database_lock(engine, pid)
                await mutate(first)
                assert await asyncio.wait_for(waiter, 5) == 410
        async with sessions() as check:
            row = await check.get(VaultSecretRequest, uuid.UUID(created["id"]))
            assert (row.supplied_at is not None) == supply_first
            items = (
                await check.scalars(select(VaultItem).where(VaultItem.vault_id == vault_id))
            ).all()
            from app.services.vault_crypto import decrypt

            values = {item.item_name: decrypt(item.encrypted_value, item.nonce) for item in items}
            assert values == {
                **({"TOKEN": "operator"} if operation != "delete" else {}),
                **({"NEW": "supplied"} if supply_first else {}),
            }
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await db_session.rollback()
        await db_session.execute(
            delete(Vault).where(Vault.id.in_([vault_id, *([source_id] if source_id else [])]))
        )
        await db_session.commit()


@pytest.mark.asyncio
async def test_conflicted_request_can_be_replaced_without_reviving_retired_capability(
    cli_client, db_session
):
    body, created = await make_request(cli_client, fields=["TOKEN", "NEW"])
    assert (await cli_client.post("/v1/vault/requests", json=body)).status_code == 409
    await cli_client.put("/v1/vault/requested/items", json={"fields": {"TOKEN": "operator"}})
    assert (await cli_client.get(f"/v1/vault/requests/{created['id']}")).json()[
        "status"
    ] == "conflict"
    successor = await cli_client.post("/v1/vault/requests", json=body)
    assert successor.status_code == 200, successor.text
    assert successor.json()["update_fields"] == ["TOKEN"]
    assert (await cli_client.post("/v1/vault/requests", json=body)).status_code == 409
    # Restore the predecessor's absent baseline. Neither retired link may revive.
    await cli_client.request("DELETE", "/v1/vault/requested/items", json={"fields": ["TOKEN"]})
    latest = await cli_client.post("/v1/vault/requests", json=body)
    assert latest.status_code == 200, latest.text
    assert latest.json()["update_fields"] == []
    for obsolete in (created, successor.json()):
        for action in ("inspect", "supply"):
            payload = {"token": obsolete["url"].split("#")[1]}
            if action == "supply":
                payload["fields"] = {"TOKEN": "obsolete", "NEW": "obsolete"}
            assert (
                await cli_client.post(f"/v1/vault/requests/{action}", json=payload)
            ).status_code == 410
        row = await db_session.get(
            VaultSecretRequest, uuid.UUID(obsolete["id"]), populate_existing=True
        )
        assert row.conflicted_at is not None and row.supplied_at is None
    supplied = await cli_client.post(
        "/v1/vault/requests/supply",
        json={
            "token": latest.json()["url"].split("#")[1],
            "fields": {"TOKEN": "current", "NEW": "current"},
        },
    )
    assert supplied.status_code == 200, supplied.text


@pytest.mark.asyncio
@pytest.mark.parametrize("recreate", [False, True])
async def test_baseline_detects_ciphertext_and_identity_changes(cli_client, db_session, recreate):
    _, created = await make_request(cli_client, fields=["NEW", "TOKEN"], existing={"TOKEN": "old"})
    item = await db_session.scalar(
        select(VaultItem).where(VaultItem.vault_id == uuid.UUID(created["vault_id"]))
    )
    if recreate:
        # Same ciphertext with a different row identity is still a different incarnation.
        item.id = uuid.uuid4()
    else:
        from app.services.vault_crypto import encrypt

        item.encrypted_value, item.nonce = encrypt("old")
    await db_session.commit()
    response = await cli_client.post(
        "/v1/vault/requests/supply",
        json={"token": created["url"].split("#")[1], "fields": {"TOKEN": "wrong", "NEW": "wrong"}},
    )
    assert response.status_code == 410
    assert (await cli_client.get(f"/v1/vault/requests/{created['id']}")).json()[
        "status"
    ] == "conflict"


@pytest.mark.asyncio
async def test_request_migration_expires_pending_and_requires_explicit_snapshots(engine):
    import importlib.util
    from pathlib import Path

    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = (
        Path(__file__).parents[1] / "alembic/versions/e7b4c2a9d610_vault_request_field_baselines.py"
    )
    spec = importlib.util.spec_from_file_location("request_baselines", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    extras_spec = importlib.util.spec_from_file_location(
        "request_extras", path.with_name("fa83d21c907b_vault_request_extras.py")
    )
    assert extras_spec is not None and extras_spec.loader is not None
    extras_migration = importlib.util.module_from_spec(extras_spec)
    extras_spec.loader.exec_module(extras_migration)

    def verify(connection):
        from sqlalchemy.exc import IntegrityError

        connection.execute(
            text(
                "CREATE TEMP TABLE vault_secret_requests (id integer, "
                "fields jsonb NOT NULL DEFAULT '[\"NEW\"]'::jsonb, "
                "expires_at timestamptz DEFAULT now() + interval '1 hour', "
                "supplied_at timestamptz) ON COMMIT DROP"
            )
        )
        connection.execute(text("INSERT INTO vault_secret_requests (id) VALUES (1)"))
        connection.execute(
            text("INSERT INTO vault_secret_requests (id, supplied_at) VALUES (2, now())")
        )
        saved = connection.execute(
            text("SELECT expires_at, supplied_at FROM vault_secret_requests WHERE id = 2")
        ).one()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        assert connection.execute(
            text(
                "SELECT id, field_baselines, expires_at > now() "
                "FROM vault_secret_requests ORDER BY id"
            )
        ).all() == [(1, {}, False), (2, {}, True)]
        # Inserts must provide snapshots: neither omission nor null has a fallback.
        for statement in (
            "INSERT INTO vault_secret_requests (id) VALUES (3)",
            "INSERT INTO vault_secret_requests (id, field_baselines) VALUES (3, NULL)",
        ):
            with pytest.raises(IntegrityError), connection.begin_nested():
                connection.execute(text(statement))
        connection.execute(
            text(
                "INSERT INTO vault_secret_requests (id, field_baselines) "
                "VALUES (3, CAST(:baseline AS jsonb))"
            ),
            {"baseline": '{"NEW":null}'},
        )
        assert connection.execute(
            text("SELECT expires_at > now() FROM vault_secret_requests WHERE id = 3")
        ).scalar_one()
        extras_migration.op = migration.op
        extras_migration.upgrade()
        assert connection.execute(
            text(
                "SELECT id, extra_fields, expires_at > now(), conflicted_at IS NOT NULL "
                "FROM vault_secret_requests ORDER BY id"
            )
        ).all() == [(1, [], False, True), (2, [], True, False), (3, [], False, True)]
        assert connection.execute(
            text("SELECT field_baselines FROM vault_secret_requests WHERE id = 3")
        ).scalar_one() == {"NEW": None}
        # Model requests actually created and supplied after the new upgrade.
        connection.execute(
            text(
                "INSERT INTO vault_secret_requests "
                "(id, supplied_at, field_baselines, extra_fields) "
                "VALUES (:id, CASE WHEN :supplied THEN now() END, "
                "CAST(:baseline AS jsonb), CAST(:extras AS jsonb))"
            ),
            [
                {
                    "id": 4,
                    "supplied": True,
                    "baseline": '{"NEW":null,"existing.extra":"fingerprint","UNSELECTED":"opaque"}',
                    "extras": '["existing.extra","new-key"]',
                },
                {
                    "id": 5,
                    "supplied": False,
                    "baseline": '{"NEW":null,"UNSELECTED":"opaque"}',
                    "extras": "[]",
                },
                {"id": 6, "supplied": False, "baseline": '{"NEW":null}', "extras": "[]"},
            ],
        )
        supplied_times = connection.execute(
            text("SELECT expires_at, supplied_at FROM vault_secret_requests WHERE id = 4")
        ).one()
        extras_migration.downgrade()
        history = connection.execute(
            text(
                "SELECT fields, field_baselines, expires_at, supplied_at "
                "FROM vault_secret_requests WHERE id = 4"
            )
        ).one()
        # The old service builds supplied references from fields and update badges
        # from baselines. Both retain the exact saved set, without unselected names.
        assert history.fields == ["NEW", "existing.extra", "new-key"]
        assert history.field_baselines == {
            "NEW": None,
            "existing.extra": "fingerprint",
            "new-key": None,
        }
        assert (history.expires_at, history.supplied_at) == supplied_times
        assert connection.execute(
            text(
                "SELECT id, expires_at > now(), conflicted_at IS NOT NULL "
                "FROM vault_secret_requests WHERE supplied_at IS NULL ORDER BY id"
            )
        ).all() == [(1, False, True), (3, False, True), (5, False, True), (6, False, True)]
        extras_migration.upgrade()
        assert (
            connection.execute(
                text(
                    "SELECT fields, field_baselines, expires_at, supplied_at "
                    "FROM vault_secret_requests WHERE id = 4"
                )
            ).one()
            == history
        )
        assert (
            connection.execute(
                text("SELECT extra_fields FROM vault_secret_requests WHERE id = 4")
            ).scalar_one()
            == []
        )
        extras_migration.downgrade()
        migration.downgrade()
        assert connection.execute(
            text("SELECT id, expires_at > now() FROM vault_secret_requests ORDER BY id")
        ).all() == [(1, False), (2, True), (3, False), (4, True), (5, False), (6, False)]
        assert (
            connection.execute(
                text("SELECT expires_at, supplied_at FROM vault_secret_requests WHERE id = 2")
            ).one()
            == saved
        )

    async with engine.begin() as connection:
        await connection.run_sync(verify)


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_status_refreshes_terminal_state_after_concurrent_write(
    cli_client, db_session, engine
):
    from app.services.vault_requests import describe

    _, created = await make_request(cli_client, fields=["TOKEN"])
    vault_id = uuid.UUID(created["vault_id"])
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with sessions() as reader:
            row = await reader.get(VaultSecretRequest, uuid.UUID(created["id"]))
            assert row.conflicted_at is None
            await cli_client.put(
                "/v1/vault/requested/items", json={"fields": {"TOKEN": "intervening"}}
            )
            await cli_client.request(
                "DELETE", "/v1/vault/requested/items", json={"fields": ["TOKEN"]}
            )
            assert (await describe(reader, row)).status == "conflict"
    finally:
        await db_session.rollback()
        await db_session.execute(delete(Vault).where(Vault.id == vault_id))
        await db_session.commit()


@pytest.mark.asyncio
async def test_user_extras_creation_snapshot_preview_scope_and_saved_references(
    cli_client, db_session
):
    body, created = await make_request(
        cli_client,
        fields=["REQUIRED"],
        existing={"REQUIRED": "original", "optional.key": "old", "UNRELATED": "private"},
    )
    token = created["url"].split("#")[1]
    assert (
        await cli_client.post("/v1/vault/requests", json={**body, "extra_fields": ["x"]})
    ).status_code == 422
    empty_preview = await cli_client.post(
        "/v1/vault/requests/inspect", json={"token": token, "fields": []}
    )
    assert empty_preview.json()["update_fields"] == []
    for prefix in ("/v1", "/api"):
        preview = await cli_client.post(
            f"{prefix}/vault/requests/inspect",
            json={"token": token, "fields": ["optional.key", "new-key"]},
        )
        assert preview.status_code == 200, preview.text
        assert preview.json()["update_fields"] == ["optional.key"]
        assert "UNRELATED" not in preview.text and "private" not in preview.text
        assert "baseline" not in preview.text
    await cli_client.put("/v1/vault/requested/items", json={"fields": {"UNRELATED": "changed"}})
    values = {"REQUIRED": "required", "optional.key": "replacement", "new-key": "${LITERAL}"}
    saved = await cli_client.post(
        "/v1/vault/requests/supply", json={"token": token, "fields": values}
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["fields"] == list(values)
    assert saved.json()["extra_fields"] == ["optional.key", "new-key"]
    assert set(saved.json()["references"]) == set(values)
    assert saved.json()["content_version"] > created["content_version"]
    status = await cli_client.get(f"/v1/vault/requests/{created['id']}")
    assert status.json() == saved.json()
    row = await db_session.get(VaultSecretRequest, uuid.UUID(created["id"]))
    assert row.fields == ["REQUIRED"]
    assert row.extra_fields == ["optional.key", "new-key"]
    assert (
        await cli_client.post("/v1/vault/requests/supply", json={"token": token, "fields": values})
    ).status_code == 410


@pytest.mark.asyncio
@pytest.mark.parametrize("existing", [None, {"EXTRA": "original"}])
async def test_extra_changed_since_creation_rejects_atomic_batch(cli_client, existing):
    body, created = await make_request(cli_client, fields=["REQUIRED"], existing=existing)
    token = created["url"].split("#")[1]
    await cli_client.put("/v1/vault/requested/items", json={"fields": {"EXTRA": "concurrent"}})
    for action in ("inspect", "supply"):
        fields = (
            ["EXTRA"]
            if action == "inspect"
            else {"REQUIRED": "must-not-write", "EXTRA": "must-not-write"}
        )
        response = await cli_client.post(
            f"/v1/vault/requests/{action}", json={"token": token, "fields": fields}
        )
        assert response.status_code == 409
    assert (
        await cli_client.post(
            "/v1/vault/material",
            json={"vault_id": body["vault_id"], "project_id": body["project_id"]},
        )
    ).json()["values"] == {"EXTRA": "concurrent"}
    assert (
        await cli_client.post(
            "/v1/vault/requests/supply", json={"token": token, "fields": {"REQUIRED": "ok"}}
        )
    ).status_code == 200


@pytest.mark.asyncio
async def test_extra_pending_reservation_and_name_limits(cli_client):
    body, created = await make_request(cli_client, fields=["REQUIRED"])
    token = created["url"].split("#")[1]
    reserved = await cli_client.post("/v1/vault/requests", json={**body, "fields": ["RESERVED"]})
    assert reserved.status_code == 200
    for action in ("inspect", "supply"):
        fields = ["RESERVED"] if action == "inspect" else {"REQUIRED": "x", "RESERVED": "y"}
        assert (
            await cli_client.post(
                f"/v1/vault/requests/{action}", json={"token": token, "fields": fields}
            )
        ).status_code == 409
    for fields in (
        {"REQUIRED": "x", "bad/name": "y"},
        {"REQUIRED": "x", " spaced ": "y"},
        {"REQUIRED": "x", **{f"K{i}": "x" for i in range(32)}},
    ):
        assert (
            await cli_client.post(
                "/v1/vault/requests/supply", json={"token": token, "fields": fields}
            )
        ).status_code == 422
    assert (
        await cli_client.post(
            "/v1/vault/requests/inspect", json={"token": token, "fields": ["X", "X"]}
        )
    ).status_code == 422
    assert (await cli_client.get("/v1/vault/requested/items")).json() == {}
    assert (
        await cli_client.post(
            "/v1/vault/requests/inspect",
            json={"token": token, "fields": [f"K{i}" for i in range(32)]},
        )
    ).status_code == 422
    maximum = await cli_client.post(
        "/v1/vault/requests/supply",
        json={"token": token, "fields": {"REQUIRED": "x", **{f"K{i}": "x" for i in range(31)}}},
    )
    assert maximum.status_code == 200, maximum.text
    assert len(maximum.json()["references"]) == 32


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_two_requests_racing_for_same_user_extra_commit_one_batch(
    cli_client, db_session, engine
):
    body, first = await make_request(cli_client, fields=["FIRST"])
    second = (
        await cli_client.post("/v1/vault/requests", json={**body, "fields": ["SECOND"]})
    ).json()
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def redeem(created, name):
        async with sessions() as session:
            try:
                return await supply(
                    session,
                    VaultSecretRequestSupply(
                        token=created["url"].split("#")[1],
                        fields={name: name, "shared.extra": name},
                    ),
                )
            except HTTPException as exc:
                return exc.status_code

    results = await asyncio.gather(redeem(first, "FIRST"), redeem(second, "SECOND"))
    assert sum(isinstance(result, int) and result == 409 for result in results) == 1
    items = (
        await db_session.scalars(
            select(VaultItem).where(VaultItem.vault_id == uuid.UUID(body["vault_id"]))
        )
    ).all()
    assert len(items) == 2
    assert "shared.extra" in {item.item_name for item in items}
    requests = (
        await db_session.scalars(
            select(VaultSecretRequest).where(
                VaultSecretRequest.vault_id == uuid.UUID(body["vault_id"])
            )
        )
    ).all()
    assert sum(row.supplied_at is not None for row in requests) == 1
    assert sorted(len(row.extra_fields) for row in requests) == [0, 1]
    await db_session.execute(delete(Vault).where(Vault.id == uuid.UUID(body["vault_id"])))
    await db_session.commit()


@pytest.mark.asyncio
async def test_suspended_owner_cannot_preview_or_supply_user_extras(
    cli_client, anon_client, db_session, seed_user, monkeypatch
):
    from app.core.config import settings
    from app.services.principal_lifecycle import set_clerk_principal_suspension

    issuer = "https://vault-request.clerk.example.test"
    monkeypatch.setattr(settings, "clerk_jwt_issuer", issuer)
    _, created = await make_request(cli_client, fields=["REQUIRED"])
    await set_clerk_principal_suspension(
        db_session,
        issuer=issuer,
        subject=seed_user.clerk_id,
        suspended=True,
        reason="vault-request-test",
    )
    await db_session.commit()
    token = created["url"].split("#")[1]
    for action in ("inspect", "supply"):
        fields = ["EXTRA"] if action == "inspect" else {"REQUIRED": "private", "EXTRA": "private"}
        response = await anon_client.post(
            f"/v1/vault/requests/{action}", json={"token": token, "fields": fields}
        )
        assert response.status_code == 410
        assert "private" not in response.text and "EXTRA" not in response.text
    row = await db_session.get(VaultSecretRequest, uuid.UUID(created["id"]))
    assert row.supplied_at is None and row.extra_fields == []
    assert not (
        await db_session.scalars(select(VaultItem).where(VaultItem.vault_id == row.vault_id))
    ).all()
