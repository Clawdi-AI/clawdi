"""Sharee-facing /api/me/* routes for project invitations."""

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
from app.models.api_key import ApiKey
from app.models.project_invitation import ProjectInvitation
from app.models.project_membership import ProjectMembership
from app.services.sharing import resolve_owner_handle


async def _seed_owner_and_invite(db_session, invitee_user, *, name="Alice"):
    """Create an owner, a project, and an invite for `invitee_user`."""
    from app.models.project import PROJECT_KIND_ENVIRONMENT, Project
    from app.models.user import User

    nonce = uuid.uuid4().hex[:8]
    owner = User(
        clerk_id=f"o_{nonce}",
        email=f"o_{nonce}@test.dev",
        name=name,
    )
    db_session.add(owner)
    await db_session.commit()
    await db_session.refresh(owner)

    project = Project(
        user_id=owner.id,
        name=f"Owner Project {nonce}",
        slug=f"owner-project-{nonce}",
        kind=PROJECT_KIND_ENVIRONMENT,
    )
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    invitation = ProjectInvitation(
        project_id=project.id,
        invitee_user_id=invitee_user.id,
        invitee_email=invitee_user.email.lower() if invitee_user.email else "inv@x.dev",
        invited_by=owner.id,
        resolved_owner_handle=resolve_owner_handle(owner),
        created_at=datetime.now(UTC),
    )
    db_session.add(invitation)
    await db_session.commit()
    await db_session.refresh(invitation)
    return owner, project, invitation.id


@pytest.mark.asyncio
async def test_me_invitations_lists_only_addressed_to_me(client, db_session, seed_user):
    from app.models.project import PROJECT_KIND_ENVIRONMENT, Project
    from app.models.user import User

    owner, project, my_invitation_id = await _seed_owner_and_invite(db_session, seed_user)

    other_nonce = uuid.uuid4().hex[:8]
    other = User(
        clerk_id=f"oth_{other_nonce}",
        email=f"oth_{other_nonce}@test.dev",
        name="Other",
    )
    db_session.add(other)
    await db_session.commit()

    other_project = Project(
        user_id=owner.id,
        name="other-project",
        slug=f"other-project-{other_nonce}",
        kind=PROJECT_KIND_ENVIRONMENT,
    )
    db_session.add(other_project)
    await db_session.commit()

    db_session.add(
        ProjectInvitation(
            project_id=other_project.id,
            invitee_user_id=other.id,
            invitee_email=other.email,
            invited_by=owner.id,
            resolved_owner_handle=resolve_owner_handle(owner),
            created_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    try:
        response = await client.get("/api/me/invitations")
        assert response.status_code == 200, response.text
        items = response.json()
        ids = {item["id"] for item in items}
        assert str(my_invitation_id) in ids

        for item in items:
            assert item["invitee_email"] != other.email

        mine = next(item for item in items if item["id"] == str(my_invitation_id))
        assert mine["owner_display"] == owner.name
        assert mine["owner_handle"].startswith("alice-")
        assert mine["project_name"] == project.name
    finally:
        other_invitations = (
            (
                await db_session.execute(
                    select(ProjectInvitation).where(
                        ProjectInvitation.project_id == other_project.id
                    )
                )
            )
            .scalars()
            .all()
        )
        for row in other_invitations:
            await db_session.delete(row)

        my_invitations = (
            (
                await db_session.execute(
                    select(ProjectInvitation).where(
                        ProjectInvitation.invitee_user_id == seed_user.id
                    )
                )
            )
            .scalars()
            .all()
        )
        for row in my_invitations:
            await db_session.delete(row)

        await db_session.delete(other_project)
        await db_session.delete(project)
        await db_session.delete(other)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_accept_invitation_creates_membership(client, db_session, seed_user):
    owner, project, invitation_id = await _seed_owner_and_invite(db_session, seed_user)
    try:
        response = await client.post(f"/api/me/invitations/{invitation_id}/accept")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["project_id"] == str(project.id)
        assert body["role"] == "viewer"
        assert body["joined_via"] == "invite"
        assert body["resolved_owner_handle"].startswith("alice-")

        memberships = (
            (
                await db_session.execute(
                    select(ProjectMembership).where(
                        ProjectMembership.project_id == project.id,
                        ProjectMembership.member_user_id == seed_user.id,
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(memberships) == 1

        inbox = await client.get("/api/me/invitations")
        assert inbox.status_code == 200
        assert all(item["id"] != str(invitation_id) for item in inbox.json())
    finally:
        memberships = (
            (
                await db_session.execute(
                    select(ProjectMembership).where(
                        ProjectMembership.project_id == project.id,
                        ProjectMembership.member_user_id == seed_user.id,
                    )
                )
            )
            .scalars()
            .all()
        )
        for row in memberships:
            await db_session.delete(row)
        await db_session.delete(project)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_accept_invitation_uses_frozen_owner_handle(client, db_session, seed_user):
    owner, project, invitation_id = await _seed_owner_and_invite(db_session, seed_user)
    frozen_handle = resolve_owner_handle(owner)
    owner.name = None
    await db_session.commit()

    try:
        response = await client.post(f"/api/me/invitations/{invitation_id}/accept")
        assert response.status_code == 200, response.text
        assert response.json()["resolved_owner_handle"] == frozen_handle
    finally:
        memberships = (
            (
                await db_session.execute(
                    select(ProjectMembership).where(
                        ProjectMembership.project_id == project.id,
                        ProjectMembership.member_user_id == seed_user.id,
                    )
                )
            )
            .scalars()
            .all()
        )
        for row in memberships:
            await db_session.delete(row)
        await db_session.delete(project)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_decline_invitation_deletes_without_membership(client, db_session, seed_user):
    owner, project, invitation_id = await _seed_owner_and_invite(db_session, seed_user)
    try:
        response = await client.post(f"/api/me/invitations/{invitation_id}/decline")
        assert response.status_code == 200
        assert response.json()["status"] == "declined"

        inbox = await client.get("/api/me/invitations")
        assert inbox.status_code == 200
        assert all(item["id"] != str(invitation_id) for item in inbox.json())
    finally:
        leftover = (
            await db_session.execute(
                select(ProjectInvitation).where(ProjectInvitation.id == invitation_id)
            )
        ).scalar_one_or_none()
        if leftover is not None:
            await db_session.delete(leftover)
        await db_session.delete(project)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_env_bound_key_cannot_list_or_decline_invitations(db_session, seed_user):
    owner, project, invitation_id = await _seed_owner_and_invite(db_session, seed_user)
    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash="h" * 64,
        key_prefix="clawdi_e",
        label="env-bound",
        environment_id=uuid.uuid4(),
        scopes=None,
    )

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=api_key)

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as test_client:
            listed = await test_client.get("/api/me/invitations")
            assert listed.status_code == 403, listed.text

            declined = await test_client.post(f"/api/me/invitations/{invitation_id}/decline")
            assert declined.status_code == 403, declined.text
    finally:
        app.dependency_overrides.clear()
        leftover = (
            await db_session.execute(
                select(ProjectInvitation).where(ProjectInvitation.id == invitation_id)
            )
        ).scalar_one_or_none()
        assert leftover is not None
        await db_session.delete(leftover)
        await db_session.delete(project)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_accept_invitation_addressed_to_other_user_410(client, db_session, seed_user):
    from app.models.user import User

    nonce = uuid.uuid4().hex[:8]
    other = User(
        clerk_id=f"other_{nonce}",
        email=f"other_{nonce}@test.dev",
        name="Other",
    )
    db_session.add(other)
    await db_session.commit()

    owner, project, invitation_id = await _seed_owner_and_invite(db_session, other)
    try:
        response = await client.post(f"/api/me/invitations/{invitation_id}/accept")
        assert response.status_code == 410, response.text
    finally:
        rows = (
            (
                await db_session.execute(
                    select(ProjectInvitation).where(ProjectInvitation.project_id == project.id)
                )
            )
            .scalars()
            .all()
        )
        for row in rows:
            await db_session.delete(row)
        await db_session.delete(project)
        await db_session.delete(owner)
        await db_session.delete(other)
        await db_session.commit()
