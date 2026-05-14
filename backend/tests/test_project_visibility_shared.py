"""project_ids_visible_to widens to include shared memberships for
Clerk JWT + unbound-CLI callers. Env-bound api_keys keep their
single-project ceiling regardless of memberships (deploy-key blast
radius boundary)."""

import uuid
from datetime import UTC, datetime

import pytest

from app.core.auth import AuthContext
from app.core.project import project_ids_visible_to


@pytest.mark.asyncio
async def test_clerk_jwt_sees_owned_and_shared_scopes(db_session, seed_user, seed_project):
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
        label="env-bound",
        environment_id=env.id,
        projects=["sessions:write"],
    )
    db_session.add(api_key)
    await db_session.commit()

    try:
        auth = AuthContext(user=seed_user, api_key=api_key)
        visible = await project_ids_visible_to(db_session, auth)
        # Env-bound: ONLY the bound env's default project.
        assert visible == [env.default_project_id]
        assert shared.id not in visible
        assert seed_project.id not in visible
    finally:
        await db_session.delete(api_key)
        await db_session.delete(env)
        await db_session.delete(shared)
        await db_session.delete(owner)
        await db_session.commit()
