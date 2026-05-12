"""Cross-user scope sharing service-layer helpers.

Owner-handle resolution and share-token generation/verification live
here; transactional flows that touch multiple tables (unshare,
accept-invitation, redeem-token-and-upgrade) also live here so the
route handlers stay thin.
"""

from __future__ import annotations

import re

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
