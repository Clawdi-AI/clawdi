"""Vault tests — encrypt/decrypt round-trip and CLI-auth boundary.

Vault is the most security-sensitive surface in the backend: secrets are
encrypted at rest and plaintext is *only* returned to the CLI
(``require_cli_auth``). A regression here either corrupts user secrets or
leaks them to the web layer, so the coverage bar is real-exchange with the
DB instead of mocked crypto.
"""

from __future__ import annotations

import httpx
import pytest


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
async def test_vault_resolve_requires_cli_auth(client: httpx.AsyncClient):
    """Web (Clerk) auth must be rejected from /resolve — plaintext leak gate."""
    r = await client.post("/api/vault/resolve")
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
async def test_vault_same_slug_allowed_across_scopes(client, db_session, seed_user):
    """Slug uniqueness is per (user_id, scope_id, slug). Two vaults
    with the same slug in different scopes is a valid configuration
    — env A's `github` vault and env B's `github` vault are
    independent rows. Verifies the partial unique constraint
    matches what the route allows: insert two vaults with the same
    slug under two different scope_ids and confirm both persist
    without 409 at the DB layer."""
    from app.models.scope import SCOPE_KIND_ENVIRONMENT, Scope
    from app.models.vault import Vault

    scope_a = Scope(user_id=seed_user.id, name="A", slug="env-a", kind=SCOPE_KIND_ENVIRONMENT)
    scope_b = Scope(user_id=seed_user.id, name="B", slug="env-b", kind=SCOPE_KIND_ENVIRONMENT)
    db_session.add_all([scope_a, scope_b])
    await db_session.flush()

    # Same slug in two different scopes — must coexist.
    db_session.add(Vault(user_id=seed_user.id, scope_id=scope_a.id, slug="github", name="A's"))
    db_session.add(Vault(user_id=seed_user.id, scope_id=scope_b.id, slug="github", name="B's"))
    await db_session.commit()

    # JWT user can read both via the listing — listing carries
    # scope_id per row so the dashboard can disambiguate before
    # following the slug-keyed lookup.
    listing = (await client.get("/api/vault")).json()
    same_slug = [v for v in listing["items"] if v["slug"] == "github"]
    assert len(same_slug) == 2, same_slug
    listed_scopes = {v["scope_id"] for v in same_slug}
    assert listed_scopes == {str(scope_a.id), str(scope_b.id)}

    # Slug-only lookup with a duplicate across scopes MUST 409.
    # Previously the resolver silently picked the most-recently-
    # updated row, which let a dashboard mutation land in the
    # WRONG scope when a JWT user happened to hold the same slug
    # in two scopes. Refusing forces the caller to specify
    # `scope_id`.
    ambiguous = await client.get("/api/vault/github/items")
    assert ambiguous.status_code == 409, ambiguous.text
    body = ambiguous.json()["detail"]
    assert body["code"] == "ambiguous_vault_slug"
    assert set(body["scope_ids"]) == listed_scopes

    # With `scope_id` query param both vaults are reachable.
    a_resp = await client.get(f"/api/vault/github/items?scope_id={scope_a.id}")
    assert a_resp.status_code == 200, a_resp.text
    b_resp = await client.get(f"/api/vault/github/items?scope_id={scope_b.id}")
    assert b_resp.status_code == 200, b_resp.text


@pytest.mark.asyncio
async def test_vault_same_slug_blocked_within_one_scope(client):
    """Within a single scope the slug must still 409 — we only
    relaxed uniqueness across scopes, not within."""
    r = await client.post("/api/vault", json={"slug": "dup", "name": "First"})
    assert r.status_code == 200, r.text
    r2 = await client.post("/api/vault", json={"slug": "dup", "name": "Second"})
    assert r2.status_code == 409, r2.text
    body = r2.json()["detail"]
    assert body["code"] == "vault_slug_conflict"
    assert "scope_id" in body
