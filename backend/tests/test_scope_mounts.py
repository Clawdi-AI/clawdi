"""POST/GET/DELETE /api/scopes/{id}/mounts.

Exercises the source-capability re-check, alias collision rule, and
the idempotent `ensure_mount` helper. Mounts can't bypass the
membership ACL.
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select


async def _seed_other_users_scope(db_session, *, viewer_membership=True, viewer_user_id=None):
    """Helper: spawn an 'other' user + their scope; optionally grant
    viewer membership to the requesting user. Returns the source Scope."""
    from app.models.scope import SCOPE_KIND_ENVIRONMENT, Scope
    from app.models.scope_membership import ScopeMembership
    from app.models.user import User

    nonce = uuid.uuid4().hex[:8]
    other = User(
        clerk_id=f"other_{nonce}",
        email=f"other_{nonce}@test.dev",
        name="Alice",
    )
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)

    src = Scope(
        user_id=other.id,
        name="Engineering",
        slug=f"engineering-{nonce}",
        kind=SCOPE_KIND_ENVIRONMENT,
    )
    db_session.add(src)
    await db_session.commit()
    await db_session.refresh(src)

    if viewer_membership and viewer_user_id is not None:
        db_session.add(
            ScopeMembership(
                scope_id=src.id,
                user_id=viewer_user_id,
                role="viewer",
                joined_via="link",
                joined_at=datetime.now(UTC),
                resolved_owner_handle="alice-test",
            )
        )
        await db_session.commit()

    return src


@pytest.mark.asyncio
async def test_list_mounts_404_on_non_owned_parent(client):
    """Listing mounts on a scope the caller doesn't own → 404 (same
    shape as scope-not-found, so scope IDs aren't enumerable)."""
    r = await client.get("/api/scopes/00000000-0000-0000-0000-000000000000/mounts")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_create_mount_succeeds_when_caller_has_source_membership(
    client, db_session, seed_user, seed_scope
):
    seed_user.name = "Bob"
    src = await _seed_other_users_scope(
        db_session, viewer_membership=True, viewer_user_id=seed_user.id
    )

    r = await client.post(
        f"/api/scopes/{seed_scope.id}/mounts",
        json={"source_scope_id": str(src.id)},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["parent_scope_id"] == str(seed_scope.id)
    assert body["source_scope_id"] == str(src.id)
    assert body["source_scope_name"] == "Engineering"
    # Auto-derived alias: @<kebab(owner-display)>-<hex4>/<source-slug>
    # The seed helper sets owner.name="Alice", so handle starts with "alice-".
    assert body["alias"].startswith("@alice-")
    assert "/engineering-" in body["alias"]
    assert body["mode"] == "live"

    # Listing shows the row
    r2 = await client.get(f"/api/scopes/{seed_scope.id}/mounts")
    assert r2.status_code == 200
    items = r2.json()
    assert len(items) == 1
    assert items[0]["id"] == body["id"]


@pytest.mark.asyncio
async def test_create_mount_403_without_source_membership(
    client, db_session, seed_user, seed_scope
):
    """Caller owns parent but has no membership in source → 403
    source_not_visible. Mounting can't bypass the capability layer."""
    seed_user.name = "Bob"
    src = await _seed_other_users_scope(db_session, viewer_membership=False)
    r = await client.post(
        f"/api/scopes/{seed_scope.id}/mounts",
        json={"source_scope_id": str(src.id)},
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["error"] == "source_not_visible"


@pytest.mark.asyncio
async def test_create_mount_400_on_self_mount(client, seed_user, seed_scope):
    """Mounting a scope into itself → 400 self_mount."""
    seed_user.name = "Bob"
    r = await client.post(
        f"/api/scopes/{seed_scope.id}/mounts",
        json={"source_scope_id": str(seed_scope.id)},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "self_mount"


@pytest.mark.asyncio
async def test_create_mount_alias_collision_suffix_bumps(
    client, db_session, seed_user, seed_scope
):
    """Two different sources mounting into the same parent with the
    same explicit alias → second gets `-2` suffix."""
    seed_user.name = "Bob"
    src_a = await _seed_other_users_scope(
        db_session, viewer_membership=True, viewer_user_id=seed_user.id
    )
    src_b = await _seed_other_users_scope(
        db_session, viewer_membership=True, viewer_user_id=seed_user.id
    )

    r1 = await client.post(
        f"/api/scopes/{seed_scope.id}/mounts",
        json={"source_scope_id": str(src_a.id), "alias": "@team/shared"},
    )
    assert r1.status_code == 200, r1.text
    assert r1.json()["alias"] == "@team/shared"

    r2 = await client.post(
        f"/api/scopes/{seed_scope.id}/mounts",
        json={"source_scope_id": str(src_b.id), "alias": "@team/shared"},
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["alias"] == "@team/shared-2"


@pytest.mark.asyncio
async def test_create_mount_idempotent_on_same_pair(
    client, db_session, seed_user, seed_scope
):
    """Re-creating the same (parent, source) pair returns the
    existing row instead of erroring."""
    seed_user.name = "Bob"
    src = await _seed_other_users_scope(
        db_session, viewer_membership=True, viewer_user_id=seed_user.id
    )

    r1 = await client.post(
        f"/api/scopes/{seed_scope.id}/mounts",
        json={"source_scope_id": str(src.id)},
    )
    assert r1.status_code == 200
    mount_id = r1.json()["id"]

    r2 = await client.post(
        f"/api/scopes/{seed_scope.id}/mounts",
        json={"source_scope_id": str(src.id)},
    )
    assert r2.status_code == 200
    assert r2.json()["id"] == mount_id


@pytest.mark.asyncio
async def test_delete_mount_drops_only_the_edge(
    client, db_session, seed_user, seed_scope
):
    """DELETE removes the mount row; the underlying ScopeMembership
    is unaffected."""
    from app.models.scope_membership import ScopeMembership
    from app.models.scope_mount import ScopeMount

    seed_user.name = "Bob"
    src = await _seed_other_users_scope(
        db_session, viewer_membership=True, viewer_user_id=seed_user.id
    )
    src_id = src.id

    create = await client.post(
        f"/api/scopes/{seed_scope.id}/mounts",
        json={"source_scope_id": str(src_id)},
    )
    mount_id = create.json()["id"]

    delete = await client.delete(f"/api/scopes/{seed_scope.id}/mounts/{mount_id}")
    assert delete.status_code == 200
    assert delete.json()["status"] == "unmounted"

    # Mount gone
    listing = await client.get(f"/api/scopes/{seed_scope.id}/mounts")
    assert listing.json() == []

    # Membership survives
    membership = (
        await db_session.execute(
            select(ScopeMembership).where(
                ScopeMembership.scope_id == src_id,
                ScopeMembership.user_id == seed_user.id,
            )
        )
    ).scalar_one_or_none()
    assert membership is not None
    # Also: no zombie mount in the DB
    leftover = (
        await db_session.execute(select(ScopeMount).where(ScopeMount.id == mount_id))
    ).scalar_one_or_none()
    assert leftover is None


@pytest.mark.asyncio
async def test_delete_mount_404_on_wrong_scope(client, db_session, seed_user, seed_scope):
    seed_user.name = "Bob"
    src = await _seed_other_users_scope(
        db_session, viewer_membership=True, viewer_user_id=seed_user.id
    )
    create = await client.post(
        f"/api/scopes/{seed_scope.id}/mounts",
        json={"source_scope_id": str(src.id)},
    )
    mount_id = create.json()["id"]
    bogus_parent = "00000000-0000-0000-0000-000000000000"
    r = await client.delete(f"/api/scopes/{bogus_parent}/mounts/{mount_id}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_create_mount_400_on_invalid_mode(client, db_session, seed_user, seed_scope):
    """`snapshot_rev_N` is reserved for v3; v2 rejects non-`live`."""
    seed_user.name = "Bob"
    src = await _seed_other_users_scope(
        db_session, viewer_membership=True, viewer_user_id=seed_user.id
    )
    r = await client.post(
        f"/api/scopes/{seed_scope.id}/mounts",
        json={"source_scope_id": str(src.id), "mode": "snapshot_rev_1"},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "unsupported_mode"


async def _seed_vault_key(db_session, *, scope_id, vault_slug: str, section: str, name: str):
    """Helper: drop a single (vault_slug, section, item_name) row under
    `scope_id` so collision tests can pre-stage state on either side."""
    from app.models.scope import Scope
    from app.models.vault import Vault, VaultItem

    owner = (
        await db_session.execute(select(Scope).where(Scope.id == scope_id))
    ).scalar_one()
    vault = (
        await db_session.execute(
            select(Vault).where(Vault.scope_id == scope_id, Vault.slug == vault_slug)
        )
    ).scalar_one_or_none()
    if vault is None:
        vault = Vault(
            user_id=owner.user_id,
            scope_id=scope_id,
            slug=vault_slug,
            name=vault_slug,
        )
        db_session.add(vault)
        await db_session.commit()
        await db_session.refresh(vault)
    db_session.add(
        VaultItem(
            vault_id=vault.id,
            item_name=name,
            section=section,
            encrypted_value=b"x",
            nonce=b"y",
        )
    )
    await db_session.commit()


@pytest.mark.asyncio
async def test_create_mount_409_on_vault_conflict(client, db_session, seed_user, seed_scope):
    """Source + parent both carry the same (vault_slug, section, name)
    key → 409 vault_conflicts_blocked, no mount row created."""
    seed_user.name = "Bob"
    src = await _seed_other_users_scope(
        db_session, viewer_membership=True, viewer_user_id=seed_user.id
    )
    # Same key in both vaults.
    await _seed_vault_key(
        db_session,
        scope_id=seed_scope.id,
        vault_slug="ai-keys",
        section="",
        name="OPENAI_API_KEY",
    )
    await _seed_vault_key(
        db_session,
        scope_id=src.id,
        vault_slug="ai-keys",
        section="",
        name="OPENAI_API_KEY",
    )

    r = await client.post(
        f"/api/scopes/{seed_scope.id}/mounts",
        json={"source_scope_id": str(src.id)},
    )
    assert r.status_code == 409, r.text
    body = r.json()["detail"]
    assert body["error"] == "vault_conflicts_blocked"
    assert body["conflicts"] == [
        {"vault_slug": "ai-keys", "section": "", "item_name": "OPENAI_API_KEY"}
    ]


@pytest.mark.asyncio
async def test_create_mount_skips_conflict_check_with_allow_flag(
    client, db_session, seed_user, seed_scope
):
    """Same setup, but request body says allow_vault_conflicts=true →
    mount created successfully (collision is the user's call now)."""
    seed_user.name = "Bob"
    src = await _seed_other_users_scope(
        db_session, viewer_membership=True, viewer_user_id=seed_user.id
    )
    await _seed_vault_key(
        db_session,
        scope_id=seed_scope.id,
        vault_slug="ai-keys",
        section="",
        name="OPENAI_API_KEY",
    )
    await _seed_vault_key(
        db_session,
        scope_id=src.id,
        vault_slug="ai-keys",
        section="",
        name="OPENAI_API_KEY",
    )

    r = await client.post(
        f"/api/scopes/{seed_scope.id}/mounts",
        json={"source_scope_id": str(src.id), "allow_vault_conflicts": True},
    )
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_create_mount_no_conflict_when_keys_differ(
    client, db_session, seed_user, seed_scope
):
    """Same vault slug + section, DIFFERENT item names → no conflict;
    mount goes through cleanly. Ensures we're matching the full triple
    and not just (slug, section)."""
    seed_user.name = "Bob"
    src = await _seed_other_users_scope(
        db_session, viewer_membership=True, viewer_user_id=seed_user.id
    )
    await _seed_vault_key(
        db_session,
        scope_id=seed_scope.id,
        vault_slug="ai-keys",
        section="",
        name="OPENAI_API_KEY",
    )
    await _seed_vault_key(
        db_session,
        scope_id=src.id,
        vault_slug="ai-keys",
        section="",
        name="ANTHROPIC_API_KEY",
    )

    r = await client.post(
        f"/api/scopes/{seed_scope.id}/mounts",
        json={"source_scope_id": str(src.id)},
    )
    assert r.status_code == 200, r.text
