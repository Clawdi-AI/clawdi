"""Owner-facing sharing endpoints.

Every route is gated by:
  1. require_user_auth_unbound — Clerk JWT OR fully-unbound CLI api_key.
     Narrowly-scoped api_keys and env-bound deploy keys are rejected
     (the latter wraps PR #77's blast-radius boundary).
  2. _assert_scope_owner — verifies the scope exists AND the caller
     owns it. 404 (not 403) on either condition to avoid leaking
     scope existence to non-owners.

Public anonymous routes (share-link redemption etc.) live in
`share_redeem.py`; that one uses require_share_token instead.

This module covers Plan Phase B tasks B.1–B.8 incrementally. The
MVP commit ships B.1 skeleton + B.2 create-link so the owner
dialog's "Generate link" action goes through end-to-end; list,
revoke, invitations, members, and unshare land in follow-ups.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth_unbound
from app.core.config import settings
from app.core.database import get_session
from app.models.scope import Scope
from app.models.scope_share_link import ScopeShareLink
from app.schemas.sharing import ShareLinkCreate, ShareLinkCreated
from app.services.sharing import (
    generate_share_token,
    hash_share_token,
    resolve_owner_handle,
    token_prefix,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/scopes", tags=["sharing"])


async def _assert_scope_owner(db: AsyncSession, auth: AuthContext, scope_id: UUID) -> Scope:
    """Resolve scope and verify the caller owns it. 404 if the
    scope doesn't exist OR the caller isn't its owner — refusing
    to distinguish the two keeps scope IDs un-enumerable by
    non-owners."""
    result = await db.execute(select(Scope).where(Scope.id == scope_id))
    scope = result.scalar_one_or_none()
    if scope is None or scope.user_id != auth.user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "scope not found")
    return scope


def _share_url(raw_token: str) -> str:
    """Compose the public share URL from the raw token.

    Hosts the public landing page on the dashboard origin
    (settings.web_origin). Falls back to a sentinel for OSS
    self-hosters who haven't configured a public dashboard URL.
    """
    base = settings.web_origin.rstrip("/") if settings.web_origin else "https://example.invalid"
    return f"{base}/share/{raw_token}"


@router.post("/{scope_id}/share-links", response_model=ShareLinkCreated)
async def create_share_link(
    scope_id: UUID,
    body: ShareLinkCreate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ShareLinkCreated:
    """Generate a new share link for a scope.

    Contract:
    - Raw token is returned ONCE in the create response; server
      stores only the SHA-256 hash + prefix.
    - Gate on owner having `users.name` set (spec § 4.5). Falling
      back to email local-part would leak PII to recipients.
    - Resolves + freezes `resolved_owner_handle` on the link row so
      every downstream consumer (preview, redeem, upgrade) reads
      the same value — even if the owner later renames themselves.
    """
    await _assert_scope_owner(db, auth, scope_id)

    if not auth.user.name:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "display_name_required",
                "message": (
                    "Set a display name on your profile before sharing a "
                    "scope. The name is shown to anyone you share with."
                ),
            },
        )
    try:
        owner_handle = resolve_owner_handle(auth.user)
    except ValueError as err:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "display_name_required",
                "message": ("Your display name must contain at least one alphanumeric character."),
            },
        ) from err

    raw = generate_share_token()
    link = ScopeShareLink(
        scope_id=scope_id,
        token_hash=hash_share_token(raw),
        token_prefix=token_prefix(raw),
        label=body.label,
        created_by=auth.user_id,
        resolved_owner_handle=owner_handle,
        created_at=datetime.now(UTC),
        expires_at=body.expires_at,
    )
    db.add(link)
    await db.commit()
    await db.refresh(link)

    logger.info(
        "share_link_created scope_id=%s link_id=%s by=%s handle=%s",
        scope_id,
        link.id,
        auth.user_id,
        owner_handle,
    )
    return ShareLinkCreated(
        id=str(link.id),
        raw_token=raw,
        url=_share_url(raw),
        prefix=link.token_prefix,
        owner_handle=owner_handle,
        label=link.label,
        created_at=link.created_at,
        expires_at=link.expires_at,
    )
