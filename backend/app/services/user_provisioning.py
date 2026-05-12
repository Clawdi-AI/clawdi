"""Shared lazy-create flow for `users` + their Personal scope.

Two callers hit this code path:
1. `_auth_via_clerk_jwt` (auth.py) — first login from cloud.clawdi.ai
   directly. Has email/name from the JWT, commits at the end.
2. `_resolve_or_create_user` (admin.py) — first interaction is via
   the SaaS admin endpoint (clawdi.ai → cloud-api), before the user
   has ever signed in directly. No email/name in scope.

Pre-extraction both paths reimplemented:
- race-safe User insert (clerk_id unique constraint),
- Personal scope insert with its own defensive try/except,
- log-on-failure paths.

The race semantics and scope invariant MUST stay identical across
callers — downstream resolvers assume every user has a Personal
scope. Centralizing here means there's one place to maintain that
contract.
"""

import logging

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.scope import SCOPE_KIND_PERSONAL, Scope
from app.models.user import User

logger = logging.getLogger(__name__)


async def lazy_create_user_with_personal_scope(
    db: AsyncSession,
    *,
    clerk_id: str,
    email: str | None,
    name: str | None,
    avatar_url: str | None = None,
    race_loser_status: int,
) -> User:
    """Insert a User row + Personal scope for `clerk_id`, race-safe.

    Args:
        db: open session. Caller MUST `commit()` after — the helper
            leaves the rows flushed but not committed so caller can
            bundle other writes (admin endpoints add ApiKey / env in
            the same txn; auth.py commits after refresh).
        clerk_id: Clerk user id; must be already-authenticated by
            the caller's context (JWT verify or X-Admin-Key trust).
        email / name / avatar_url: identity fields if the caller has
            them. The admin path leaves them None; the JWT path
            forwards whatever Clerk handed it. Backfill of admin-
            created rows happens later in `_auth_via_clerk_jwt`'s
            backfill branch.
        race_loser_status: HTTP status code to raise if the concurrent-
            create race produces a winner row that then vanishes (a
            pathological case — would require a concurrent delete).
            JWT path passes 401 (fail-closed for the user's session);
            admin path passes 500 (operational anomaly the SaaS caller
            should surface differently).

    Returns:
        The freshly-inserted User row, OR the winner's row if a
        concurrent insert raced ahead. Personal scope is present in
        either case (the winner created its own).

    Raises:
        HTTPException with `race_loser_status` — race winner row not
        findable after rollback (concurrent delete or programming
        error). Treat as fatal.
        HTTPException 500 — Personal scope insert failed. Bizarre
        states only (partial unique index, mid-flush connection drop).
    """
    new_user = User(clerk_id=clerk_id, email=email, name=name, avatar_url=avatar_url)
    db.add(new_user)

    # User flush: the ONLY racy point. `users.clerk_id` is unique, so
    # two concurrent first-touches for the same clerk_id race here.
    # Loser rolls back, re-queries by clerk_id, and adopts whatever
    # the winner committed.
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        target = (
            await db.execute(select(User).where(User.clerk_id == clerk_id))
        ).scalar_one_or_none()
        if target is None:
            raise HTTPException(
                race_loser_status,
                "could not create or load user",
            ) from None
        return target

    # Personal scope insert. Cannot race on `user_id` (just generated)
    # so a partial-unique kind=personal index is the only realistic
    # failure mode. Wrap in try/except so a SQLAlchemy traceback
    # doesn't leak to the client as a raw 500.
    personal = Scope(
        user_id=new_user.id,
        name="Personal",
        slug="personal",
        kind=SCOPE_KIND_PERSONAL,
    )
    db.add(personal)
    try:
        await db.flush()
    except Exception:
        logger.exception(
            "personal_scope_create_failed clerk_id=%s user_id=%s",
            clerk_id,
            new_user.id,
        )
        await db.rollback()
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "internal server error",
        ) from None
    return new_user
