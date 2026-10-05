"""Contracts for the PostgreSQL application-test fixture architecture."""

from datetime import UTC, datetime, timedelta
from inspect import unwrap
from uuid import uuid4

import pytest
from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.auth import get_auth
from app.main import app
from app.models.channel import ChannelAccount, ChannelWhatsAppOnboardingSession
from app.models.user import User
from tests.conftest import _dependency_overrides, rollback_session, worker_test_identity
from tests.conftest import seed_user as seed_user_fixture

pytestmark = pytest.mark.asyncio


async def test_commit_inside_test_remains_usable(db_session: AsyncSession):
    nonce = uuid4().hex
    user = User(clerk_id=f"fixture-commit-{nonce}", email=f"fixture-commit-{nonce}@example.test")
    db_session.add(user)
    await db_session.commit()

    assert await db_session.get(User, user.id) is user


async def test_application_commit_is_hidden_from_independent_connection(
    engine, db_session: AsyncSession
):
    nonce = uuid4().hex
    user = User(clerk_id=f"fixture-hidden-{nonce}", email=f"fixture-hidden-{nonce}@example.test")
    db_session.add(user)
    await db_session.commit()

    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as observer:
        visible = await observer.scalar(select(User.id).where(User.clerk_id == user.clerk_id))

    assert visible is None


async def test_rollback_session_cleans_up_after_exception(engine):
    nonce = uuid4().hex
    clerk_id = f"fixture-exception-{nonce}"
    with pytest.raises(RuntimeError, match="fixture failure"):
        async with rollback_session(engine) as session:
            session.add(User(clerk_id=clerk_id, email=f"fixture-exception-{nonce}@example.test"))
            await session.commit()
            raise RuntimeError("fixture failure")

    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as observer:
        assert await observer.scalar(select(User.id).where(User.clerk_id == clerk_id)) is None


async def test_dependency_overrides_restore_nested_snapshots():
    original = dict(app.dependency_overrides)

    async def outer_override():
        return "outer"

    async def inner_override():
        return "inner"

    with _dependency_overrides({get_auth: outer_override}):
        assert app.dependency_overrides[get_auth] is outer_override
        with _dependency_overrides({get_auth: inner_override}):
            assert app.dependency_overrides[get_auth] is inner_override
        assert app.dependency_overrides[get_auth] is outer_override

    assert app.dependency_overrides == original


async def test_worker_identity_is_stable_and_worker_isolated():
    nodeid = "tests/test_example.py::test_case[param]"

    assert worker_test_identity(nodeid, "gw0") == worker_test_identity(nodeid, "gw0")
    assert worker_test_identity(nodeid, "gw0") != worker_test_identity(nodeid, "gw1")


async def test_committed_lane_is_visible_to_independent_connections(
    engine, committed_db_session: AsyncSession
):
    nonce = uuid4().hex
    clerk_id = f"fixture-committed-lane-{nonce}"
    user = User(clerk_id=clerk_id, email=f"fixture-committed-lane-{nonce}@example.test")
    committed_db_session.add(user)
    await committed_db_session.commit()

    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with sessionmaker() as observer:
            visible_id = await observer.scalar(select(User.id).where(User.clerk_id == clerk_id))
            assert visible_id == user.id
    finally:
        await committed_db_session.delete(user)
        await committed_db_session.commit()


@pytest.mark.committed_db
async def test_committed_user_cleanup_preserves_other_workers_platform_rows(
    engine, committed_db_session: AsyncSession, test_identity: str, request: pytest.FixtureRequest
):
    fixture = unwrap(seed_user_fixture)(committed_db_session, test_identity, request)
    user = await anext(fixture)
    user_id = user.id
    now = datetime.now(UTC)
    rows = [
        (
            ChannelAccount,
            {
                "provider": "telegram",
                "visibility": "private",
                "user_id": user_id,
                "webhook_secret_hash": "a" * 64,
            },
        ),
        (
            ChannelWhatsAppOnboardingSession,
            {
                "ownership_kind": "platform",
                "sidecar_account_id": uuid4(),
                "sidecar_config_revision": "test",
                "request_id": uuid4(),
                "state": "pending",
                "started_at": now,
                "expires_at": now + timedelta(minutes=5),
            },
        ),
    ]
    own_ids, foreign_ids = [uuid4() for _ in rows], [uuid4() for _ in rows]
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    try:
        # This test's HTTP routes can also insert through independent ORM sessions.
        async with sessionmaker() as writer:
            own_rows = [
                model(id=row_id, name=f"own-{row_id}", **values)
                for (model, values), row_id in zip(rows, own_ids, strict=True)
            ]
            writer.add_all(own_rows)
            await writer.flush()
            for row in own_rows:
                if isinstance(row, ChannelAccount):
                    row.user_id = None
                    row.visibility = "public"
            await writer.commit()
        # Core inserts represent an xdist worker outside this process's ORM hooks.
        async with engine.begin() as foreign_worker:
            for (model, values), row_id in zip(rows, foreign_ids, strict=True):
                foreign_values = dict(values)
                if model is ChannelAccount:
                    foreign_values.update(visibility="public", user_id=None)
                else:
                    foreign_values.update(sidecar_account_id=uuid4(), request_id=uuid4())
                await foreign_worker.execute(
                    insert(model).values(id=row_id, name=f"foreign-{row_id}", **foreign_values)
                )
        await fixture.aclose()
        async with sessionmaker() as observer:
            assert await observer.get(User, user_id) is None
            for (model, _), own_id, foreign_id in zip(rows, own_ids, foreign_ids, strict=True):
                assert await observer.get(model, own_id) is None
                assert await observer.get(model, foreign_id) is not None
    finally:
        await fixture.aclose()
        async with engine.begin() as cleanup:
            for (model, _), own_id, foreign_id in zip(rows, own_ids, foreign_ids, strict=True):
                await cleanup.execute(delete(model).where(model.id.in_([own_id, foreign_id])))
