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
from app.models.vault import (
    Vault,
    VaultCredentialProfile,
    VaultItem,
    VaultProjectAttachment,
    VaultProjectSlugAlias,
)
from app.services.vault_crypto import encrypt as vault_crypto_encrypt


@pytest.mark.asyncio
async def test_vault_create_list_and_slug_conflict(client: httpx.AsyncClient):
    r = await client.post("/api/vault", json={"slug": "prod", "name": "Production"})
    assert r.status_code == 200, r.text
    assert r.json()["slug"] == "prod"

    # Re-creating an existing vault is idempotent and keeps one vault row.
    r2 = await client.post("/api/vault", json={"slug": "prod", "name": "Again"})
    assert r2.status_code == 200, r2.text

    listing = (await client.get("/api/vault")).json()
    matches = [v for v in listing["items"] if v["slug"] == "prod"]
    assert len(matches) == 1
    assert matches[0]["project_ids"]
    assert matches[0]["project_id"] in matches[0]["project_ids"]


@pytest.mark.asyncio
async def test_vault_rejects_invalid_slugs_and_item_names(client: httpx.AsyncClient):
    invalid_slug = await client.post("/api/vault", json={"slug": "Bad Vault", "name": "Bad"})
    assert invalid_slug.status_code == 422, invalid_slug.text

    trailing_hyphen = await client.post("/api/vault", json={"slug": "prod-", "name": "Bad"})
    assert trailing_hyphen.status_code == 422, trailing_hyphen.text

    created = await client.post("/api/vault", json={"slug": "prod", "name": "Production"})
    assert created.status_code == 200, created.text

    empty_key = await client.put(
        "/api/vault/prod/items",
        json={"section": "", "fields": {"": "secret"}},
    )
    assert empty_key.status_code == 422, empty_key.text

    bad_section = await client.put(
        "/api/vault/prod/items",
        json={"section": "api/keys", "fields": {"TOKEN": "secret"}},
    )
    assert bad_section.status_code == 422, bad_section.text

    empty_delete = await client.request(
        "DELETE",
        "/api/vault/prod/items",
        json={"section": "", "fields": []},
    )
    assert empty_delete.status_code == 422, empty_delete.text


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
async def test_vault_items_copy_between_owned_vaults(cli_client: httpx.AsyncClient):
    """The dashboard curation move: batch-copy items vault→vault.

    Values must survive the server-side decrypt/re-encrypt hop intact
    while plaintext never appears in the copy response. Missing source
    names are skipped (count reflects it); self-copy is rejected.
    """
    await cli_client.post("/api/vault", json={"slug": "grab-bag", "name": "Grab bag"})
    await cli_client.post("/api/vault", json={"slug": "phala", "name": "Phala"})
    await cli_client.put(
        "/api/vault/grab-bag/items",
        json={"section": "", "fields": {"OPENAI_API_KEY": "sk-live-xyz", "OTHER": "keep"}},
    )

    r = await cli_client.post(
        "/api/vault/grab-bag/items/copy",
        json={"target_slug": "phala", "fields": ["OPENAI_API_KEY", "NOT_THERE"]},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "ok", "copied": 1}

    # Target has the name; source is untouched (copy, not move).
    assert (await cli_client.get("/api/vault/phala/items")).json() == {
        "(default)": ["OPENAI_API_KEY"]
    }
    source_names = (await cli_client.get("/api/vault/grab-bag/items")).json()
    assert sorted(source_names["(default)"]) == ["OPENAI_API_KEY", "OTHER"]

    # The list endpoint carries per-vault key counts (names only) so the
    # dashboard can rank vaults busiest-first without N+1 item fetches.
    listing = (await cli_client.get("/api/vault")).json()
    counts = {v["slug"]: v["item_count"] for v in listing["items"]}
    assert counts["grab-bag"] == 2
    assert counts["phala"] == 1

    # The re-encrypted copy decrypts to the original plaintext. Delete
    # the source item first so resolve can only be served by the copy.
    deleted = await cli_client.request(
        "DELETE",
        "/api/vault/grab-bag/items",
        json={"section": "", "fields": ["OPENAI_API_KEY"]},
    )
    assert deleted.status_code == 200, deleted.text
    resolved = (await cli_client.post("/api/vault/resolve")).json()
    assert resolved.get("OPENAI_API_KEY") == "sk-live-xyz"

    self_copy = await cli_client.post(
        "/api/vault/grab-bag/items/copy",
        json={"target_slug": "grab-bag", "fields": ["OPENAI_API_KEY"]},
    )
    assert self_copy.status_code == 400, self_copy.text


@pytest.mark.asyncio
async def test_vault_copy_strip_prefix_renames_at_destination(
    cli_client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    """Split-by-prefix: copying `app/KEY` with strip_prefix='app/' lands
    as plain `KEY` in the destination vault, and the value survives."""
    created = await cli_client.post("/api/vault", json={"slug": "bag", "name": "Bag"})
    await cli_client.post("/api/vault", json={"slug": "app", "name": "App"})
    for name, value in [("clawdi-backend/DATABASE_URL", "postgres://x"), ("KEEP_ME", "y")]:
        ciphertext, nonce = vault_crypto_encrypt(value)
        db_session.add(
            VaultItem(
                vault_id=uuid.UUID(created.json()["id"]),
                section="",
                item_name=name,
                encrypted_value=ciphertext,
                nonce=nonce,
            )
        )
    await db_session.commit()

    r = await cli_client.post(
        "/api/vault/bag/items/copy",
        json={
            "target_slug": "app",
            "fields": ["clawdi-backend/DATABASE_URL"],
            "strip_prefix": "clawdi-backend/",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["copied"] == 1
    assert (await cli_client.get("/api/vault/app/items")).json() == {"(default)": ["DATABASE_URL"]}

    # Value round-trips under the NEW name.
    deleted = await cli_client.request(
        "DELETE",
        "/api/vault/bag/items",
        json={"section": "", "fields": ["clawdi-backend/DATABASE_URL"]},
    )
    assert deleted.status_code == 200
    resolved = (await cli_client.post("/api/vault/resolve")).json()
    assert resolved.get("DATABASE_URL") == "postgres://x"


@pytest.mark.asyncio
async def test_vault_copy_and_delete_accept_legacy_field_names(
    cli_client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    """Legacy imports left names the upsert validator now rejects (e.g.
    slash-namespaced `app/DATABASE_URL`). Copy and delete are exact
    matches against existing rows, so both must accept those names —
    otherwise they are permanently stuck in the source vault (the bug
    Marvin hit moving keys out of his 700-key default vault)."""
    created = await cli_client.post("/api/vault", json={"slug": "legacy", "name": "Legacy"})
    assert created.status_code == 200, created.text
    await cli_client.post("/api/vault", json={"slug": "tidy", "name": "Tidy"})

    legacy_name = "clawdi-backend/DATABASE_URL"
    ciphertext, nonce = vault_crypto_encrypt("postgres://legacy")
    db_session.add(
        VaultItem(
            vault_id=uuid.UUID(created.json()["id"]),
            section="",
            item_name=legacy_name,
            encrypted_value=ciphertext,
            nonce=nonce,
        )
    )
    await db_session.commit()

    copied = await cli_client.post(
        "/api/vault/legacy/items/copy",
        json={"target_slug": "tidy", "fields": [legacy_name]},
    )
    assert copied.status_code == 200, copied.text
    assert copied.json() == {"status": "ok", "copied": 1}
    assert (await cli_client.get("/api/vault/tidy/items")).json() == {"(default)": [legacy_name]}

    deleted = await cli_client.request(
        "DELETE",
        "/api/vault/legacy/items",
        json={"section": "", "fields": [legacy_name]},
    )
    assert deleted.status_code == 200, deleted.text
    assert (await cli_client.get("/api/vault/legacy/items")).json() == {}


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
async def test_vault_resolve_exact_reference_accepts_legacy_project_slug_alias(
    cli_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_project,
):
    created = await cli_client.post(
        f"/api/vault?project_id={seed_project.id}",
        json={"slug": "prod-legacy123", "name": "Production"},
    )
    assert created.status_code == 200, created.text
    r = await cli_client.put(
        f"/api/vault/prod-legacy123/items?project_id={seed_project.id}",
        json={"section": "database", "fields": {"url": "postgres://legacy-secret"}},
    )
    assert r.status_code == 200, r.text

    db_session.add(
        VaultProjectSlugAlias(
            vault_id=uuid.UUID(created.json()["id"]),
            project_id=seed_project.id,
            slug="prod",
        )
    )
    await db_session.commit()

    alias_items = await cli_client.get(f"/api/vault/prod/items?project_id={seed_project.id}")
    assert alias_items.status_code == 200, alias_items.text
    assert alias_items.json() == {"database": ["url"]}

    alias_write = await cli_client.put(
        f"/api/vault/prod/items?project_id={seed_project.id}",
        json={"section": "database", "fields": {"user": "legacy-user"}},
    )
    assert alias_write.status_code == 200, alias_write.text

    resolved = await cli_client.post(
        f"/api/vault/resolve?project_id={seed_project.id}"
        "&vault_slug=prod&section=database&field=url&debug=true"
    )
    assert resolved.status_code == 200, resolved.text
    body = resolved.json()
    assert body["value"] == "postgres://legacy-secret"
    assert body["vault_slug"] == "prod-legacy123"
    assert body["precedence"][0]["reason"] == "match"

    resolved_user = await cli_client.post(
        f"/api/vault/resolve?project_id={seed_project.id}"
        "&vault_slug=prod&section=database&field=user"
    )
    assert resolved_user.status_code == 200, resolved_user.text
    assert resolved_user.json()["value"] == "legacy-user"


@pytest.mark.asyncio
async def test_vault_resolve_bulk_exact_clawdi_references(cli_client: httpx.AsyncClient):
    await cli_client.post("/api/vault", json={"slug": "prod", "name": "Production"})
    r = await cli_client.put(
        "/api/vault/prod/items",
        json={
            "section": "openai",
            "fields": {"api_key": "sk-live-xyz", "org_id": "org-secret"},
        },
    )
    assert r.status_code == 200, r.text

    resolved = await cli_client.post(
        "/api/vault/resolve/bulk",
        json={
            "references": [
                {
                    "reference": "clawdi://prod/openai/api_key",
                    "vault_slug": "prod",
                    "section": "openai",
                    "field": "api_key",
                },
                {
                    "reference": "clawdi://prod/openai/org_id",
                    "vault_slug": "prod",
                    "section": "openai",
                    "field": "org_id",
                },
            ],
            "debug": True,
        },
    )
    assert resolved.status_code == 200, resolved.text
    results = resolved.json()["results"]
    assert results["clawdi://prod/openai/api_key"]["value"] == "sk-live-xyz"
    assert results["clawdi://prod/openai/org_id"]["value"] == "org-secret"
    assert results["clawdi://prod/openai/api_key"]["precedence"][0]["reason"] == "match"


@pytest.mark.asyncio
async def test_vault_resolve_bulk_preview_omits_plaintext(cli_client: httpx.AsyncClient):
    await cli_client.post("/api/vault", json={"slug": "prod", "name": "Production"})
    r = await cli_client.put(
        "/api/vault/prod/items",
        json={"section": "database", "fields": {"url": "postgres://secret"}},
    )
    assert r.status_code == 200, r.text

    resolved = await cli_client.post(
        "/api/vault/resolve/bulk",
        json={
            "references": [
                {
                    "reference": "clawdi://prod/database/url",
                    "vault_slug": "prod",
                    "section": "database",
                    "field": "url",
                }
            ],
            "preview": True,
        },
    )
    assert resolved.status_code == 200, resolved.text
    result = resolved.json()["results"]["clawdi://prod/database/url"]
    assert result["vault_slug"] == "prod"
    assert "value" not in result
    assert "postgres://secret" not in resolved.text


@pytest.mark.asyncio
async def test_vault_resolve_preview_omits_plaintext(cli_client: httpx.AsyncClient):
    await cli_client.post("/api/vault", json={"slug": "prod", "name": "Production"})
    r = await cli_client.put(
        "/api/vault/prod/items",
        json={"section": "database", "fields": {"url": "postgres://secret"}},
    )
    assert r.status_code == 200, r.text

    resolved = await cli_client.post(
        "/api/vault/resolve?vault_slug=prod&section=database&field=url&preview=true&debug=true"
    )
    assert resolved.status_code == 200, resolved.text
    body = resolved.json()
    assert body["reference"] == "clawdi://prod/database/url"
    assert body["source_alias"]
    assert body["vault_slug"] == "prod"
    assert body["section"] == "database"
    assert body["item_name"] == "url"
    assert "value" not in body
    assert "postgres://secret" not in resolved.text


@pytest.mark.asyncio
async def test_vault_resolve_preview_rejects_legacy_all_env(
    cli_client: httpx.AsyncClient,
):
    """`preview=true` is a provenance-only contract, not all-env decrypt."""
    await cli_client.post("/api/vault", json={"slug": "prod", "name": "Production"})
    r = await cli_client.put(
        "/api/vault/prod/items",
        json={"section": "", "fields": {"OPENAI_API_KEY": "sk-preview-secret"}},
    )
    assert r.status_code == 200, r.text

    resolved = await cli_client.post("/api/vault/resolve?preview=true")
    assert resolved.status_code == 400, resolved.text
    assert "sk-preview-secret" not in resolved.text


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
async def test_vault_credential_profile_defaults_to_personal_project(
    cli_client: httpx.AsyncClient,
    db_session,
    seed_user,
    seed_project,
):
    from tests.conftest import create_env_with_project

    await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"credential-default-{uuid.uuid4().hex[:8]}",
        machine_name="Credential Default Env",
    )

    stored = await cli_client.post(
        "/api/vault/credential-profiles",
        json={"tool": "codex", "profile": "default", "payload": "{}"},
    )
    assert stored.status_code == 200, stored.text
    assert stored.json()["project_id"] == str(seed_project.id)

    profile = (
        await db_session.execute(
            select(VaultCredentialProfile).where(
                VaultCredentialProfile.tool == "codex",
                VaultCredentialProfile.profile == "default",
            )
        )
    ).scalar_one()
    assert profile.project_id == seed_project.id


@pytest.mark.asyncio
async def test_vault_credential_profile_shared_project_viewer_cannot_resolve(
    cli_client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    from datetime import UTC, datetime

    from app.models.project import PROJECT_KIND_WORKSPACE, Project
    from app.models.project_membership import ProjectMembership
    from app.models.user import User
    from app.services.vault_crypto import encrypt

    nonce = uuid.uuid4().hex[:8]
    owner = User(
        clerk_id=f"credential_owner_{nonce}",
        email=f"credential_owner_{nonce}@test.dev",
        name="Credential Owner",
    )
    db_session.add(owner)
    await db_session.flush()
    shared = Project(
        user_id=owner.id,
        name="shared credential boundary",
        slug=f"shared-credential-{nonce}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(shared)
    await db_session.flush()
    db_session.add(
        ProjectMembership(
            project_id=shared.id,
            member_user_id=seed_user.id,
            role="viewer",
            joined_via="link",
            joined_at=datetime.now(UTC),
            resolved_owner_handle=f"credential-owner-{nonce}",
        )
    )
    ciphertext, nonce_bytes = encrypt('{"kind":"local_agent_profile","files":[]}')
    db_session.add(
        VaultCredentialProfile(
            user_id=owner.id,
            project_id=shared.id,
            tool="codex",
            profile="default",
            encrypted_payload=ciphertext,
            nonce=nonce_bytes,
        )
    )
    await db_session.commit()

    try:
        resolved = await cli_client.post(
            "/api/vault/credential-profiles/resolve",
            json={"tool": "codex", "profile": "default", "project_id": str(shared.id)},
        )
        assert resolved.status_code == 404, resolved.text
    finally:
        await db_session.delete(shared)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_vault_credential_profile_shared_project_viewer_cannot_store(
    cli_client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    from datetime import UTC, datetime

    from app.models.project import PROJECT_KIND_WORKSPACE, Project
    from app.models.project_membership import ProjectMembership
    from app.models.user import User
    from app.services.vault_crypto import encrypt

    nonce = uuid.uuid4().hex[:8]
    owner = User(
        clerk_id=f"credential_unique_owner_{nonce}",
        email=f"credential_unique_owner_{nonce}@test.dev",
        name="Credential Unique Owner",
    )
    db_session.add(owner)
    await db_session.flush()
    shared = Project(
        user_id=owner.id,
        name="shared credential uniqueness",
        slug=f"shared-credential-unique-{nonce}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(shared)
    await db_session.flush()
    db_session.add(
        ProjectMembership(
            project_id=shared.id,
            member_user_id=seed_user.id,
            role="viewer",
            joined_via="link",
            joined_at=datetime.now(UTC),
            resolved_owner_handle=f"credential-unique-owner-{nonce}",
        )
    )
    ciphertext, nonce_bytes = encrypt('{"kind":"local_agent_profile","files":[]}')
    db_session.add(
        VaultCredentialProfile(
            user_id=owner.id,
            project_id=shared.id,
            tool="codex",
            profile="default",
            encrypted_payload=ciphertext,
            nonce=nonce_bytes,
        )
    )
    await db_session.commit()

    try:
        stored = await cli_client.post(
            "/api/vault/credential-profiles",
            params={"project_id": str(shared.id)},
            json={"tool": "codex", "profile": "default", "payload": "{}"},
        )
        assert stored.status_code == 404, stored.text

        profiles_result = await db_session.execute(
            select(VaultCredentialProfile).where(
                VaultCredentialProfile.project_id == shared.id,
                VaultCredentialProfile.tool == "codex",
                VaultCredentialProfile.profile == "default",
            )
        )
        profiles = profiles_result.scalars().all()
        assert {profile.user_id for profile in profiles} == {owner.id}
    finally:
        await db_session.delete(shared)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_vault_credential_profile_resolve_requires_cli_auth(client: httpx.AsyncClient):
    r = await client.post(
        "/api/vault/credential-profiles/resolve",
        json={"tool": "codex", "profile": "default"},
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_vault_credential_profile_rejects_env_bound_agent_key(db_session, seed_user):
    from tests.conftest import create_env_with_project

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"credential-bound-{uuid.uuid4().hex[:8]}",
        machine_name="Credential Bound Agent",
    )
    key = ApiKey(
        user_id=seed_user.id,
        key_hash=uuid.uuid4().hex,
        key_prefix="clawdi_test",
        label="env-bound",
        scopes=None,
        environment_id=env.id,
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
            stored = await ac.post(
                "/api/vault/credential-profiles",
                json={"tool": "codex", "profile": "default", "payload": "{}"},
            )
            assert stored.status_code == 403, stored.text

            resolved = await ac.post(
                "/api/vault/credential-profiles/resolve",
                json={"tool": "codex", "profile": "default"},
            )
            assert resolved.status_code == 403, resolved.text
    finally:
        app.dependency_overrides.clear()


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
        slug="shared-a",
        name="A",
    )
    vault_b = Vault(
        user_id=seed_user.id,
        slug="shared-b",
        name="B",
    )
    db_session.add_all([vault_a, vault_b])
    await db_session.flush()
    db_session.add_all(
        [
            VaultProjectAttachment(vault_id=vault_a.id, project_id=env_a.default_project_id),
            VaultProjectAttachment(vault_id=vault_b.id, project_id=env_b.default_project_id),
        ]
    )
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
            blocked = await ac.delete(f"/api/vault/shared-b?project_id={env_b.default_project_id}")
            assert blocked.status_code == 404, blocked.text

            own = await ac.delete(f"/api/vault/shared-a?project_id={env_a.default_project_id}")
            assert own.status_code == 200, own.text
    finally:
        app.dependency_overrides.clear()

    remaining = (
        await db_session.execute(
            select(VaultProjectAttachment).where(
                VaultProjectAttachment.project_id == env_b.default_project_id
            )
        )
    ).scalar_one_or_none()
    assert remaining is not None


@pytest.mark.asyncio
async def test_vault_attaches_one_vault_to_multiple_projects(client, db_session, seed_user):
    """A vault is account-owned. Projects attach to that one vault,
    and key rows remain under the vault instead of being duplicated
    per Project."""
    from app.models.project import PROJECT_KIND_ENVIRONMENT, Project

    project_a = Project(user_id=seed_user.id, name="A", slug="env-a", kind=PROJECT_KIND_ENVIRONMENT)
    project_b = Project(user_id=seed_user.id, name="B", slug="env-b", kind=PROJECT_KIND_ENVIRONMENT)
    db_session.add_all([project_a, project_b])
    await db_session.commit()

    first = await client.post(
        f"/api/vault?project_id={project_a.id}",
        json={"slug": "github", "name": "GitHub"},
    )
    assert first.status_code == 200, first.text
    second = await client.post(
        f"/api/vault?project_id={project_b.id}",
        json={"slug": "github", "name": "GitHub"},
    )
    assert second.status_code == 200, second.text
    assert second.json()["id"] == first.json()["id"]
    other = await client.post(
        f"/api/vault?project_id={project_b.id}",
        json={"slug": "figma", "name": "Figma"},
    )
    assert other.status_code == 200, other.text

    listing = (await client.get("/api/vault")).json()
    [github] = [v for v in listing["items"] if v["slug"] == "github"]
    assert set(github["project_ids"]) == {str(project_a.id), str(project_b.id)}
    assert github["project_id"] in github["project_ids"]
    filtered_a = (await client.get(f"/api/vault?project_id={project_a.id}")).json()
    assert [v["slug"] for v in filtered_a["items"]] == ["github"]
    assert filtered_a["items"][0]["project_id"] == str(project_a.id)
    filtered_b = (await client.get(f"/api/vault?project_id={project_b.id}")).json()
    assert {v["slug"] for v in filtered_b["items"]} == {"figma", "github"}
    assert {v["project_id"] for v in filtered_b["items"]} == {str(project_b.id)}

    # With `project_id` query param both vaults are reachable.
    a_resp = await client.get(f"/api/vault/github/items?project_id={project_a.id}")
    assert a_resp.status_code == 200, a_resp.text
    b_resp = await client.get(f"/api/vault/github/items?project_id={project_b.id}")
    assert b_resp.status_code == 200, b_resp.text


@pytest.mark.asyncio
async def test_vault_create_only_rejects_existing_slug(client, db_session, seed_user):
    """Dashboard "New vault" flows must not hit the create-or-attach path.

    Plain POST stays idempotent attach for CLI/back-compat, while
    `create_only=true` gives UI callers a real create semantics.
    """
    from app.models.project import PROJECT_KIND_ENVIRONMENT, Project

    project_a = Project(
        user_id=seed_user.id, name="A", slug="create-only-a", kind=PROJECT_KIND_ENVIRONMENT
    )
    project_b = Project(
        user_id=seed_user.id, name="B", slug="create-only-b", kind=PROJECT_KIND_ENVIRONMENT
    )
    db_session.add_all([project_a, project_b])
    await db_session.commit()

    first = await client.post(
        f"/api/vault?project_id={project_a.id}",
        json={"slug": "github", "name": "GitHub"},
    )
    assert first.status_code == 200, first.text

    duplicate = await client.post(
        f"/api/vault?project_id={project_b.id}&create_only=true",
        json={"slug": "github", "name": "GitHub"},
    )
    assert duplicate.status_code == 409, duplicate.text

    listing_b = (await client.get(f"/api/vault?project_id={project_b.id}")).json()
    assert [v["slug"] for v in listing_b["items"]] == []

    attach = await client.post(
        f"/api/vault?project_id={project_b.id}",
        json={"slug": "github", "name": "GitHub"},
    )
    assert attach.status_code == 200, attach.text
    assert attach.json()["id"] == first.json()["id"]
    b_resp = await client.get(f"/api/vault/github/items?project_id={project_b.id}")
    assert b_resp.status_code == 200, b_resp.text


@pytest.mark.asyncio
async def test_vault_item_delete_requires_global_confirmation_for_shared_vault(
    client, seed_project, workspace_project
):
    first = await client.post(
        f"/api/vault?project_id={seed_project.id}",
        json={"slug": "github", "name": "GitHub"},
    )
    assert first.status_code == 200, first.text
    second = await client.post(
        f"/api/vault?project_id={workspace_project.id}",
        json={"slug": "github", "name": "GitHub"},
    )
    assert second.status_code == 200, second.text
    upsert = await client.put(
        f"/api/vault/github/items?project_id={workspace_project.id}",
        json={"section": "", "fields": {"TOKEN": "secret"}},
    )
    assert upsert.status_code == 200, upsert.text

    blocked = await client.request(
        "DELETE",
        f"/api/vault/github/items?project_id={seed_project.id}",
        json={"section": "", "fields": ["TOKEN"]},
    )
    assert blocked.status_code == 409, blocked.text
    assert blocked.json()["detail"]["code"] == "vault_item_global_delete_requires_confirmation"

    still_there = await client.get(f"/api/vault/github/items?project_id={workspace_project.id}")
    assert still_there.json() == {"(default)": ["TOKEN"]}

    blocked_without_project = await client.request(
        "DELETE",
        "/api/vault/github/items",
        json={"section": "", "fields": ["TOKEN"]},
    )
    assert blocked_without_project.status_code == 409, blocked_without_project.text
    assert (
        blocked_without_project.json()["detail"]["code"]
        == "vault_item_global_delete_requires_confirmation"
    )

    confirmed = await client.request(
        "DELETE",
        f"/api/vault/github/items?project_id={seed_project.id}&global_delete=true",
        json={"section": "", "fields": ["TOKEN"]},
    )
    assert confirmed.status_code == 200, confirmed.text
    gone = await client.get(f"/api/vault/github/items?project_id={workspace_project.id}")
    assert gone.json() == {}


@pytest.mark.asyncio
async def test_vault_duplicate_slug_does_not_duplicate_keys(client):
    r = await client.post("/api/vault", json={"slug": "dup", "name": "First"})
    assert r.status_code == 200, r.text
    r2 = await client.post("/api/vault", json={"slug": "dup", "name": "Second"})
    assert r2.status_code == 200, r2.text
    assert r2.json()["id"] == r.json()["id"]
