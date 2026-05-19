"""Vault tests — encrypt/decrypt round-trip and CLI-auth boundary.

Vault is the most security-sensitive surface in the backend: secrets are
encrypted at rest and plaintext is *only* returned to the CLI
(``require_cli_auth``). A regression here either corrupts user secrets or
leaks them to the web layer, so the coverage bar is real-exchange with the
DB instead of mocked crypto.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.main import app
from app.models.api_key import ApiKey
from app.models.vault import Vault


@pytest.mark.asyncio
async def test_vault_create_list_and_slug_conflict(client: httpx.AsyncClient):
    r = await client.post("/api/vault", json={"slug": "prod", "name": "Production"})
    assert r.status_code == 200, r.text
    assert r.json()["slug"] == "prod"

    # Conflicting slug under same user must 409, not silently overwrite.
    r2 = await client.post("/api/vault", json={"slug": "prod", "name": "Again"})
    assert r2.status_code == 409, r2.text

    listing = (await client.get("/api/vault")).json()
    assert any(v["slug"] == "prod" for v in listing["items"])


@pytest.mark.asyncio
async def test_vault_upsert_encrypts_and_resolve_decrypts(cli_client: httpx.AsyncClient):
    """Secrets round-trip through AES-GCM storage.

    Write ciphertext via the vault endpoints, then decrypt it back via
    ``/resolve``. ``cli_client`` satisfies both ``get_auth`` (for the
    upsert) and ``require_cli_auth`` (for /resolve), so we use one client
    for the whole flow — pytest fixtures share
    ``app.dependency_overrides`` so mixing ``client`` + ``cli_client`` in
    one test is unsafe.
    """
    await cli_client.post("/api/vault", json={"slug": "prod", "name": "Production"})
    r = await cli_client.put(
        "/api/vault/prod/items",
        json={"section": "openai", "fields": {"api_key": "sk-live-xyz"}},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "ok", "fields": 1}

    # Listing returns field *names* only — plaintext is never exposed here.
    sections = (await cli_client.get("/api/vault/prod/items")).json()
    assert sections == {"openai": ["api_key"]}

    resolved = (await cli_client.post("/api/vault/resolve")).json()
    assert resolved.get("OPENAI_API_KEY") == "sk-live-xyz"


@pytest.mark.asyncio
async def test_vault_resolve_exact_clawdi_reference(cli_client: httpx.AsyncClient):
    await cli_client.post("/api/vault", json={"slug": "prod", "name": "Production"})
    r = await cli_client.put(
        "/api/vault/prod/items",
        json={"section": "database", "fields": {"url": "postgres://secret"}},
    )
    assert r.status_code == 200, r.text

    resolved = await cli_client.post(
        "/api/vault/resolve?vault_slug=prod&section=database&field=url&debug=true"
    )
    assert resolved.status_code == 200, resolved.text
    body = resolved.json()
    assert body["reference"] == "clawdi://prod/database/url"
    assert body["value"] == "postgres://secret"
    assert body["vault_slug"] == "prod"
    assert body["section"] == "database"
    assert body["item_name"] == "url"
    assert body["precedence"][0]["reason"] == "match"


@pytest.mark.asyncio
async def test_vault_resolve_requires_cli_auth(client: httpx.AsyncClient):
    """Web (Clerk) auth must be rejected from /resolve — plaintext leak gate."""
    r = await client.post("/api/vault/resolve")
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_vault_credential_profile_round_trip_and_not_env_injected(
    cli_client: httpx.AsyncClient,
):
    payload = '{"kind":"local_agent_profile","files":[{"logicalName":"auth.json"}]}'
    stored = await cli_client.post(
        "/api/vault/credential-profiles",
        json={"tool": "codex", "profile": "default", "payload": payload},
    )
    assert stored.status_code == 200, stored.text
    assert stored.json()["tool"] == "codex"

    resolved = await cli_client.post(
        "/api/vault/credential-profiles/resolve",
        json={"tool": "codex", "profile": "default"},
    )
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["payload"] == payload

    # Credential profiles are not vault_items and must never be included in
    # legacy all-env injection.
    env = (await cli_client.post("/api/vault/resolve")).json()
    assert "CODEX_DEFAULT" not in env


@pytest.mark.asyncio
async def test_vault_credential_profile_resolve_requires_cli_auth(client: httpx.AsyncClient):
    r = await client.post(
        "/api/vault/credential-profiles/resolve",
        json={"tool": "codex", "profile": "default"},
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_vault_delete_cascades_items(cli_client: httpx.AsyncClient):
    await cli_client.post("/api/vault", json={"slug": "temp", "name": "Temp"})
    await cli_client.put(
        "/api/vault/temp/items",
        json={"section": "aws", "fields": {"access_key": "AKIAxxx"}},
    )

    r = await cli_client.delete("/api/vault/temp")
    assert r.status_code == 200, r.text

    # After vault deletion, resolve must not surface that item anymore.
    resolved = (await cli_client.post("/api/vault/resolve")).json()
    assert "AWS_ACCESS_KEY" not in resolved


@pytest.mark.asyncio
async def test_env_bound_key_cannot_mutate_other_owned_project_vault(db_session, seed_user):
    from tests.conftest import create_env_with_project

    env_a = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="vault-env-a",
        machine_name="Vault Env A",
    )
    env_b = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="vault-env-b",
        machine_name="Vault Env B",
    )
    vault_a = Vault(
        user_id=seed_user.id,
        project_id=env_a.default_project_id,
        slug="shared",
        name="A",
    )
    vault_b = Vault(
        user_id=seed_user.id,
        project_id=env_b.default_project_id,
        slug="shared",
        name="B",
    )
    db_session.add_all([vault_a, vault_b])
    await db_session.commit()

    key = ApiKey(
        user_id=seed_user.id,
        key_hash=uuid.uuid4().hex,
        key_prefix="clawdi_test",
        label="env-a",
        scopes=None,
        environment_id=env_a.id,
    )

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=key)

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            blocked = await ac.delete(f"/api/vault/shared?project_id={env_b.default_project_id}")
            assert blocked.status_code == 404, blocked.text

            own = await ac.delete(f"/api/vault/shared?project_id={env_a.default_project_id}")
            assert own.status_code == 200, own.text
    finally:
        app.dependency_overrides.clear()

    remaining = (
        await db_session.execute(select(Vault).where(Vault.project_id == env_b.default_project_id))
    ).scalar_one_or_none()
    assert remaining is not None


@pytest.mark.asyncio
async def test_vault_same_slug_allowed_across_projects(client, db_session, seed_user):
    """Slug uniqueness is per (user_id, project_id, slug). Two vaults
    with the same slug in different projects is a valid configuration
    — env A's `github` vault and env B's `github` vault are
    independent rows. Verifies the partial unique constraint
    matches what the route allows: insert two vaults with the same
    slug under two different project_ids and confirm both persist
    without 409 at the DB layer."""
    from app.models.project import PROJECT_KIND_ENVIRONMENT, Project
    from app.models.vault import Vault

    project_a = Project(user_id=seed_user.id, name="A", slug="env-a", kind=PROJECT_KIND_ENVIRONMENT)
    project_b = Project(user_id=seed_user.id, name="B", slug="env-b", kind=PROJECT_KIND_ENVIRONMENT)
    db_session.add_all([project_a, project_b])
    await db_session.flush()

    # Same slug in two different projects — must coexist.
    db_session.add(Vault(user_id=seed_user.id, project_id=project_a.id, slug="github", name="A's"))
    db_session.add(Vault(user_id=seed_user.id, project_id=project_b.id, slug="github", name="B's"))
    await db_session.commit()

    # JWT user can read both via the listing — listing carries
    # project_id per row so the dashboard can disambiguate before
    # following the slug-keyed lookup.
    listing = (await client.get("/api/vault")).json()
    same_slug = [v for v in listing["items"] if v["slug"] == "github"]
    assert len(same_slug) == 2, same_slug
    listed_projects = {v["project_id"] for v in same_slug}
    assert listed_projects == {str(project_a.id), str(project_b.id)}

    # Slug-only lookup with a duplicate across projects MUST 409.
    # Previously the resolver silently picked the most-recently-
    # updated row, which let a dashboard mutation land in the
    # WRONG project when a JWT user happened to hold the same slug
    # in two projects. Refusing forces the caller to specify
    # `project_id`.
    ambiguous = await client.get("/api/vault/github/items")
    assert ambiguous.status_code == 409, ambiguous.text
    body = ambiguous.json()["detail"]
    assert body["code"] == "ambiguous_vault_slug"
    assert set(body["project_ids"]) == listed_projects

    # With `project_id` query param both vaults are reachable.
    a_resp = await client.get(f"/api/vault/github/items?project_id={project_a.id}")
    assert a_resp.status_code == 200, a_resp.text
    b_resp = await client.get(f"/api/vault/github/items?project_id={project_b.id}")
    assert b_resp.status_code == 200, b_resp.text


@pytest.mark.asyncio
async def test_vault_same_slug_blocked_within_one_project(client):
    """Within a single project the slug must still 409 — we only
    relaxed uniqueness across projects, not within."""
    r = await client.post("/api/vault", json={"slug": "dup", "name": "First"})
    assert r.status_code == 200, r.text
    r2 = await client.post("/api/vault", json={"slug": "dup", "name": "Second"})
    assert r2.status_code == 409, r2.text
    body = r2.json()["detail"]
    assert body["code"] == "vault_slug_conflict"
    assert "project_id" in body
