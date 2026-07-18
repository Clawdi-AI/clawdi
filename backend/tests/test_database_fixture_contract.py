"""Contracts for the PostgreSQL application-test fixture architecture."""

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.auth import get_auth
from app.main import app
from app.models.user import User
from tests.conftest import _dependency_overrides, rollback_session, worker_test_identity

pytestmark = pytest.mark.asyncio


async def test_commit_inside_test_remains_usable(db_session: AsyncSession):
    user = User(clerk_id="fixture-commit", email="fixture-commit@example.test")
    db_session.add(user)
    await db_session.commit()

    assert await db_session.get(User, user.id) is user


async def test_application_commit_is_hidden_from_independent_connection(
    engine, db_session: AsyncSession
):
    user = User(clerk_id="fixture-hidden", email="fixture-hidden@example.test")
    db_session.add(user)
    await db_session.commit()

    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as observer:
        visible = await observer.scalar(select(User.id).where(User.clerk_id == user.clerk_id))

    assert visible is None


async def test_rollback_session_cleans_up_after_exception(engine):
    clerk_id = "fixture-exception"
    with pytest.raises(RuntimeError, match="fixture failure"):
        async with rollback_session(engine) as session:
            session.add(User(clerk_id=clerk_id, email="fixture-exception@example.test"))
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
    clerk_id = "fixture-committed-lane"
    user = User(clerk_id=clerk_id, email="fixture-committed-lane@example.test")
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
