"""Cross-user scope sharing service-layer helpers.

Owner-handle resolution and share-token generation/verification live
here; transactional flows that touch multiple tables (unshare,
accept-invitation, redeem-token-and-upgrade) also live here so the
route handlers stay thin.
"""

from __future__ import annotations

import hashlib
import re
import secrets

from app.models.user import User

_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_TRIM_DASHES = re.compile(r"^-+|-+$")


def _kebab(text: str) -> str:
    """Kebab-case a free-form display name."""
    lowered = text.strip().lower()
    dashed = _NON_ALNUM.sub("-", lowered)
    return _TRIM_DASHES.sub("", dashed)


_USER_ID_SUFFIX_LEN = 4


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
    sharee because the handle is frozen on `scope_share_links`
    at create time, when we don't know the sharee yet.
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


async def auto_mount_target(
    db,  # AsyncSession; imported only for type hints in callers
    user_id,
) -> tuple[list, str | None]:
    """Resolve the mount-target ownership picture for an accepting user.

    Returns `(owned_scopes, auto_target_id_or_None)`:
      * `owned_scopes`: list of `(scope_id, slug)` tuples ordered by
        kind then slug. `kind='personal'` always first.
      * `auto_target_id_or_None`:
        - If exactly 1 owned scope → that scope's id (silent auto-mount).
        - If 2+ owned scopes → None (caller surfaces 409
          mount_target_ambiguous).
        - If 0 owned scopes → None (impossible by construction but
          treated like ambiguous to be safe).

    Used by /upgrade and /me/invitations/{id}/accept to pick where
    the auto-mount lands when caller didn't pass parent_scope_id.
    """
    from sqlalchemy import select

    from app.models.scope import Scope

    rows = (
        (
            await db.execute(
                select(Scope.id, Scope.slug, Scope.kind)
                .where(Scope.user_id == user_id)
                .order_by(Scope.kind, Scope.slug)
            )
        )
        .all()
    )
    owned = [(r.id, r.slug, r.kind) for r in rows]
    if len(owned) == 1:
        return owned, owned[0][0]
    return owned, None


def token_prefix(raw_token: str) -> str:
    """First 8 chars of the raw token - safe to store + display."""
    return raw_token[:_TOKEN_PREFIX_LEN]
