"""End-to-end role-path coverage for project sharing + Agent Project use."""

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.main import app
from app.models.agent_project_binding import AgentProjectBinding
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.project_invitation import ProjectInvitation
from app.models.project_membership import ProjectMembership
from app.models.project_share_link import ProjectShareLink
from app.models.user import User
from app.models.vault import Vault, VaultItem
from app.services.sharing import generate_share_token, hash_share_token, resolve_owner_handle
from app.services.vault_crypto import encrypt
from tests.conftest import create_env_with_project

pytestmark = pytest.mark.asyncio


async def _owner_with_project(db_session: AsyncSession, *, name: str = "Alice"):
    nonce = uuid.uuid4().hex[:8]
    owner = User(
        clerk_id=f"owner_{nonce}",
        email=f"owner_{nonce}@test.dev",
        name=name,
    )
    db_session.add(owner)
    await db_session.flush()
    project = Project(
        user_id=owner.id,
        name=f"{name} Project",
        slug=f"{name.lower()}-{nonce}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(owner)
    await db_session.refresh(project)
    return owner, project


async def _client_for_user(
    db_session: AsyncSession,
    user: User,
) -> AsyncIterator[httpx.AsyncClient]:
    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=user)

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as ac:
            yield ac
    finally:
        app.dependency_overrides.clear()


async def test_inbox_accept_link_and_invitation_create_memberships(
    client,
    db_session,
    seed_user,
):
    owner, link_project = await _owner_with_project(db_session)
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"accept-{uuid.uuid4().hex[:8]}",
        machine_name="atlas",
    )
    raw = generate_share_token()
    db_session.add(
        ProjectShareLink(
            project_id=link_project.id,
            token_hash=hash_share_token(raw),
            token_prefix=raw[:8],
            created_by=owner.id,
            resolved_owner_handle=resolve_owner_handle(owner),
            created_at=datetime.now(UTC),
        )
    )
    invite_project = Project(
        user_id=owner.id,
        name="Invite Project",
        slug=f"invite-{uuid.uuid4().hex[:8]}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(invite_project)
    await db_session.flush()
    invitation = ProjectInvitation(
        project_id=invite_project.id,
        invitee_user_id=seed_user.id,
        invitee_email=seed_user.email or "seed@test.dev",
        invited_by=owner.id,
        resolved_owner_handle=resolve_owner_handle(owner),
        created_at=datetime.now(UTC),
    )
    db_session.add(invitation)
    await db_session.commit()
    invitation_id = invitation.id

    try:
        link_response = await client.post(
            f"/api/share/{raw}/upgrade",
            json={
                "agent_ids": [str(env.id)],
                "use_as": "attached",
            },
        )
        assert link_response.status_code == 200, link_response.text
        assert link_response.json()["project_id"] == str(link_project.id)
        assert link_response.json()["bound_agent_ids"] == [str(env.id)]

        invite_response = await client.post(f"/api/me/invitations/{invitation_id}/accept")
        assert invite_response.status_code == 200, invite_response.text
        assert invite_response.json()["project_id"] == str(invite_project.id)

        rows = (
            (
                await db_session.execute(
                    select(ProjectMembership).where(
                        ProjectMembership.member_user_id == seed_user.id,
                        ProjectMembership.project_id.in_([link_project.id, invite_project.id]),
                    )
                )
            )
            .scalars()
            .all()
        )
        assert {row.joined_via for row in rows} == {"link", "invite"}
        binding = (
            await db_session.execute(
                select(AgentProjectBinding).where(
                    AgentProjectBinding.agent_id == env.id,
                    AgentProjectBinding.project_id == link_project.id,
                    AgentProjectBinding.binding_type == "context",
                )
            )
        ).scalar_one_or_none()
        assert binding is not None
    finally:
        await db_session.delete(link_project)
        await db_session.delete(invite_project)
        await db_session.delete(owner)
        await db_session.commit()


async def test_agent_binding_list_materializes_default_primary_and_blocks_delete(
    client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"primary-{uuid.uuid4().hex[:8]}",
        machine_name="atlas",
    )

    listed = await client.get(f"/api/agents/{env.id}/project-bindings")
    assert listed.status_code == 200, listed.text
    rows = listed.json()
    assert len(rows) == 1
    assert rows[0]["binding_type"] == "primary"
    assert rows[0]["project_id"] == str(env.default_project_id)

    delete_primary = await client.delete(f"/api/agents/{env.id}/project-bindings/{rows[0]['id']}")
    assert delete_primary.status_code == 400


async def test_agent_binding_list_restores_default_primary_and_demotes_stale_primary(
    client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"stale-primary-{uuid.uuid4().hex[:8]}",
        machine_name="atlas",
    )
    workspace = Project(
        user_id=seed_user.id,
        name="Old Home",
        slug=f"old-home-{uuid.uuid4().hex[:8]}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(workspace)
    await db_session.flush()
    db_session.add(
        AgentProjectBinding(
            agent_id=env.id,
            project_id=workspace.id,
            binding_type="primary",
            priority=0,
            default_write_enabled=True,
            created_by_user_id=seed_user.id,
        )
    )
    await db_session.commit()

    listed = await client.get(f"/api/agents/{env.id}/project-bindings")
    assert listed.status_code == 200, listed.text
    rows = listed.json()
    primary_rows = [row for row in rows if row["binding_type"] == "primary"]
    context_rows = [row for row in rows if row["binding_type"] == "context"]
    assert [row["project_id"] for row in primary_rows] == [str(env.default_project_id)]
    assert str(workspace.id) in {row["project_id"] for row in context_rows}


async def test_agent_binding_attach_repairs_stale_primary_before_returning_context(
    client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"attach-stale-primary-{uuid.uuid4().hex[:8]}",
        machine_name="atlas",
    )
    workspace = Project(
        user_id=seed_user.id,
        name="Old Primary",
        slug=f"old-primary-{uuid.uuid4().hex[:8]}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(workspace)
    await db_session.flush()
    db_session.add(
        AgentProjectBinding(
            agent_id=env.id,
            project_id=workspace.id,
            binding_type="primary",
            priority=0,
            default_write_enabled=True,
            created_by_user_id=seed_user.id,
        )
    )
    await db_session.commit()

    response = await client.post(
        f"/api/agents/{env.id}/project-bindings/context",
        json={"project_id": str(workspace.id)},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["project_id"] == str(workspace.id)
    assert body["binding_type"] == "context"
    assert body["default_write_enabled"] is False

    rows = (
        (
            await db_session.execute(
                select(AgentProjectBinding).where(AgentProjectBinding.agent_id == env.id)
            )
        )
        .scalars()
        .all()
    )
    primary_rows = [row for row in rows if row.binding_type == "primary"]
    assert [row.project_id for row in primary_rows] == [env.default_project_id]


async def test_agent_context_attach_rejects_managed_projects(
    client,
    db_session,
    seed_user,
    seed_project,
    environment_project,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"reject-managed-{uuid.uuid4().hex[:8]}",
        machine_name="atlas",
    )

    for project in (seed_project, environment_project):
        response = await client.post(
            f"/api/agents/{env.id}/project-bindings/context",
            json={"project_id": str(project.id)},
        )
        assert response.status_code == 400, response.text
        assert "Only Custom Projects" in response.text


async def test_agent_binding_delete_repairs_stale_primary_before_detaching(
    client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"delete-stale-primary-{uuid.uuid4().hex[:8]}",
        machine_name="atlas",
    )
    workspace = Project(
        user_id=seed_user.id,
        name="Detached Primary",
        slug=f"detached-primary-{uuid.uuid4().hex[:8]}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(workspace)
    await db_session.flush()
    stale = AgentProjectBinding(
        agent_id=env.id,
        project_id=workspace.id,
        binding_type="primary",
        priority=0,
        default_write_enabled=True,
        created_by_user_id=seed_user.id,
    )
    db_session.add(stale)
    await db_session.flush()
    stale_id = stale.id
    await db_session.commit()

    response = await client.delete(f"/api/agents/{env.id}/project-bindings/{stale_id}")
    assert response.status_code == 200, response.text

    rows = (
        (
            await db_session.execute(
                select(AgentProjectBinding).where(AgentProjectBinding.agent_id == env.id)
            )
        )
        .scalars()
        .all()
    )
    assert all(row.project_id != workspace.id for row in rows)
    primary_rows = [row for row in rows if row.binding_type == "primary"]
    assert [row.project_id for row in primary_rows] == [env.default_project_id]


async def test_recipient_leave_removes_attached_agent_project(client, db_session, seed_user):
    owner, shared_project = await _owner_with_project(db_session)
    db_session.add(
        ProjectMembership(
            project_id=shared_project.id,
            member_user_id=seed_user.id,
            role="viewer",
            joined_via="link",
            joined_at=datetime.now(UTC),
            resolved_owner_handle=resolve_owner_handle(owner),
        )
    )
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"leave-{uuid.uuid4().hex[:8]}",
        machine_name="atlas",
    )
    db_session.add(
        AgentProjectBinding(
            agent_id=env.id,
            project_id=shared_project.id,
            binding_type="context",
            priority=1,
            default_write_enabled=False,
            created_by_user_id=seed_user.id,
        )
    )
    await db_session.commit()

    try:
        response = await client.post(f"/api/projects/{shared_project.id}/leave")
        assert response.status_code == 200, response.text
        assert response.json()["agent_bindings_removed"] == 1
        remaining = (
            await db_session.execute(
                select(AgentProjectBinding).where(
                    AgentProjectBinding.agent_id == env.id,
                    AgentProjectBinding.project_id == shared_project.id,
                )
            )
        ).scalar_one_or_none()
        assert remaining is None
    finally:
        await db_session.delete(shared_project)
        await db_session.delete(owner)
        await db_session.commit()


async def test_owner_unshare_removes_member_agent_context_binding(db_session, seed_user):
    owner, shared_project = await _owner_with_project(db_session)
    recipient = seed_user
    db_session.add(
        ProjectMembership(
            project_id=shared_project.id,
            member_user_id=recipient.id,
            role="viewer",
            joined_via="invite",
            joined_at=datetime.now(UTC),
            resolved_owner_handle=resolve_owner_handle(owner),
        )
    )
    env = await create_env_with_project(
        db_session,
        user_id=recipient.id,
        machine_id=f"unshare-{uuid.uuid4().hex[:8]}",
        machine_name="forge",
    )
    db_session.add(
        AgentProjectBinding(
            agent_id=env.id,
            project_id=shared_project.id,
            binding_type="context",
            priority=1,
            default_write_enabled=False,
            created_by_user_id=recipient.id,
        )
    )
    await db_session.commit()

    try:
        async for owner_client in _client_for_user(db_session, owner):
            response = await owner_client.post(f"/api/projects/{shared_project.id}/unshare")
        assert response.status_code == 200, response.text
        assert response.json()["members_removed"] == 1
        assert response.json()["agent_bindings_removed"] == 1
    finally:
        await db_session.delete(shared_project)
        await db_session.delete(owner)
        await db_session.commit()


async def test_context_reorder_can_swap_priorities(client, db_session, seed_user):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"reorder-{uuid.uuid4().hex[:8]}",
        machine_name="atlas",
    )
    projects = []
    for label in ("one", "two"):
        project = Project(
            user_id=seed_user.id,
            name=f"Project {label}",
            slug=f"{label}-{uuid.uuid4().hex[:8]}",
            kind=PROJECT_KIND_WORKSPACE,
        )
        db_session.add(project)
        projects.append(project)
    await db_session.commit()
    bindings = []
    for priority, project in enumerate(projects, start=1):
        row = AgentProjectBinding(
            agent_id=env.id,
            project_id=project.id,
            binding_type="context",
            priority=priority,
            default_write_enabled=False,
            created_by_user_id=seed_user.id,
        )
        db_session.add(row)
        bindings.append(row)
    await db_session.commit()

    response = await client.patch(
        f"/api/agents/{env.id}/project-bindings/context/reorder",
        json={
            "items": [
                {"binding_id": str(bindings[0].id), "priority": 2},
                {"binding_id": str(bindings[1].id), "priority": 1},
            ]
        },
    )
    assert response.status_code == 200, response.text

    rows = (
        (
            await db_session.execute(
                select(AgentProjectBinding).where(AgentProjectBinding.agent_id == env.id)
            )
        )
        .scalars()
        .all()
    )
    context_rows = [row for row in rows if row.binding_type == "context"]
    assert {str(row.id): row.priority for row in context_rows} == {
        str(bindings[0].id): 2,
        str(bindings[1].id): 1,
    }


async def test_agent_vault_resolve_blocks_and_allows_conflicts(cli_client, db_session, seed_user):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"vault-{uuid.uuid4().hex[:8]}",
        machine_name="atlas",
    )
    context_project = Project(
        user_id=seed_user.id,
        name="Context",
        slug=f"context-{uuid.uuid4().hex[:8]}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(context_project)
    await db_session.flush()
    db_session.add_all(
        [
            AgentProjectBinding(
                agent_id=env.id,
                project_id=env.default_project_id,
                binding_type="primary",
                priority=0,
                default_write_enabled=True,
                created_by_user_id=seed_user.id,
            ),
            AgentProjectBinding(
                agent_id=env.id,
                project_id=context_project.id,
                binding_type="context",
                priority=1,
                default_write_enabled=False,
                created_by_user_id=seed_user.id,
            ),
        ]
    )
    for project_id, value in (
        (env.default_project_id, "primary-secret"),
        (context_project.id, "context-secret"),
    ):
        vault = Vault(user_id=seed_user.id, project_id=project_id, slug="default", name="Default")
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

    blocked = await cli_client.post(
        f"/api/vault/resolve?key=OPENAI_API_KEY&agent_id={env.id}&debug=true"
    )
    assert blocked.status_code == 409, blocked.text
    assert blocked.json()["detail"]["code"] == "vault_conflicts_blocked"
    assert "value" not in blocked.json()["detail"]

    allowed = await cli_client.post(
        f"/api/vault/resolve?key=OPENAI_API_KEY&agent_id={env.id}&allow_conflicts=true&debug=true"
    )
    assert allowed.status_code == 200, allowed.text
    body = allowed.json()
    assert body["value"] == "primary-secret"
    assert body["source_binding_type"] == "primary"
    assert body["conflicts"][0]["binding_type"] == "context"


async def test_web_jwt_cannot_resolve_plaintext_vault(client):
    response = await client.post("/api/vault/resolve?key=OPENAI_API_KEY")
    assert response.status_code == 403
