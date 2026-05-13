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
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.scope import Scope
from app.models.user import User
from app.models.vault import Vault, VaultItem

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

    Write paths (create-share-link, accept-invitation) must raise a
    409 `display_name_required` so the user fixes their profile
    before durable state is created with a meaningless handle. Read
    paths (listings, displays of mounts the user has already accepted
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

    Mirrors the fallback used by every owner-rendering surface (mount
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
    db: AsyncSession,
    user_id: UUID,
) -> tuple[list[tuple[UUID, str, str]], UUID | None]:
    """Resolve the mount-target ownership picture for an accepting user.

    Returns `(owned_scopes, auto_target_id_or_None)`:
      * `owned_scopes`: list of `(scope_id, slug, kind)` tuples ordered
        by kind then slug. `kind='personal'` sorts first.
      * `auto_target_id_or_None`:
        - If exactly 1 owned scope → that scope's id (silent auto-mount).
        - If 2+ owned scopes → None (caller surfaces 409
          mount_target_ambiguous).
        - If 0 owned scopes → None (impossible by construction but
          treated like ambiguous to be safe).

    Used by /upgrade and /me/invitations/{id}/accept to pick where
    the auto-mount lands when caller didn't pass parent_scope_id.
    """
    rows = (
        await db.execute(
            select(Scope.id, Scope.slug, Scope.kind)
            .where(Scope.user_id == user_id)
            .order_by(Scope.kind, Scope.slug)
        )
    ).all()
    owned = [(r.id, r.slug, r.kind) for r in rows]
    if len(owned) == 1:
        return owned, owned[0][0]
    return owned, None


def token_prefix(raw_token: str) -> str:
    """First 8 chars of the raw token - safe to store + display."""
    return raw_token[:_TOKEN_PREFIX_LEN]


async def detect_vault_conflicts(
    db: AsyncSession,
    *,
    parent_scope_id: UUID,
    source_scope_id: UUID,
) -> list[dict[str, str]]:
    """List vault keys that exist in BOTH the source and parent scope.

    A collision is `(vault.slug, section, item_name)` showing up under
    both scopes' vaults. Composed vault resolution is parent-first, so
    a collision on accept-mount would silently hide the shared value
    behind the sharee's parent value — surface as 409
    vault_conflicts_blocked at mount time so the sharee can inspect
    before committing.

    Empty list = no conflicts; safe to mount. Used by every accept
    surface that creates a mount (share-link upgrade, invitation
    accept, explicit `scope mount`).
    """
    src_vault = Vault.__table__.alias("v_src")
    src_item = VaultItem.__table__.alias("vi_src")
    parent_vault = Vault.__table__.alias("v_parent")
    parent_item = VaultItem.__table__.alias("vi_parent")

    stmt = (
        select(
            src_vault.c.slug.label("vault_slug"),
            src_item.c.section.label("section"),
            src_item.c.item_name.label("item_name"),
        )
        .select_from(
            src_item.join(src_vault, src_vault.c.id == src_item.c.vault_id)
            .join(
                parent_vault,
                parent_vault.c.slug == src_vault.c.slug,
            )
            .join(
                parent_item,
                (parent_item.c.vault_id == parent_vault.c.id)
                & (parent_item.c.section == src_item.c.section)
                & (parent_item.c.item_name == src_item.c.item_name),
            )
        )
        .where(
            src_vault.c.scope_id == source_scope_id,
            parent_vault.c.scope_id == parent_scope_id,
        )
        .order_by(src_vault.c.slug, src_item.c.section, src_item.c.item_name)
    )
    rows = (await db.execute(stmt)).all()
    return [
        {"vault_slug": r.vault_slug, "section": r.section, "item_name": r.item_name} for r in rows
    ]


async def assert_no_vault_conflicts(
    db: AsyncSession,
    *,
    parent_scope_id: UUID,
    source_scope_id: UUID,
    allow: bool,
) -> None:
    """409 vault_conflicts_blocked if accept-time vault collision detected.

    The caller passes `allow` from the body's `allow_vault_conflicts`
    flag — `True` skips the check entirely (user has consented to
    the override after inspecting the conflict list from a prior
    blocked attempt). Commits the session before raising so a
    membership row flushed by the caller survives the 409 — same
    posture as resolve_auto_mount_parent.
    """
    if allow:
        return
    conflicts = await detect_vault_conflicts(
        db, parent_scope_id=parent_scope_id, source_scope_id=source_scope_id
    )
    if not conflicts:
        return
    await db.commit()
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        {
            "error": "vault_conflicts_blocked",
            "message": (
                f"Source scope has {len(conflicts)} vault "
                f"key{'' if len(conflicts) == 1 else 's'} that already "
                "exist in your parent scope's vault. Re-run with "
                "allow_vault_conflicts=true after inspecting."
            ),
            "conflicts": conflicts,
        },
    )


async def resolve_auto_mount_parent(
    db: AsyncSession,
    user_id: UUID,
    parent_scope_id: str | None,
    membership_id: UUID,
) -> UUID:
    """Pick the parent_scope_id for an auto-mount on accept.

    Encapsulates the validation logic shared by every "accept a shared
    scope" route (share-link upgrade, email-invitation accept). The
    caller has already flushed a ScopeMembership row; this helper
    decides where the auto-mount lands and surfaces the appropriate
    error status if it can't.

    Returns the resolved parent UUID. On the error paths it commits
    the session first (so the freshly-flushed membership survives the
    raise — capability lives even when the mount step couldn't proceed
    automatically) and then raises HTTPException:

      400 invalid_parent_scope_id     parent_scope_id present but
                                       isn't a UUID.
      404 parent_scope_id not found   caller doesn't own the
                                       requested parent.
      409 mount_target_ambiguous      no parent_scope_id passed AND
                                       caller owns 2+ scopes. Payload
                                       carries owned_scopes + the
                                       membership_id so the client
                                       knows capability is in place
                                       and the mount is what's
                                       deferred.
    """
    if parent_scope_id:
        try:
            explicit = UUID(parent_scope_id)
        except (ValueError, AttributeError) as err:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                {"error": "invalid_parent_scope_id"},
            ) from err
        owned_check = (
            await db.execute(
                select(Scope).where(
                    Scope.id == explicit,
                    Scope.user_id == user_id,
                )
            )
        ).scalar_one_or_none()
        if owned_check is None:
            await db.commit()
            # Same 404 shape used elsewhere so scope IDs aren't enumerable.
            raise HTTPException(status.HTTP_404_NOT_FOUND, "parent_scope_id not found")
        return explicit

    owned, auto = await auto_mount_target(db, user_id)
    if auto is None:
        # Capability survives — commit membership before surfacing the 409
        # so the client can mount later by re-running with parent_scope_id.
        await db.commit()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "mount_target_ambiguous",
                "message": (
                    "You have multiple owned scopes. Re-run with "
                    "parent_scope_id set OR call `clawdi scope mount` after."
                ),
                "owned_scopes": [{"id": str(s[0]), "slug": s[1], "kind": s[2]} for s in owned],
                "membership_id": str(membership_id),
            },
        )
    return auto
