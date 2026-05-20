"""project_ids_visible_to widens to include shared memberships for
Clerk JWT + unbound-CLI callers. Env-bound Agent API keys keep their
single-project ceiling on explicit project reads, but may read attached
shared Projects through the matching Agent runtime boundary."""

import uuid
from datetime import UTC, datetime

import pytest

from app.core.auth import AuthContext
from app.core.project import project_ids_visible_to


@pytest.mark.asyncio
async def test_clerk_jwt_sees_owned_and_shared_projects(db_session, seed_user, seed_project):
    """Clerk JWT caller sees both owned projects and projects they
    joined as a member."""
    from app.models.project import PROJECT_KIND_PERSONAL, Project
    from app.models.project_membership import ProjectMembership
    from app.models.user import User

    nonce = uuid.uuid4().hex[:8]
    owner = User(
        clerk_id=f"o_{nonce}",
        email=f"o_{nonce}@test.dev",
        name="O",
    )
    db_session.add(owner)
    await db_session.commit()
    shared = Project(
        user_id=owner.id,
        name="s",
        slug=f"s-{nonce}",
        kind=PROJECT_KIND_PERSONAL,
    )
    db_session.add(shared)
    await db_session.commit()
    db_session.add(
        ProjectMembership(
            project_id=shared.id,
            member_user_id=seed_user.id,
            role="viewer",
            joined_via="invite",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="o-1234",
        )
    )
    await db_session.commit()

    try:
        auth = AuthContext(user=seed_user, api_key=None)
        visible = await project_ids_visible_to(db_session, auth)
        assert seed_project.id in visible
        assert shared.id in visible
    finally:
        # Membership cascade-deletes when project is deleted (FK ON DELETE
        # CASCADE in the migration), so we only need to clean shared+owner.
        await db_session.delete(shared)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_recipient_can_read_shared_project_skill_detail_and_search(
    client,
    db_session,
    seed_user,
):
    """Shared-project visibility must apply to every read surface, not
    just list endpoints."""
    from app.models.project import PROJECT_KIND_PERSONAL, Project
    from app.models.project_membership import ProjectMembership
    from app.models.skill import Skill
    from app.models.user import User
    from app.models.vault import Vault, VaultProjectAttachment

    nonce = uuid.uuid4().hex[:8]
    owner = User(
        clerk_id=f"ro_{nonce}",
        email=f"ro_{nonce}@test.dev",
        name="Read Owner",
    )
    db_session.add(owner)
    await db_session.commit()

    shared = Project(
        user_id=owner.id,
        name="shared read project",
        slug=f"shared-read-{nonce}",
        kind=PROJECT_KIND_PERSONAL,
    )
    db_session.add(shared)
    await db_session.commit()

    db_session.add(
        ProjectMembership(
            project_id=shared.id,
            member_user_id=seed_user.id,
            role="viewer",
            joined_via="invite",
            joined_at=datetime.now(UTC),
            resolved_owner_handle=f"ro-{nonce}",
        )
    )
    skill_key = f"shared-read-{nonce}"
    db_session.add(
        Skill(
            user_id=owner.id,
            project_id=shared.id,
            skill_key=skill_key,
            name=f"Shared Read {nonce}",
            description=f"shared skill search {nonce}",
            content_hash="d" * 64,
            file_count=1,
            is_active=True,
        )
    )
    vault = Vault(
        user_id=owner.id,
        slug=f"shared-vault-{nonce}",
        name=f"Shared Vault {nonce}",
    )
    db_session.add(vault)
    await db_session.flush()
    db_session.add(VaultProjectAttachment(vault_id=vault.id, project_id=shared.id))
    await db_session.commit()

    try:
        project_detail = await client.get(f"/api/projects/{shared.id}/skills/{skill_key}")
        assert project_detail.status_code == 200, project_detail.text
        assert project_detail.json()["project_id"] == str(shared.id)

        legacy_detail = await client.get(f"/api/skills/{skill_key}")
        assert legacy_detail.status_code == 200, legacy_detail.text
        assert legacy_detail.json()["project_id"] == str(shared.id)

        skill_search = await client.get("/api/search", params={"q": skill_key})
        assert skill_search.status_code == 200, skill_search.text
        skill_hits = [h for h in skill_search.json()["results"] if h["type"] == "skill"]
        assert any(h["id"] for h in skill_hits), skill_search.json()

        vault_search = await client.get("/api/search", params={"q": f"shared-vault-{nonce}"})
        assert vault_search.status_code == 200, vault_search.text
        vault_hits = [h for h in vault_search.json()["results"] if h["type"] == "vault"]
        assert any(h["title"] == f"Shared Vault {nonce}" for h in vault_hits), vault_search.json()
    finally:
        await db_session.delete(shared)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_recipient_viewer_cannot_write_shared_project_resources(
    client,
    db_session,
    seed_user,
):
    """Viewer membership expands read visibility only. It must never
    make shared-project skills/vaults writable by the recipient."""
    from sqlalchemy import select

    from app.models.project import PROJECT_KIND_WORKSPACE, Project
    from app.models.project_membership import ProjectMembership
    from app.models.skill import Skill
    from app.models.user import User
    from app.models.vault import Vault, VaultProjectAttachment
    from app.services.tar_utils import tar_from_content

    nonce = uuid.uuid4().hex[:8]
    owner = User(
        clerk_id=f"wo_{nonce}",
        email=f"wo_{nonce}@test.dev",
        name="Write Owner",
    )
    db_session.add(owner)
    await db_session.commit()

    shared = Project(
        user_id=owner.id,
        name="shared write boundary",
        slug=f"shared-write-{nonce}",
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
            resolved_owner_handle=f"wo-{nonce}",
        )
    )
    db_session.add(
        Skill(
            user_id=owner.id,
            project_id=shared.id,
            skill_key=f"owner-skill-{nonce}",
            name="Owner Skill",
            description="owner-only write boundary",
            content_hash="e" * 64,
            file_count=1,
            is_active=True,
        )
    )
    vault = Vault(user_id=owner.id, slug=f"owner-vault-{nonce}", name="Owner Vault")
    db_session.add(vault)
    await db_session.flush()
    db_session.add(VaultProjectAttachment(vault_id=vault.id, project_id=shared.id))
    await db_session.commit()

    try:
        tar_bytes, _ = tar_from_content(
            f"recipient-skill-{nonce}",
            "---\nname: denied\n---\n# Denied\n",
        )
        upload = await client.post(
            f"/api/projects/{shared.id}/skills/upload",
            data={"skill_key": f"recipient-skill-{nonce}"},
            files={"file": ("denied.tar.gz", tar_bytes, "application/gzip")},
        )
        assert upload.status_code == 404, upload.text

        edit = await client.put(
            f"/api/projects/{shared.id}/skills/owner-skill-{nonce}/content",
            json={"content": "---\nname: denied\n---\n# Denied\n"},
        )
        assert edit.status_code == 404, edit.text

        delete_skill = await client.delete(f"/api/projects/{shared.id}/skills/owner-skill-{nonce}")
        assert delete_skill.status_code == 404, delete_skill.text

        create_vault = await client.post(
            f"/api/vault?project_id={shared.id}",
            json={"slug": f"recipient-vault-{nonce}", "name": "Denied"},
        )
        assert create_vault.status_code == 404, create_vault.text

        upsert_vault = await client.put(
            f"/api/vault/owner-vault-{nonce}/items?project_id={shared.id}",
            json={"section": "", "fields": {"TOKEN": "denied"}},
        )
        assert upsert_vault.status_code == 404, upsert_vault.text

        delete_vault = await client.delete(f"/api/vault/owner-vault-{nonce}?project_id={shared.id}")
        assert delete_vault.status_code == 404, delete_vault.text

        leaked_skill = (
            await db_session.execute(
                select(Skill).where(
                    Skill.project_id == shared.id,
                    Skill.user_id == seed_user.id,
                )
            )
        ).scalar_one_or_none()
        assert leaked_skill is None

        leaked_vault = (
            await db_session.execute(select(Vault).where(Vault.user_id == seed_user.id))
        ).scalar_one_or_none()
        assert leaked_vault is None
    finally:
        await db_session.delete(shared)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_recipient_cli_cannot_resolve_shared_project_vault_plaintext(
    cli_client,
    db_session,
    seed_user,
):
    """User-level CLI keys can read shared metadata, but not shared plaintext."""
    from app.models.agent_project_binding import AgentProjectBinding
    from app.models.project import PROJECT_KIND_WORKSPACE, Project
    from app.models.project_membership import ProjectMembership
    from app.models.user import User
    from app.models.vault import Vault, VaultItem, VaultProjectAttachment
    from app.services.vault_crypto import encrypt
    from tests.conftest import create_env_with_project

    nonce = uuid.uuid4().hex[:8]
    owner = User(
        clerk_id=f"vo_{nonce}",
        email=f"vo_{nonce}@test.dev",
        name="Vault Owner",
    )
    db_session.add(owner)
    await db_session.commit()

    shared = Project(
        user_id=owner.id,
        name="shared vault boundary",
        slug=f"shared-vault-boundary-{nonce}",
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
            resolved_owner_handle=f"vo-{nonce}",
        )
    )
    vault = Vault(
        user_id=owner.id,
        slug=f"owner-secret-{nonce}",
        name="Owner Secret",
    )
    db_session.add(vault)
    await db_session.flush()
    db_session.add(VaultProjectAttachment(vault_id=vault.id, project_id=shared.id))
    ciphertext, nonce_bytes = encrypt("owner-secret-value")
    db_session.add(
        VaultItem(
            vault_id=vault.id,
            section="",
            item_name="TOKEN",
            encrypted_value=ciphertext,
            nonce=nonce_bytes,
        )
    )
    await db_session.commit()

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"viewer-{nonce}",
        machine_name="Viewer Agent",
    )
    db_session.add(
        AgentProjectBinding(
            agent_id=env.id,
            project_id=shared.id,
            binding_type="context",
            priority=1,
            default_write_enabled=False,
            created_by_user_id=seed_user.id,
        )
    )
    await db_session.commit()

    try:
        explicit = await cli_client.post(f"/api/vault/resolve?key=TOKEN&project_id={shared.id}")
        assert explicit.status_code == 404, explicit.text

        attached_key = await cli_client.post(f"/api/vault/resolve?key=TOKEN&agent_id={env.id}")
        assert attached_key.status_code == 404, attached_key.text

        attached_env = await cli_client.post(f"/api/vault/resolve?agent_id={env.id}")
        assert attached_env.status_code == 200, attached_env.text
        assert "TOKEN" not in attached_env.json()
    finally:
        await db_session.delete(shared)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_env_bound_agent_key_resolves_attached_shared_project_vault_plaintext(
    db_session,
    seed_user,
):
    """A bound Agent key can resolve shared Project vault plaintext only
    through its own Agent attachment boundary."""
    import httpx
    from httpx import ASGITransport

    from app.core.auth import get_auth
    from app.core.database import get_session
    from app.main import app
    from app.models.agent_project_binding import AgentProjectBinding
    from app.models.api_key import ApiKey
    from app.models.project import PROJECT_KIND_WORKSPACE, Project
    from app.models.project_membership import ProjectMembership
    from app.models.user import User
    from app.models.vault import Vault, VaultItem, VaultProjectAttachment
    from app.services.vault_crypto import encrypt
    from tests.conftest import create_env_with_project

    nonce = uuid.uuid4().hex[:8]
    owner = User(
        clerk_id=f"bound_vo_{nonce}",
        email=f"bound_vo_{nonce}@test.dev",
        name="Bound Vault Owner",
    )
    db_session.add(owner)
    await db_session.flush()

    shared = Project(
        user_id=owner.id,
        name="shared agent vault boundary",
        slug=f"shared-agent-vault-boundary-{nonce}",
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
            resolved_owner_handle=f"bound-vo-{nonce}",
        )
    )

    vault = Vault(
        user_id=owner.id,
        slug=f"owner-agent-secret-{nonce}",
        name="Owner Agent Secret",
    )
    db_session.add(vault)
    await db_session.flush()
    db_session.add(VaultProjectAttachment(vault_id=vault.id, project_id=shared.id))
    ciphertext, nonce_bytes = encrypt("attached-secret-value")
    db_session.add(
        VaultItem(
            vault_id=vault.id,
            section="",
            item_name="TOKEN",
            encrypted_value=ciphertext,
            nonce=nonce_bytes,
        )
    )

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"bound-viewer-{nonce}",
        machine_name="Bound Viewer Agent",
    )
    db_session.add(
        AgentProjectBinding(
            agent_id=env.id,
            project_id=shared.id,
            binding_type="context",
            priority=1,
            default_write_enabled=False,
            created_by_user_id=seed_user.id,
        )
    )
    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash=("b" + nonce + "x" * (64 - len(nonce) - 1)),
        key_prefix=f"clawdi_b{nonce[:3]}",
        label="bound-agent",
        environment_id=env.id,
        scopes=None,
    )
    db_session.add(api_key)
    await db_session.commit()

    async def _override_get_session():
        yield db_session

    async def _override_get_auth():
        return AuthContext(user=seed_user, api_key=api_key)

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as ac:
            explicit = await ac.post(f"/api/vault/resolve?key=TOKEN&project_id={shared.id}")
            assert explicit.status_code == 404, explicit.text

            attached_key = await ac.post(f"/api/vault/resolve?key=TOKEN&agent_id={env.id}")
            assert attached_key.status_code == 200, attached_key.text
            assert attached_key.json()["value"] == "attached-secret-value"

            attached_exact = await ac.post(
                "/api/vault/resolve"
                f"?vault_slug={vault.slug}&field=TOKEN&project_id={shared.id}&agent_id={env.id}"
            )
            assert attached_exact.status_code == 200, attached_exact.text
            assert attached_exact.json()["value"] == "attached-secret-value"
            assert attached_exact.json()["source_project_id"] == str(shared.id)

            attached_env = await ac.post(f"/api/vault/resolve?agent_id={env.id}")
            assert attached_env.status_code == 200, attached_env.text
            assert attached_env.json()["TOKEN"] == "attached-secret-value"
    finally:
        app.dependency_overrides.clear()
        await db_session.delete(api_key)
        await db_session.delete(shared)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_recipient_skill_list_etag_changes_when_owner_updates_shared_project(
    client,
    db_session,
    seed_user,
):
    """Shared-project conditional GETs must invalidate on the owner's
    skill revision, not only on the recipient's own user revision."""
    from app.models.project import PROJECT_KIND_WORKSPACE, Project
    from app.models.project_membership import ProjectMembership
    from app.models.skill import Skill
    from app.models.user import User

    nonce = uuid.uuid4().hex[:8]
    owner = User(
        clerk_id=f"etag_owner_{nonce}",
        email=f"etag_owner_{nonce}@test.dev",
        name="ETag Owner",
    )
    db_session.add(owner)
    await db_session.commit()

    shared = Project(
        user_id=owner.id,
        name="shared etag",
        slug=f"shared-etag-{nonce}",
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
            resolved_owner_handle=f"etag-owner-{nonce}",
        )
    )
    skill = Skill(
        user_id=owner.id,
        project_id=shared.id,
        skill_key=f"etag-skill-{nonce}",
        name="Shared ETag Skill",
        description="etag boundary",
        content_hash="f" * 64,
        file_count=1,
        is_active=True,
    )
    db_session.add(skill)
    await db_session.commit()

    try:
        first = await client.get(f"/api/skills?project_id={shared.id}")
        assert first.status_code == 200, first.text
        etag = first.headers.get("ETag")
        assert etag

        cached = await client.get(
            f"/api/skills?project_id={shared.id}",
            headers={"If-None-Match": etag},
        )
        assert cached.status_code == 304, cached.text

        skill.content_hash = "1" * 64
        owner.skills_revision = int(owner.skills_revision or 0) + 1
        await db_session.commit()

        refreshed = await client.get(
            f"/api/skills?project_id={shared.id}",
            headers={"If-None-Match": etag},
        )
        assert refreshed.status_code == 200, refreshed.text
        assert refreshed.headers.get("ETag") != etag
    finally:
        await db_session.delete(shared)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_unbound_cli_key_sees_owned_and_shared(db_session, seed_user, seed_project):
    """Unbound CLI api_key (from `clawdi auth login` device flow,
    no environment_id) behaves like Clerk JWT — full owned+shared."""
    from app.models.api_key import ApiKey
    from app.models.project import PROJECT_KIND_PERSONAL, Project
    from app.models.project_membership import ProjectMembership
    from app.models.user import User

    nonce = uuid.uuid4().hex[:8]
    owner = User(
        clerk_id=f"o2_{nonce}",
        email=f"o2_{nonce}@test.dev",
        name="O2",
    )
    db_session.add(owner)
    await db_session.commit()
    shared = Project(
        user_id=owner.id,
        name="s2",
        slug=f"s2-{nonce}",
        kind=PROJECT_KIND_PERSONAL,
    )
    db_session.add(shared)
    await db_session.commit()
    db_session.add(
        ProjectMembership(
            project_id=shared.id,
            member_user_id=seed_user.id,
            role="viewer",
            joined_via="link",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="o2-5678",
        )
    )
    # Unbound CLI key — no environment_id.
    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash=("u" + nonce + "x" * (64 - len(nonce) - 1)),
        key_prefix=f"clawdi_{nonce[:4]}",
        label="unbound-cli",
        environment_id=None,
    )
    db_session.add(api_key)
    await db_session.commit()

    try:
        auth = AuthContext(user=seed_user, api_key=api_key)
        visible = await project_ids_visible_to(db_session, auth)
        assert seed_project.id in visible
        assert shared.id in visible
    finally:
        await db_session.delete(api_key)
        await db_session.delete(shared)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_env_bound_api_key_does_not_see_shared(db_session, seed_user, seed_project):
    """A deploy-key bound to env X must NEVER gain visibility to
    projects the user is a member of. The env binding is the blast-
    radius boundary (PR #77)."""
    from app.models.api_key import ApiKey
    from app.models.project import PROJECT_KIND_PERSONAL, Project
    from app.models.project_membership import ProjectMembership
    from app.models.user import User
    from tests.conftest import create_env_with_project

    nonce = uuid.uuid4().hex[:8]
    owner = User(
        clerk_id=f"o3_{nonce}",
        email=f"o3_{nonce}@test.dev",
        name="O3",
    )
    db_session.add(owner)
    await db_session.commit()
    shared = Project(
        user_id=owner.id,
        name="s3",
        slug=f"s3-{nonce}",
        kind=PROJECT_KIND_PERSONAL,
    )
    db_session.add(shared)
    await db_session.commit()
    db_session.add(
        ProjectMembership(
            project_id=shared.id,
            member_user_id=seed_user.id,
            role="viewer",
            joined_via="link",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="o3-9999",
        )
    )
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"visibility-{nonce}",
        machine_name="m",
    )
    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash=("e" + nonce + "x" * (64 - len(nonce) - 1)),
        key_prefix=f"clawdi_e{nonce[:3]}",
        label="agent-environment",
        environment_id=env.id,
        scopes=["sessions:write"],
    )
    db_session.add(api_key)
    await db_session.commit()

    try:
        auth = AuthContext(user=seed_user, api_key=api_key)
        visible = await project_ids_visible_to(db_session, auth)
        # Agent API key: ONLY the Agent Project.
        assert visible == [env.default_project_id]
        assert shared.id not in visible
        assert seed_project.id not in visible
    finally:
        await db_session.delete(api_key)
        await db_session.delete(env)
        await db_session.delete(shared)
        await db_session.delete(owner)
        await db_session.commit()
