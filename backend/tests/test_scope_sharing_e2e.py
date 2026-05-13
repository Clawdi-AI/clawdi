"""End-to-end scope sharing path.

This intentionally crosses route boundaries instead of unit-testing
one helper at a time:

Alice creates a share link for a scope with skill + vault content.
Bob previews it anonymously, accepts it, receives an auto-mount into
his Personal scope, then reads the shared skill and resolves a shared
vault key through that composed parent scope.
"""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.main import app
from app.models.api_key import ApiKey
from app.models.scope_membership import ScopeMembership
from app.models.scope_mount import ScopeMount
from app.models.skill import Skill
from app.models.user import User
from app.models.vault import Vault, VaultItem
from app.services.vault_crypto import encrypt


@asynccontextmanager
async def _client_as(db_session: AsyncSession, user: User, *, cli: bool = False):
    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_get_auth() -> AuthContext:
        api_key = ApiKey(user_id=user.id) if cli else None
        return AuthContext(user=user, api_key=api_key)

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            yield ac
    finally:
        app.dependency_overrides.clear()


@asynccontextmanager
async def _anonymous_client(db_session: AsyncSession):
    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override_get_session
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            yield ac
    finally:
        app.dependency_overrides.clear()


async def _create_user_with_personal_scope(db_session: AsyncSession, *, name: str):
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope

    nonce = uuid.uuid4().hex[:8]
    user = User(
        clerk_id=f"scope_share_e2e_{nonce}",
        email=f"scope_share_e2e_{nonce}@test.dev",
        name=name,
    )
    db_session.add(user)
    await db_session.flush()

    personal = Scope(
        user_id=user.id,
        name="Personal",
        slug=f"personal-{nonce}",
        kind=SCOPE_KIND_PERSONAL,
    )
    db_session.add(personal)
    await db_session.commit()
    await db_session.refresh(user)
    await db_session.refresh(personal)
    return user, personal


async def _create_owned_environment_scope(db_session: AsyncSession, *, user_id, name: str):
    from app.models.scope import SCOPE_KIND_ENVIRONMENT, Scope

    nonce = uuid.uuid4().hex[:8]
    scope = Scope(
        user_id=user_id,
        name=name,
        slug=f"{name.lower().replace(' ', '-')}-{nonce}",
        kind=SCOPE_KIND_ENVIRONMENT,
    )
    db_session.add(scope)
    await db_session.commit()
    await db_session.refresh(scope)
    return scope


async def _seed_alice_content(db_session: AsyncSession, *, user_id, scope_id):
    db_session.add(
        Skill(
            user_id=user_id,
            scope_id=scope_id,
            skill_key="deploy-helper",
            name="Deploy Helper",
            description="Shared deploy workflow",
            content_hash="e" * 64,
            is_active=True,
        )
    )

    vault = Vault(user_id=user_id, scope_id=scope_id, slug="ai", name="AI")
    db_session.add(vault)
    await db_session.flush()
    ciphertext, nonce = encrypt("sk-shared")
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


async def _seed_vault_key(
    db_session: AsyncSession,
    *,
    user_id,
    scope_id,
    vault_slug: str,
    item_name: str,
    value: str,
    section: str = "",
):
    vault = Vault(user_id=user_id, scope_id=scope_id, slug=vault_slug, name=vault_slug.upper())
    db_session.add(vault)
    await db_session.flush()
    ciphertext, nonce = encrypt(value)
    db_session.add(
        VaultItem(
            vault_id=vault.id,
            section=section,
            item_name=item_name,
            encrypted_value=ciphertext,
            nonce=nonce,
        )
    )
    await db_session.commit()


async def _create_share_link(client: httpx.AsyncClient, scope_id, *, label: str):
    create = await client.post(
        f"/api/scopes/{scope_id}/share-links",
        json={"label": label},
    )
    assert create.status_code == 200, create.text
    body = create.json()
    return body["raw_token"], body["id"]


@pytest.mark.asyncio
async def test_share_link_accept_mount_skill_and_vault_resolution_e2e(
    db_session: AsyncSession,
    seed_user: User,
    seed_scope,
):
    seed_user.name = "Alice Example"
    await _seed_alice_content(db_session, user_id=seed_user.id, scope_id=seed_scope.id)
    bob, bob_personal = await _create_user_with_personal_scope(db_session, name="Bob Example")

    async with _client_as(db_session, seed_user) as alice:
        raw_token, _link_id = await _create_share_link(alice, seed_scope.id, label="e2e path")

    async with _anonymous_client(db_session) as anon:
        preview = await anon.get(f"/api/share/{raw_token}/preview")
        assert preview.status_code == 200, preview.text
        preview_body = preview.json()
        assert preview_body["scope_id"] == str(seed_scope.id)
        assert preview_body["skill_count"] == 1
        assert preview_body["vault_count"] == 1
        assert preview_body["vault_locked"] is True

    async with _client_as(db_session, bob) as bob_web:
        upgrade = await bob_web.post(f"/api/share/{raw_token}/upgrade")
        assert upgrade.status_code == 200, upgrade.text
        upgrade_body = upgrade.json()
        assert upgrade_body["scope_id"] == str(seed_scope.id)
        assert upgrade_body["mount_parent_scope_id"] == str(bob_personal.id)
        assert upgrade_body["mount_alias"].startswith("@alice-example-")

        skills = await bob_web.get(f"/api/skills?scope_id={bob_personal.id}")
        assert skills.status_code == 200, skills.text
        deploy_helper = next(
            item for item in skills.json()["items"] if item["skill_key"] == "deploy-helper"
        )
        assert deploy_helper["scope_id"] == str(seed_scope.id)

        vaults = await bob_web.get(f"/api/vault?scope_id={bob_personal.id}")
        assert vaults.status_code == 200, vaults.text
        assert any(
            v["slug"] == "ai" and v["scope_id"] == str(seed_scope.id)
            for v in vaults.json()["items"]
        )

    async with _client_as(db_session, bob, cli=True) as bob_cli:
        resolved = await bob_cli.post(
            f"/api/vault/resolve?scope_id={bob_personal.id}&key=OPENAI_API_KEY&debug=true"
        )
        assert resolved.status_code == 200, resolved.text
        body = resolved.json()
        assert body["value"] == "sk-shared"
        assert body["source_scope_id"] == str(seed_scope.id)
        assert [entry["reason"] for entry in body["precedence"]] == ["not-found", "match"]

        env = await bob_cli.post(f"/api/vault/resolve?scope_id={bob_personal.id}")
        assert env.status_code == 200, env.text
        assert env.json()["OPENAI_API_KEY"] == "sk-shared"


@pytest.mark.asyncio
async def test_invitation_accept_mount_skill_and_vault_resolution_e2e(
    db_session: AsyncSession,
    seed_user: User,
    seed_scope,
):
    seed_user.name = "Alice Example"
    await _seed_alice_content(db_session, user_id=seed_user.id, scope_id=seed_scope.id)
    bob, bob_personal = await _create_user_with_personal_scope(db_session, name="Bob Example")

    async with _client_as(db_session, seed_user) as alice:
        invite = await alice.post(
            f"/api/scopes/{seed_scope.id}/invitations",
            json={"email": bob.email.upper()},
        )
        assert invite.status_code == 200, invite.text
        invitation_id = invite.json()["id"]

    async with _client_as(db_session, bob) as bob_web:
        inbox = await bob_web.get("/api/me/invitations")
        assert inbox.status_code == 200, inbox.text
        assert [item["id"] for item in inbox.json()] == [invitation_id]

        accept = await bob_web.post(f"/api/me/invitations/{invitation_id}/accept")
        assert accept.status_code == 200, accept.text
        accept_body = accept.json()
        assert accept_body["joined_via"] == "invite"
        assert accept_body["mount_parent_scope_id"] == str(bob_personal.id)

        empty_inbox = await bob_web.get("/api/me/invitations")
        assert empty_inbox.status_code == 200, empty_inbox.text
        assert empty_inbox.json() == []

        skills = await bob_web.get(f"/api/skills?scope_id={bob_personal.id}")
        assert skills.status_code == 200, skills.text
        assert any(item["skill_key"] == "deploy-helper" for item in skills.json()["items"])

    async with _client_as(db_session, bob, cli=True) as bob_cli:
        resolved = await bob_cli.post(
            f"/api/vault/resolve?scope_id={bob_personal.id}&key=OPENAI_API_KEY"
        )
        assert resolved.status_code == 200, resolved.text
        assert resolved.json()["value"] == "sk-shared"


@pytest.mark.asyncio
async def test_share_link_deferred_mount_can_be_completed_later_e2e(
    db_session: AsyncSession,
    seed_user: User,
    seed_scope,
):
    seed_user.name = "Alice Example"
    await _seed_alice_content(db_session, user_id=seed_user.id, scope_id=seed_scope.id)
    bob, bob_personal = await _create_user_with_personal_scope(db_session, name="Bob Example")
    bob_work = await _create_owned_environment_scope(
        db_session,
        user_id=bob.id,
        name="Work Laptop",
    )

    async with _client_as(db_session, seed_user) as alice:
        raw_token, _link_id = await _create_share_link(
            alice, seed_scope.id, label="deferred mount path"
        )

    async with _client_as(db_session, bob) as bob_web:
        upgrade = await bob_web.post(f"/api/share/{raw_token}/upgrade")
        assert upgrade.status_code == 409, upgrade.text
        detail = upgrade.json()["detail"]
        assert detail["error"] == "mount_target_ambiguous"
        assert {item["id"] for item in detail["owned_scopes"]} == {
            str(bob_personal.id),
            str(bob_work.id),
        }
        assert "membership_id" in detail

        parent_before_mount = await bob_web.get(f"/api/skills?scope_id={bob_work.id}")
        assert parent_before_mount.status_code == 200, parent_before_mount.text
        assert all(
            item["skill_key"] != "deploy-helper" for item in parent_before_mount.json()["items"]
        )

        mount = await bob_web.post(
            f"/api/scopes/{bob_work.id}/mounts",
            json={"source_scope_id": str(seed_scope.id), "alias": "@alice/work-tools"},
        )
        assert mount.status_code == 200, mount.text
        assert mount.json()["alias"] == "@alice/work-tools"

        work_skills = await bob_web.get(f"/api/skills?scope_id={bob_work.id}")
        assert work_skills.status_code == 200, work_skills.text
        assert any(item["skill_key"] == "deploy-helper" for item in work_skills.json()["items"])

        personal_skills = await bob_web.get(f"/api/skills?scope_id={bob_personal.id}")
        assert personal_skills.status_code == 200, personal_skills.text
        assert all(item["skill_key"] != "deploy-helper" for item in personal_skills.json()["items"])

    membership = (
        await db_session.execute(
            select(ScopeMembership).where(
                ScopeMembership.scope_id == seed_scope.id,
                ScopeMembership.user_id == bob.id,
            )
        )
    ).scalar_one_or_none()
    assert membership is not None


@pytest.mark.asyncio
async def test_vault_conflict_blocks_then_user_allows_and_parent_wins_e2e(
    db_session: AsyncSession,
    seed_user: User,
    seed_scope,
):
    seed_user.name = "Alice Example"
    bob, bob_personal = await _create_user_with_personal_scope(db_session, name="Bob Example")
    await _seed_vault_key(
        db_session,
        user_id=seed_user.id,
        scope_id=seed_scope.id,
        vault_slug="ai",
        item_name="OPENAI_API_KEY",
        value="sk-shared",
    )
    await _seed_vault_key(
        db_session,
        user_id=bob.id,
        scope_id=bob_personal.id,
        vault_slug="ai",
        item_name="OPENAI_API_KEY",
        value="sk-local",
    )

    async with _client_as(db_session, seed_user) as alice:
        raw_token, _link_id = await _create_share_link(
            alice, seed_scope.id, label="vault conflict path"
        )

    async with _client_as(db_session, bob) as bob_web:
        blocked = await bob_web.post(f"/api/share/{raw_token}/upgrade")
        assert blocked.status_code == 409, blocked.text
        detail = blocked.json()["detail"]
        assert detail["error"] == "vault_conflicts_blocked"
        assert detail["conflicts"] == [
            {"vault_slug": "ai", "section": "", "item_name": "OPENAI_API_KEY"}
        ]

        mounts = (
            (
                await db_session.execute(
                    select(ScopeMount).where(ScopeMount.parent_scope_id == bob_personal.id)
                )
            )
            .scalars()
            .all()
        )
        assert mounts == []

        allowed = await bob_web.post(
            f"/api/share/{raw_token}/upgrade",
            json={"allow_vault_conflicts": True},
        )
        assert allowed.status_code == 200, allowed.text
        assert allowed.json()["mount_parent_scope_id"] == str(bob_personal.id)

    async with _client_as(db_session, bob, cli=True) as bob_cli:
        resolved = await bob_cli.post(
            f"/api/vault/resolve?scope_id={bob_personal.id}&key=OPENAI_API_KEY&debug=true"
        )
        assert resolved.status_code == 200, resolved.text
        body = resolved.json()
        assert body["value"] == "sk-local"
        assert body["source_scope_id"] == str(bob_personal.id)
        assert [entry["reason"] for entry in body["precedence"]] == ["match", "skipped"]


@pytest.mark.asyncio
async def test_revoked_share_link_blocks_new_users_but_existing_mount_still_works_e2e(
    db_session: AsyncSession,
    seed_user: User,
    seed_scope,
):
    seed_user.name = "Alice Example"
    await _seed_alice_content(db_session, user_id=seed_user.id, scope_id=seed_scope.id)
    bob, bob_personal = await _create_user_with_personal_scope(db_session, name="Bob Example")
    carol, _carol_personal = await _create_user_with_personal_scope(
        db_session,
        name="Carol Example",
    )

    async with _client_as(db_session, seed_user) as alice:
        raw_token, link_id = await _create_share_link(alice, seed_scope.id, label="revoke path")

    async with _client_as(db_session, bob) as bob_web:
        accepted = await bob_web.post(f"/api/share/{raw_token}/upgrade")
        assert accepted.status_code == 200, accepted.text

    async with _client_as(db_session, seed_user) as alice:
        revoked = await alice.delete(f"/api/scopes/{seed_scope.id}/share-links/{link_id}")
        assert revoked.status_code == 200, revoked.text
        assert revoked.json() == {"status": "revoked"}

    async with _anonymous_client(db_session) as anon:
        preview = await anon.get(f"/api/share/{raw_token}/preview")
        assert preview.status_code == 410, preview.text

    async with _client_as(db_session, carol) as carol_web:
        blocked = await carol_web.post(f"/api/share/{raw_token}/upgrade")
        assert blocked.status_code == 410, blocked.text

    async with _client_as(db_session, bob) as bob_web:
        skills = await bob_web.get(f"/api/skills?scope_id={bob_personal.id}")
        assert skills.status_code == 200, skills.text
        assert any(item["skill_key"] == "deploy-helper" for item in skills.json()["items"])

        mounts = await bob_web.get(f"/api/scopes/{bob_personal.id}/mounts")
        assert mounts.status_code == 200, mounts.text
        mount_id = mounts.json()[0]["id"]

        unmount = await bob_web.delete(f"/api/scopes/{bob_personal.id}/mounts/{mount_id}")
        assert unmount.status_code == 200, unmount.text
        assert unmount.json() == {"status": "unmounted"}

        after_unmount = await bob_web.get(f"/api/skills?scope_id={bob_personal.id}")
        assert after_unmount.status_code == 200, after_unmount.text
        assert all(item["skill_key"] != "deploy-helper" for item in after_unmount.json()["items"])


@pytest.mark.asyncio
async def test_member_leave_removes_membership_and_mount_edges_e2e(
    db_session: AsyncSession,
    seed_user: User,
    seed_scope,
):
    seed_user.name = "Alice Example"
    await _seed_alice_content(db_session, user_id=seed_user.id, scope_id=seed_scope.id)
    bob, bob_personal = await _create_user_with_personal_scope(db_session, name="Bob Example")

    async with _client_as(db_session, seed_user) as alice:
        raw_token, _link_id = await _create_share_link(alice, seed_scope.id, label="leave path")

    async with _client_as(db_session, bob) as bob_web:
        accepted = await bob_web.post(f"/api/share/{raw_token}/upgrade")
        assert accepted.status_code == 200, accepted.text

        before_leave = await bob_web.get(f"/api/skills?scope_id={bob_personal.id}")
        assert before_leave.status_code == 200, before_leave.text
        assert any(item["skill_key"] == "deploy-helper" for item in before_leave.json()["items"])

        leave = await bob_web.post(f"/api/scopes/{seed_scope.id}/leave")
        assert leave.status_code == 200, leave.text
        assert leave.json() == {"status": "left", "mounts_removed": 1}

        after_leave = await bob_web.get(f"/api/skills?scope_id={bob_personal.id}")
        assert after_leave.status_code == 200, after_leave.text
        assert all(item["skill_key"] != "deploy-helper" for item in after_leave.json()["items"])

    membership = (
        await db_session.execute(
            select(ScopeMembership).where(
                ScopeMembership.scope_id == seed_scope.id,
                ScopeMembership.user_id == bob.id,
            )
        )
    ).scalar_one_or_none()
    assert membership is None

    mounts = (
        (
            await db_session.execute(
                select(ScopeMount).where(ScopeMount.parent_scope_id == bob_personal.id)
            )
        )
        .scalars()
        .all()
    )
    assert mounts == []


@pytest.mark.asyncio
async def test_owner_member_management_and_unshare_e2e(
    db_session: AsyncSession,
    seed_user: User,
    seed_scope,
):
    seed_user.name = "Alice Example"
    await _seed_alice_content(db_session, user_id=seed_user.id, scope_id=seed_scope.id)
    bob, bob_personal = await _create_user_with_personal_scope(db_session, name="Bob Example")
    carol, carol_personal = await _create_user_with_personal_scope(
        db_session,
        name="Carol Example",
    )
    dave, _dave_personal = await _create_user_with_personal_scope(
        db_session,
        name="Dave Example",
    )

    async with _client_as(db_session, seed_user) as alice:
        bob_token, _bob_link_id = await _create_share_link(alice, seed_scope.id, label="bob")
        carol_token, _carol_link_id = await _create_share_link(alice, seed_scope.id, label="carol")
        spare_token, _spare_link_id = await _create_share_link(alice, seed_scope.id, label="spare")
        invite = await alice.post(
            f"/api/scopes/{seed_scope.id}/invitations",
            json={"email": dave.email},
        )
        assert invite.status_code == 200, invite.text

    async with _client_as(db_session, bob) as bob_web:
        accepted = await bob_web.post(f"/api/share/{bob_token}/upgrade")
        assert accepted.status_code == 200, accepted.text

    async with _client_as(db_session, carol) as carol_web:
        accepted = await carol_web.post(f"/api/share/{carol_token}/upgrade")
        assert accepted.status_code == 200, accepted.text

    async with _client_as(db_session, seed_user) as alice:
        members = await alice.get(f"/api/scopes/{seed_scope.id}/members")
        assert members.status_code == 200, members.text
        assert {member["user_id"] for member in members.json()} == {str(bob.id), str(carol.id)}

        remove_bob = await alice.delete(f"/api/scopes/{seed_scope.id}/members/{bob.id}")
        assert remove_bob.status_code == 200, remove_bob.text
        assert remove_bob.json() == {"status": "removed", "mounts_removed": 1}

    async with _client_as(db_session, bob) as bob_web:
        bob_after_remove = await bob_web.get(f"/api/skills?scope_id={bob_personal.id}")
        assert bob_after_remove.status_code == 200, bob_after_remove.text
        assert all(
            item["skill_key"] != "deploy-helper" for item in bob_after_remove.json()["items"]
        )

    async with _client_as(db_session, seed_user) as alice:
        unshare = await alice.post(f"/api/scopes/{seed_scope.id}/unshare")
        assert unshare.status_code == 200, unshare.text
        assert unshare.json() == {
            "links_revoked": 3,
            "members_removed": 1,
            "invitations_cancelled": 1,
        }

    async with _client_as(db_session, carol) as carol_web:
        carol_after_unshare = await carol_web.get(f"/api/skills?scope_id={carol_personal.id}")
        assert carol_after_unshare.status_code == 200, carol_after_unshare.text
        assert all(
            item["skill_key"] != "deploy-helper" for item in carol_after_unshare.json()["items"]
        )

    async with _anonymous_client(db_session) as anon:
        preview = await anon.get(f"/api/share/{spare_token}/preview")
        assert preview.status_code == 410, preview.text
