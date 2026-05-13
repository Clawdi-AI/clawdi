"""Vault read/resolve paths walk mount edges with deterministic precedence."""

import uuid
from datetime import UTC, datetime

import pytest


async def _seed_shared_source(db_session, seed_user, seed_scope):
    from app.models.scope import SCOPE_KIND_ENVIRONMENT, Scope
    from app.models.scope_membership import ScopeMembership
    from app.models.scope_mount import ScopeMount
    from app.models.user import User

    nonce = uuid.uuid4().hex[:8]
    owner = User(
        clerk_id=f"vault_owner_{nonce}",
        email=f"vault_owner_{nonce}@test.dev",
        name="Alice",
    )
    db_session.add(owner)
    await db_session.flush()

    source = Scope(
        user_id=owner.id,
        name="Engineering",
        slug=f"engineering-{nonce}",
        kind=SCOPE_KIND_ENVIRONMENT,
    )
    db_session.add(source)
    await db_session.flush()

    db_session.add(
        ScopeMembership(
            scope_id=source.id,
            user_id=seed_user.id,
            role="viewer",
            joined_via="link",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="alice-test",
        )
    )
    db_session.add(
        ScopeMount(
            parent_scope_id=seed_scope.id,
            source_scope_id=source.id,
            alias=f"@alice-test/{source.slug}",
            mode="live",
            created_by=seed_user.id,
            created_at=datetime.now(UTC),
        )
    )
    await db_session.commit()
    return source


async def _seed_vault_key(db_session, *, user_id, scope_id, value: str):
    from app.models.vault import Vault, VaultItem
    from app.services.vault_crypto import encrypt

    vault = Vault(user_id=user_id, scope_id=scope_id, slug="ai", name="AI")
    db_session.add(vault)
    await db_session.flush()
    ciphertext, nonce = encrypt(value)
    db_session.add(
        VaultItem(
            vault_id=vault.id,
            section="",
            item_name="OPENAI_API_KEY",
            encrypted_value=ciphertext,
            nonce=nonce,
        )
    )
    await db_session.commit()
    return vault


@pytest.mark.asyncio
async def test_vault_list_with_parent_scope_includes_mounted_sources(
    cli_client, db_session, seed_user, seed_scope
):
    source = await _seed_shared_source(db_session, seed_user, seed_scope)
    await _seed_vault_key(
        db_session,
        user_id=source.user_id,
        scope_id=source.id,
        value="sk-source",
    )

    r = await cli_client.get(f"/api/vault?scope_id={seed_scope.id}")
    assert r.status_code == 200, r.text
    scope_ids = {row["scope_id"] for row in r.json()["items"]}
    assert str(source.id) in scope_ids


@pytest.mark.asyncio
async def test_vault_resolve_parent_wins_over_mounted_source(
    cli_client, db_session, seed_user, seed_scope
):
    source = await _seed_shared_source(db_session, seed_user, seed_scope)
    await _seed_vault_key(
        db_session,
        user_id=seed_user.id,
        scope_id=seed_scope.id,
        value="sk-parent",
    )
    await _seed_vault_key(
        db_session,
        user_id=source.user_id,
        scope_id=source.id,
        value="sk-source",
    )

    r = await cli_client.post(
        f"/api/vault/resolve?scope_id={seed_scope.id}&key=OPENAI_API_KEY&debug=true"
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["value"] == "sk-parent"
    assert body["source_scope_id"] == str(seed_scope.id)
    assert [p["reason"] for p in body["precedence"]] == ["match", "skipped"]


@pytest.mark.asyncio
async def test_vault_resolve_falls_back_to_mounted_source(
    cli_client, db_session, seed_user, seed_scope
):
    source = await _seed_shared_source(db_session, seed_user, seed_scope)
    await _seed_vault_key(
        db_session,
        user_id=source.user_id,
        scope_id=source.id,
        value="sk-source",
    )

    r = await cli_client.post(
        f"/api/vault/resolve?scope_id={seed_scope.id}&key=OPENAI_API_KEY&debug=true"
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["value"] == "sk-source"
    assert body["source_scope_id"] == str(source.id)
    assert [p["reason"] for p in body["precedence"]] == ["not-found", "match"]


@pytest.mark.asyncio
async def test_sharee_cannot_mutate_owner_vault(
    cli_client, db_session, seed_user, seed_scope
):
    source = await _seed_shared_source(db_session, seed_user, seed_scope)
    await _seed_vault_key(
        db_session,
        user_id=source.user_id,
        scope_id=source.id,
        value="sk-source",
    )

    deleted = await cli_client.delete(f"/api/vault/ai?scope_id={source.id}")
    assert deleted.status_code == 404, deleted.text

    upserted = await cli_client.put(
        f"/api/vault/ai/items?scope_id={source.id}",
        json={"section": "", "fields": {"OPENAI_API_KEY": "sk-attacker"}},
    )
    assert upserted.status_code == 404, upserted.text

    item_deleted = await cli_client.request(
        "DELETE",
        f"/api/vault/ai/items?scope_id={source.id}",
        json={"section": "", "fields": ["OPENAI_API_KEY"]},
    )
    assert item_deleted.status_code == 404, item_deleted.text

    resolved = await cli_client.post(
        f"/api/vault/resolve?scope_id={seed_scope.id}&key=OPENAI_API_KEY"
    )
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["value"] == "sk-source"


@pytest.mark.asyncio
async def test_unscoped_resolve_does_not_leak_shared_secrets(
    cli_client, db_session, seed_user, seed_scope
):
    source = await _seed_shared_source(db_session, seed_user, seed_scope)
    await _seed_vault_key(
        db_session,
        user_id=source.user_id,
        scope_id=source.id,
        value="sk-source",
    )

    key_lookup = await cli_client.post("/api/vault/resolve?key=OPENAI_API_KEY&debug=true")
    assert key_lookup.status_code == 404, key_lookup.text
    precedence = key_lookup.json()["detail"]["precedence"]
    assert [entry["scope_id"] for entry in precedence] == [str(seed_scope.id)]

    env = await cli_client.post("/api/vault/resolve")
    assert env.status_code == 200, env.text
    assert "OPENAI_API_KEY" not in env.json()
