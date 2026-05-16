"""Cross-user project sharing service-layer helpers.

Owner-handle resolution and share-token generation/verification live
here; transactional flows that touch multiple tables (unshare,
accept invitation, redeem share token) also live here so the
route handlers stay thin.
"""

from __future__ import annotations

import hashlib
import re
import secrets
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project_membership import ProjectMembership
from app.models.user import User

_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_TRIM_DASHES = re.compile(r"^-+|-+$")


def _kebab(text: str) -> str:
    """Kebab-case a free-form display name."""
    lowered = text.strip().lower()
    dashed = _NON_ALNUM.sub("-", lowered)
    return _TRIM_DASHES.sub("", dashed)


_USER_ID_SUFFIX_LEN = 4


OWNER_HANDLE_MISSING_SENTINEL = "owner-display-name-missing"


def safe_owner_handle(user: User) -> str:
    """resolve_owner_handle with a stable fallback for read paths.

    Write paths (create share link, accept invitation) must raise a
    409 `display_name_required` so the user fixes their profile
    before durable state is created with a meaningless handle. Read
    paths (listings for links/invitations already accepted
    months ago — owner since stripped their display name) need
    something to render and can't 409 the whole page; this helper
    returns OWNER_HANDLE_MISSING_SENTINEL instead so the row remains
    visible with a clear "needs attention" handle.
    """
    try:
        return resolve_owner_handle(user)
    except ValueError:
        return OWNER_HANDLE_MISSING_SENTINEL


def safe_owner_display(user: User) -> str:
    """Display name with a stable fallback chain: name → email → user-<hex8>.

    Mirrors the fallback used by every owner-rendering surface (project
    listing, invitation row, share-link landing). Centralised so the
    user-<hex8> suffix shape and length stay consistent across them.
    """
    return user.name or user.email or f"user-{str(user.id)[:8]}"


def resolve_owner_handle(user: User) -> str:
    """Compute the stable owner handle for `user`.

    Definition:
        handle = kebab(user.name) + "-" + user.id.hex[:4]

    `user.name` must be non-empty AND kebab to non-empty. Callers
    must gate on that BEFORE calling. The helper raises ValueError
    if the invariant is violated to fail loudly rather than silently
    producing a handle like `-a3b4`.

    The 4-hex-char suffix makes handles globally unique per owner.
    No `existing_handles` parameter - we don't disambiguate per
    recipient because the handle is frozen on `project_share_links`
    at create time, when we don't know the recipient yet.
    """
    if not user.name:
        raise ValueError(
            f"user {user.id} has no users.name set; "
            "callers must gate on display name presence before calling"
        )
    name_part = _kebab(user.name)
    if not name_part:
        raise ValueError(
            f"user {user.id} users.name kebabs to empty string; "
            "user must set a display name with at least one alphanumeric character"
        )
    suffix = user.id.hex[:_USER_ID_SUFFIX_LEN]
    return f"{name_part}-{suffix}"


# --- Share-token primitives ---

_TOKEN_BYTES = 32  # 32 random bytes -> 43 URL-safe-b64 chars
_TOKEN_PREFIX_LEN = 8


def generate_share_token() -> str:
    """Return a fresh opaque token suitable for embedding in a URL.

    32 random bytes give 256 bits of entropy. URL-safe base64 with no
    padding keeps the resulting string copy-pasteable and route-segment safe.
    """
    return secrets.token_urlsafe(_TOKEN_BYTES)


def hash_share_token(raw_token: str) -> str:
    """Return sha256(raw_token) as 64 hex chars.

    The raw token NEVER lands in the DB. Server stores this hash; on
    redeem the server hashes the URL-extracted token and looks it up.
    """
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def token_prefix(raw_token: str) -> str:
    """First 8 chars of the raw token - safe to store + display."""
    return raw_token[:_TOKEN_PREFIX_LEN]


async def ensure_viewer_membership(
    db: AsyncSession,
    *,
    project_id: UUID,
    member_user_id: UUID,
    joined_via: str,
    resolved_owner_handle: str,
) -> ProjectMembership:
    existing = (
        await db.execute(
            select(ProjectMembership).where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.member_user_id == member_user_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    membership = ProjectMembership(
        project_id=project_id,
        member_user_id=member_user_id,
        role="viewer",
        joined_via=joined_via,
        joined_at=datetime.now(UTC),
        resolved_owner_handle=resolved_owner_handle,
    )
    db.add(membership)
    await db.flush()
    return membership
