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
from app.models.vault import Vault, VaultCredentialProfile, VaultProjectAttachment


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
    filtered_a = (await client.get(f"/api/vault?project_id={project_a.id}")).json()
    assert [v["slug"] for v in filtered_a["items"]] == ["github"]
    filtered_b = (await client.get(f"/api/vault?project_id={project_b.id}")).json()
    assert {v["slug"] for v in filtered_b["items"]} == {"figma", "github"}

    # With `project_id` query param both vaults are reachable.
    a_resp = await client.get(f"/api/vault/github/items?project_id={project_a.id}")
    assert a_resp.status_code == 200, a_resp.text
    b_resp = await client.get(f"/api/vault/github/items?project_id={project_b.id}")
    assert b_resp.status_code == 200, b_resp.text


@pytest.mark.asyncio
async def test_vault_duplicate_slug_does_not_duplicate_keys(client):
    r = await client.post("/api/vault", json={"slug": "dup", "name": "First"})
    assert r.status_code == 200, r.text
    r2 = await client.post("/api/vault", json={"slug": "dup", "name": "Second"})
    assert r2.status_code == 200, r2.text
    assert r2.json()["id"] == r.json()["id"]
