"""Clerk authentication owns bootstrap commits and retains transaction fences."""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime

import httpx
import jwt
import pytest
from fastapi import HTTPException
from sqlalchemy import delete, event, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.auth import _auth_via_clerk_jwt
from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.principal_lifecycle import ClerkPrincipalSuspension, PrincipalLifecycle
from app.models.user import User
from app.services.principal_lifecycle import (
    fence_clerk_user_deleted,
    load_clerk_user_for_issuer,
    set_clerk_principal_suspension,
)
from tests.test_auth_jwt_backfill import _rsa_keypair

pytestmark = [pytest.mark.asyncio, pytest.mark.committed_db]
_ISSUER = "https://auth-transactions.clerk.example.test"


@pytest.fixture
def sign_jwt(monkeypatch):
    private_key, public_key = _rsa_keypair()
    monkeypatch.setattr(settings, "clerk_pem_public_key", public_key)
    monkeypatch.setattr(settings, "clerk_jwt_issuer", _ISSUER)
    monkeypatch.setattr(settings, "dev_auth_bypass", False)
    monkeypatch.setattr(settings, "enable_snapshot_email_rebind", False)

    def sign(subject, *, issuer=_ISSUER, **claims):
        payload = {"sub": subject, **claims}
        if issuer is not None:
            payload["iss"] = issuer
        return jwt.encode(payload, private_key, algorithm="RS256")

    return sign


@contextmanager
def capture_sql(engine) -> Iterator[list[str]]:
    statements = []

    def capture(_connection, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    def capture_commit(_connection):
        statements.append("COMMIT")

    event.listen(engine.sync_engine, "before_cursor_execute", capture)
    event.listen(engine.sync_engine, "commit", capture_commit)
    try:
        yield statements
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", capture)
        event.remove(engine.sync_engine, "commit", capture_commit)


@pytest.mark.parametrize("backfill", [False, True])
async def test_projects_read_persists_issuer_without_repeated_writes(
    engine, db_session, seed_user, sign_jwt, backfill
):
    user_id = seed_user.id
    claims = {}
    if backfill:
        seed_user.email = None
        seed_user.name = None
        claims = {"email": "backfill@example.test", "name": "Backfilled"}
    await db_session.commit()
    token = sign_jwt(seed_user.clerk_id, **claims)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def request_session():
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = request_session
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        for first_request in (True, False):
            with capture_sql(engine) as statements:
                response = await client.get(
                    "/v1/projects", headers={"Authorization": f"Bearer {token}"}
                )
            assert response.status_code == 200, response.text
            assert any(project["slug"] == "personal" for project in response.json())
            updates = [sql for sql in statements if sql.startswith("UPDATE users ")]
            assert sum("clerk_issuer=" in sql for sql in updates) == int(first_request)
            assert statements.count("COMMIT") == int(first_request)
            if not first_request:
                assert not updates
                assert not any("FOR UPDATE" in sql for sql in statements)
            async with factory() as observer:
                persisted = await observer.get(User, user_id)
                assert persisted.clerk_issuer == _ISSUER
                if backfill:
                    assert persisted.email == claims["email"]
                    assert persisted.name == claims["name"]


@pytest.mark.parametrize("legacy", [False, True])
async def test_auth_retains_both_fences_without_redundant_unchanged_reads(
    engine, db_session, seed_user, sign_jwt, legacy
):
    seed_user.clerk_issuer = None if legacy else _ISSUER
    await db_session.commit()
    token = sign_jwt(seed_user.clerk_id)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        with capture_sql(engine) as statements:
            auth = await _auth_via_clerk_jwt(token, session)
        assert auth is not None and auth.user_id == seed_user.id
        if legacy:
            assert statements.count("COMMIT") == 1
        else:
            # Count only established-user auth, excluding request/fixture SQL.
            assert len(statements) == 7
            assert all(sql.startswith("SELECT ") for sql in statements)
            assert sum("pg_advisory_xact_lock_shared" in sql for sql in statements) == 2
        pid = await session.scalar(text("SELECT pg_backend_pid()"))
        async with factory() as observer:
            assert (
                await observer.scalar(
                    text(
                        "SELECT count(*) FROM pg_locks WHERE pid=:pid AND locktype='advisory' "
                        "AND mode='ShareLock' AND granted"
                    ),
                    {"pid": pid},
                )
                == 2
            )
    async with factory() as observer:
        assert (
            await observer.scalar(
                text("SELECT count(*) FROM pg_locks WHERE pid=:pid AND locktype='advisory'"),
                {"pid": pid},
            )
            == 0
        )


@pytest.mark.parametrize(
    "mutation", ["issuer", "backfill", "avatar", "rebind", "create", "rollback"]
)
@pytest.mark.parametrize("fence", ["suspension", "termination"])
async def test_auth_rechecks_fences_after_mutation_transaction_ends(
    engine, db_session, seed_user, sign_jwt, monkeypatch, mutation, fence
):
    original_subject = seed_user.clerk_id
    subject = original_subject
    seed_user.clerk_issuer = None if mutation == "issuer" else _ISSUER
    claims = {}
    if mutation in {"backfill", "rollback"}:
        seed_user.email = None
        claims["email"] = "backfill@example.test"
    elif mutation == "avatar":
        claims["picture"] = "https://example.test/new-avatar.png"
    elif mutation in {"rebind", "create"}:
        subject = f"{original_subject}-new"
        if mutation == "rebind":
            monkeypatch.setattr(settings, "enable_snapshot_email_rebind", True)
            claims["email"] = seed_user.email
    await db_session.commit()
    factory = async_sessionmaker(engine, expire_on_commit=False)
    fenced = False

    async def install_fence():
        nonlocal fenced
        async with factory() as writer:
            # These real lifecycle mutations need exclusive principal/user locks.
            # A timeout would expose a retained pre-commit authentication fence.
            await writer.execute(text("SET LOCAL lock_timeout='1s'"))
            if fence == "suspension":
                await set_clerk_principal_suspension(
                    writer,
                    issuer=_ISSUER,
                    subject=subject,
                    suspended=True,
                    reason="auth_transaction_test",
                )
            else:
                await fence_clerk_user_deleted(
                    writer,
                    issuer=_ISSUER,
                    subject=subject,
                    message_id=f"auth-transaction-{subject}",
                    payload_sha256="a" * 64,
                    event_occurred_at=datetime.now(UTC),
                )
            await writer.commit()
        fenced = True

    try:
        async with factory() as session:
            original_commit = session.commit
            original_rollback = session.rollback

            async def commit_then_fence():
                if mutation == "rollback":
                    raise IntegrityError("test concurrent backfill", {}, Exception("conflict"))
                await original_commit()
                await install_fence()

            async def rollback_then_fence():
                await original_rollback()
                await install_fence()

            monkeypatch.setattr(session, "commit", commit_then_fence)
            if mutation == "rollback":
                monkeypatch.setattr(session, "rollback", rollback_then_fence)
            with pytest.raises(HTTPException) as failure:
                await _auth_via_clerk_jwt(sign_jwt(subject, **claims), session)
            assert failure.value.status_code == 401
            assert fenced
    finally:
        async with factory() as cleanup:
            await cleanup.execute(
                delete(ClerkPrincipalSuspension).where(
                    ClerkPrincipalSuspension.issuer == _ISSUER,
                    ClerkPrincipalSuspension.subject == subject,
                )
            )
            await cleanup.execute(
                delete(PrincipalLifecycle).where(
                    PrincipalLifecycle.issuer == _ISSUER,
                    PrincipalLifecycle.subject == subject,
                )
            )
            if mutation == "create":
                await cleanup.execute(delete(User).where(User.clerk_id == subject))
            await cleanup.commit()


@pytest.mark.parametrize(
    ("mode", "winner", "accepted"),
    [
        ("bootstrap", "different", False),
        ("bootstrap", "unbound", False),
        ("bootstrap", "matching", True),
        ("bootstrap", "deleted", False),
        ("backfill", "matching", True),
        ("legacy", "unbound", True),
        ("legacy", "deleted", False),
    ],
)
async def test_auth_rollback_accepts_only_a_compatible_persisted_winner(
    engine, db_session, seed_user, sign_jwt, monkeypatch, mode, winner, accepted
):
    subject, user_id = seed_user.clerk_id, seed_user.id
    seed_user.clerk_issuer = _ISSUER if mode == "backfill" else None
    seed_user.email = None
    await db_session.commit()
    if mode == "legacy":
        monkeypatch.setattr(settings, "clerk_jwt_issuer", "")
    token = sign_jwt(
        subject, issuer=None if mode == "legacy" else _ISSUER, email="loser@example.test"
    )
    factory = async_sessionmaker(engine, expire_on_commit=False)
    winner_issuer = (
        "https://other.clerk.example.test"
        if winner == "different"
        else _ISSUER
        if winner == "matching"
        else None
    )
    async with factory() as session:
        original_rollback = session.rollback

        async def fail_commit():
            raise IntegrityError("test competing bootstrap", {}, Exception("conflict"))

        async def rollback_then_persist_winner():
            await original_rollback()
            async with factory() as writer:
                await writer.execute(text("SET LOCAL lock_timeout='1s'"))
                if winner == "deleted":
                    await writer.execute(delete(User).where(User.id == user_id))
                else:
                    winning_user = (
                        await load_clerk_user_for_issuer(
                            writer, issuer=winner_issuer, subject=subject, bind_legacy=True
                        )
                        if winner_issuer is not None
                        else await writer.get(User, user_id)
                    )
                    assert winning_user is not None
                    winning_user.email = "winner@example.test"
                await writer.commit()

        monkeypatch.setattr(session, "commit", fail_commit)
        monkeypatch.setattr(session, "rollback", rollback_then_persist_winner)
        if accepted:
            auth = await _auth_via_clerk_jwt(token, session)
            assert auth is not None and auth.user_id == user_id
            assert auth.user.email == "winner@example.test"
            assert auth.user.clerk_issuer == winner_issuer
        else:
            with pytest.raises(HTTPException) as failure:
                await _auth_via_clerk_jwt(token, session)
            assert failure.value.status_code == 401
            assert failure.value.detail == "Invalid account identity"
        assert not session.dirty
    async with factory() as observer:
        persisted = await observer.get(User, user_id)
        if winner == "deleted":
            assert persisted is None
        else:
            assert persisted is not None
            assert persisted.clerk_issuer == winner_issuer
            assert persisted.email == "winner@example.test"
