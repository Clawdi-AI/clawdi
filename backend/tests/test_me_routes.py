"""Sharee-facing /api/me/* routes — invitations inbox + accept/decline.

The `client` fixture in conftest is authed as seed_user; tests
create a separate owner + scope + invitation pointing AT seed_user
so the accept/decline path runs through the realistic cross-user
shape.
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app.models.scope_invitation import ScopeInvitation
from app.models.scope_membership import ScopeMembership


async def _seed_owner_and_invite(db_session, invitee_user, *, name="Alice"):
    """Helper: create an owner with `name`, a scope, and a pending
    invitation to `invitee_user`. Returns (owner, scope, invitation_id)."""
    from app.models.scope import Scope
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

    # Use `environment` kind to avoid the
    # `uq_scopes_one_personal_per_user` constraint — a personal
    # scope is auto-created alongside each User.
    from app.models.scope import SCOPE_KIND_ENVIRONMENT

    scope = Scope(
        user_id=owner.id,
        name=f"Owner's Scope {nonce}",
        slug=f"owner-scope-{nonce}",
        kind=SCOPE_KIND_ENVIRONMENT,
    )
    db_session.add(scope)
    await db_session.commit()
    await db_session.refresh(scope)

    inv = ScopeInvitation(
        scope_id=scope.id,
        invitee_user_id=invitee_user.id,
        invitee_email=invitee_user.email.lower() if invitee_user.email else "inv@x.dev",
        invited_by=owner.id,
        created_at=datetime.now(UTC),
    )
    db_session.add(inv)
    await db_session.commit()
    await db_session.refresh(inv)
    return owner, scope, inv.id


@pytest.mark.asyncio
async def test_me_invitations_lists_only_addressed_to_me(
    client, db_session, seed_user
):
    """Seed_user has email set in conftest; an invitation pointing at
    a DIFFERENT user must not appear in seed_user's inbox."""
    from app.models.scope import Scope
    from app.models.user import User

    owner, scope, my_inv_id = await _seed_owner_and_invite(db_session, seed_user)

    # Inject a parallel invitation pointing at someone else.
    other_nonce = uuid.uuid4().hex[:8]
    other = User(
        clerk_id=f"oth_{other_nonce}",
        email=f"oth_{other_nonce}@test.dev",
        name="Other",
    )
    db_session.add(other)
    await db_session.commit()
    from app.models.scope import SCOPE_KIND_ENVIRONMENT as _SECOND_KIND

    other_scope = Scope(
        user_id=owner.id,
        name="other-scope",
        slug=f"other-scope-{other_nonce}",
        kind=_SECOND_KIND,
    )
    db_session.add(other_scope)
    await db_session.commit()
    db_session.add(
        ScopeInvitation(
            scope_id=other_scope.id,
            invitee_user_id=other.id,
            invitee_email=other.email,
            invited_by=owner.id,
            created_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    try:
        r = await client.get("/api/me/invitations")
        assert r.status_code == 200, r.text
        items = r.json()
        ids = {it["id"] for it in items}
        assert str(my_inv_id) in ids
        # Other user's invitation must NOT leak.
        for it in items:
            assert it["invitee_email"] != other.email
        # owner_display + owner_handle hydrated, not just IDs.
        mine = next(it for it in items if it["id"] == str(my_inv_id))
        assert mine["owner_display"] == owner.name
        assert mine["owner_handle"].startswith("alice-")
        assert mine["scope_name"] == scope.name
    finally:
        # Clean up parallel data
        other_invs = (
            await db_session.execute(
                select(ScopeInvitation).where(ScopeInvitation.scope_id == other_scope.id)
            )
        ).scalars().all()
        for x in other_invs:
            await db_session.delete(x)
        await db_session.delete(other_scope)
        await db_session.delete(other)
        # And the primary one
        my_invs = (
            await db_session.execute(
                select(ScopeInvitation).where(ScopeInvitation.invitee_user_id == seed_user.id)
            )
        ).scalars().all()
        for x in my_invs:
            await db_session.delete(x)
        await db_session.delete(scope)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_accept_invitation_creates_membership(client, db_session, seed_user):
    """POST accept → membership row with role=viewer, joined_via=invite,
    invitation row deleted, frozen owner_handle stamped."""
    owner, scope, inv_id = await _seed_owner_and_invite(db_session, seed_user)
    try:
        r = await client.post(f"/api/me/invitations/{inv_id}/accept")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["scope_id"] == str(scope.id)
        assert body["role"] == "viewer"
        assert body["joined_via"] == "invite"
        assert body["resolved_owner_handle"].startswith("alice-")

        # Invitation row gone.

        # Verify via listing endpoint (no cross-pool greenlet issue).
        inbox = await client.get("/api/me/invitations")
        assert inbox.status_code == 200
        assert all(it["id"] != str(inv_id) for it in inbox.json())
    finally:
        # Clean up membership + remaining scope/owner.
        memberships = (
            await db_session.execute(
                select(ScopeMembership).where(
                    ScopeMembership.scope_id == scope.id,
                    ScopeMembership.user_id == seed_user.id,
                )
            )
        ).scalars().all()
        for m in memberships:
            await db_session.delete(m)
        await db_session.delete(scope)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_decline_invitation_deletes_without_membership(
    client, db_session, seed_user
):
    """Decline removes the pending row; no membership ever appears."""
    owner, scope, inv_id = await _seed_owner_and_invite(db_session, seed_user)
    try:
        r = await client.post(f"/api/me/invitations/{inv_id}/decline")
        assert r.status_code == 200
        assert r.json()["status"] == "declined"

        # Inbox no longer has the row.
        inbox = await client.get("/api/me/invitations")
        assert all(it["id"] != str(inv_id) for it in inbox.json())
    finally:
        # Belt & suspenders cleanup
        leftover = (
            await db_session.execute(
                select(ScopeInvitation).where(ScopeInvitation.id == inv_id)
            )
        ).scalar_one_or_none()
        if leftover is not None:
            await db_session.delete(leftover)
        await db_session.delete(scope)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_accept_invitation_addressed_to_other_user_410(
    client, db_session, seed_user
):
    """Cross-user attempt: A invites B, but C tries to accept B's
    invitation → 410 invitation not available (privacy-safe: same
    response shape as not-found)."""
    from app.models.user import User

    nonce = uuid.uuid4().hex[:8]
    other = User(
        clerk_id=f"other_{nonce}",
        email=f"other_{nonce}@test.dev",
        name="Other",
    )
    db_session.add(other)
    await db_session.commit()
    owner, scope, inv_id = await _seed_owner_and_invite(db_session, other)
    try:
        # `client` is authed as seed_user — invitation points at `other`.
        r = await client.post(f"/api/me/invitations/{inv_id}/accept")
        assert r.status_code == 410, r.text
    finally:
        # Clean
        rows = (
            await db_session.execute(
                select(ScopeInvitation).where(ScopeInvitation.scope_id == scope.id)
            )
        ).scalars().all()
        for x in rows:
            await db_session.delete(x)
        await db_session.delete(scope)
        await db_session.delete(owner)
        await db_session.delete(other)
        await db_session.commit()
