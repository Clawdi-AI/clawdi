"""B.5 + B.6 coverage: invitation create / list / cancel.

Privacy posture: the create endpoint hard-404s when the email isn't
a registered clawdi account. We considered a "silent success even
for unregistered emails" pattern, but the user-facing copy is
clearer when we tell the owner to send a share-link instead — and
the failure shape is identical regardless of whether the registered
account belongs to a member already, so account-existence isn't
leaked across the 4xx boundary.
"""

import uuid

import pytest
from sqlalchemy import select

from app.models.project_invitation import ProjectInvitation


@pytest.mark.asyncio
async def test_invite_existing_user_creates_invitation(
    client, db_session, seed_user, seed_scope
):
    """Owner invites a registered user → 200 with response body
    carrying the scope+owner+invitee context the recipient's
    dashboard renders."""
    from app.models.user import User

    seed_user.name = "Alice"
    nonce = uuid.uuid4().hex[:8]
    invitee = User(
        clerk_id=f"invitee_{nonce}",
        email=f"invitee_{nonce}@test.dev",
        name="Bob",
    )
    db_session.add(invitee)
    await db_session.commit()
    await db_session.refresh(invitee)
    invitee_id = invitee.id

    try:
        r = await client.post(
            f"/api/projects/{seed_scope.id}/invitations",
            json={"email": invitee.email},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["invitee_email"] == invitee.email.lower()
        assert body["project_id"] == str(seed_scope.id)
        assert body["owner_handle"].startswith("alice-")
        # Verify via list endpoint (avoids cross-pool greenlet issue).
        listing = await client.get(f"/api/projects/{seed_scope.id}/invitations")
        assert listing.status_code == 200
        items = listing.json()
        assert any(it["invitee_email"] == invitee.email.lower() for it in items)
    finally:
        # CASCADE delete: invitation FK → invitee user.
        # Delete invitation first to avoid orphan-row checks.
        rows = (
            await db_session.execute(
                select(ProjectInvitation).where(
                    ProjectInvitation.invitee_user_id == invitee_id
                )
            )
        ).scalars().all()
        for inv in rows:
            await db_session.delete(inv)
        await db_session.delete(invitee)
        await db_session.commit()


@pytest.mark.asyncio
async def test_invite_unregistered_email_returns_404(client, seed_user, seed_scope):
    """No matching User row → 404 user_not_found. The dialog copy
    points the owner at the share-link path instead."""
    seed_user.name = "Alice"
    r = await client.post(
        f"/api/projects/{seed_scope.id}/invitations",
        json={"email": f"ghost_{uuid.uuid4().hex[:8]}@nowhere.test"},
    )
    assert r.status_code == 404
    assert r.json()["detail"]["error"] == "user_not_found"


@pytest.mark.asyncio
async def test_invite_self_rejected(client, seed_user, seed_scope):
    """You can't invite your own email — already the owner."""
    seed_user.name = "Alice"
    r = await client.post(
        f"/api/projects/{seed_scope.id}/invitations",
        json={"email": seed_user.email},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "already_owner"


@pytest.mark.asyncio
async def test_invite_existing_pending_409(client, db_session, seed_user, seed_scope):
    """Second invite to the same user → 409 already_invited
    (FK uniqueness on (scope_id, invitee_user_id))."""
    from app.models.user import User

    seed_user.name = "Alice"
    nonce = uuid.uuid4().hex[:8]
    invitee = User(
        clerk_id=f"dup_{nonce}",
        email=f"dup_{nonce}@test.dev",
        name="Dup",
    )
    db_session.add(invitee)
    await db_session.commit()
    invitee_id = invitee.id
    try:
        first = await client.post(
            f"/api/projects/{seed_scope.id}/invitations",
            json={"email": invitee.email},
        )
        assert first.status_code == 200, first.text
        second = await client.post(
            f"/api/projects/{seed_scope.id}/invitations",
            json={"email": invitee.email},
        )
        assert second.status_code == 409
        assert second.json()["detail"]["error"] == "already_invited"
    finally:
        rows = (
            await db_session.execute(
                select(ProjectInvitation).where(
                    ProjectInvitation.invitee_user_id == invitee_id
                )
            )
        ).scalars().all()
        for inv in rows:
            await db_session.delete(inv)
        await db_session.delete(invitee)
        await db_session.commit()


@pytest.mark.asyncio
async def test_list_then_cancel_invitation(client, db_session, seed_user, seed_scope):
    """Create → list → cancel → re-list shows it gone."""
    from app.models.user import User

    seed_user.name = "Alice"
    nonce = uuid.uuid4().hex[:8]
    invitee = User(
        clerk_id=f"li_{nonce}",
        email=f"li_{nonce}@test.dev",
        name="Listed",
    )
    db_session.add(invitee)
    await db_session.commit()
    invitee_id = invitee.id
    try:
        created = await client.post(
            f"/api/projects/{seed_scope.id}/invitations",
            json={"email": invitee.email},
        )
        assert created.status_code == 200
        inv_id = created.json()["id"]

        listing = await client.get(f"/api/projects/{seed_scope.id}/invitations")
        assert listing.status_code == 200
        assert any(it["id"] == inv_id for it in listing.json())

        cancel = await client.delete(
            f"/api/projects/{seed_scope.id}/invitations/{inv_id}"
        )
        assert cancel.status_code == 200
        assert cancel.json()["status"] == "cancelled"

        relist = await client.get(f"/api/projects/{seed_scope.id}/invitations")
        assert relist.status_code == 200
        assert all(it["id"] != inv_id for it in relist.json())
    finally:
        rows = (
            await db_session.execute(
                select(ProjectInvitation).where(
                    ProjectInvitation.invitee_user_id == invitee_id
                )
            )
        ).scalars().all()
        for inv in rows:
            await db_session.delete(inv)
        await db_session.delete(invitee)
        await db_session.commit()


@pytest.mark.asyncio
async def test_cancel_unknown_invitation_404(client, seed_user, seed_scope):
    seed_user.name = "Alice"
    r = await client.delete(
        f"/api/projects/{seed_scope.id}/invitations/00000000-0000-0000-0000-000000000000"
    )
    assert r.status_code == 404
