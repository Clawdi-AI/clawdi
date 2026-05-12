"""Pydantic request + response models for cross-user scope sharing.

Owner-facing schemas live alongside sharee-facing ones - the route
modules are split (sharing.py vs share_redeem.py vs me.py) but the
contract types are small enough to keep together.
"""

from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class ShareLinkCreate(BaseModel):
    """Body for POST /api/scopes/{scope_id}/share-links."""

    label: str | None = Field(default=None, max_length=200)
    expires_at: datetime | None = None


class ShareLinkCreated(BaseModel):
    """Returned ONCE on link creation - includes the raw token.

    Subsequent GETs only return `prefix` (raw token is unrecoverable).
    `owner_handle` is the frozen value stored on the link row that
    every sharee will see; the owner sees their own resolved handle
    in case they want to verify or change their display name first.
    """

    id: str
    raw_token: str
    url: str
    prefix: str
    owner_handle: str
    label: str | None
    created_at: datetime
    expires_at: datetime | None


class ShareLinkResponse(BaseModel):
    """Returned by GET /api/scopes/{scope_id}/share-links."""

    id: str
    prefix: str
    label: str | None
    created_at: datetime
    expires_at: datetime | None
    revoked_at: datetime | None
    redeem_count: int
    last_redeemed_at: datetime | None

    model_config = {"from_attributes": True}


class InvitationCreate(BaseModel):
    """Body for POST /api/scopes/{scope_id}/invitations."""

    email: str

    @field_validator("email")
    @classmethod
    def _validate_email_shape(cls, value: str) -> str:
        local, separator, domain = value.partition("@")
        if not separator or not local or "." not in domain or domain.endswith("."):
            raise ValueError("invalid email address")
        return value


class InvitationResponse(BaseModel):
    """Returned by owner and sharee invitation listings.

    Scope fields (`scope_name`, `scope_kind`, `owner_display`,
    `owner_handle`) are populated unconditionally - the owner-facing
    listing uses them to render alongside the invitee email, and
    the sharee-facing inbox uses them as the primary "what is this
    invitation about?" copy.
    """

    id: str
    scope_id: str
    scope_name: str
    scope_kind: str
    owner_display: str
    owner_handle: str
    invitee_email: str
    invited_by_user_id: str
    invited_by_display: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class MemberResponse(BaseModel):
    """Returned by GET /api/scopes/{scope_id}/members."""

    id: str
    user_id: str
    user_email: str | None
    user_display: str | None
    role: str
    joined_via: str
    joined_at: datetime
    resolved_owner_handle: str

    model_config = {"from_attributes": True}


class UnshareResponse(BaseModel):
    """Returned by POST /api/scopes/{scope_id}/unshare."""

    links_revoked: int
    members_removed: int
    invitations_cancelled: int


class ShareRedeemResponse(BaseModel):
    """Returned by POST /api/share/{token}/redeem - anonymous endpoint."""

    scope_id: str
    scope_name: str
    owner_display: str
    owner_handle: str
    skill_count: int
    vault_count: int
    vault_locked: bool  # always True for token-only access in v1


class SharedScopeResponse(BaseModel):
    """An entry in GET /api/me/scopes 'shared' list."""

    id: str
    name: str
    slug: str
    kind: str
    owner_display: str
    owner_handle: str
    role: str
    joined_at: datetime
    is_owner: bool = False


class UpgradeBody(BaseModel):
    """Optional body for POST /api/share/{token}/upgrade and
    POST /api/me/invitations/{id}/accept.

    Carries the mount target the caller wants. Omitted → server
    picks via the auto-mount target resolution rules (1 owned
    scope → silent; 2+ → 409 mount_target_ambiguous).
    """

    parent_scope_id: str | None = None
    alias: str | None = None
    no_mount: bool = False
    # Mount-time vault conflict detection: if source scope has any
    # vault key (slug + section + name triple) that already exists
    # in the parent's vault, the mount returns 409
    # vault_conflicts_blocked. Setting this to True skips the check —
    # the sharee has inspected the conflict list and consented to the
    # collision (the source vault values WIN for clawdi:// resolution
    # priority while the mount is in place).
    allow_vault_conflicts: bool = False


class MountCreate(BaseModel):
    """Body for POST /api/scopes/{parent_scope_id}/mounts."""

    source_scope_id: str
    alias: str | None = None
    mode: str = "live"
    allow_vault_conflicts: bool = False


class MountResponse(BaseModel):
    """Returned by GET /api/scopes/{id}/mounts and the POST create.

    Includes denormalized source-scope display fields so the CLI/web
    can render the mount tree without an extra round-trip per row.
    """

    id: str
    parent_scope_id: str
    source_scope_id: str
    source_scope_name: str
    source_scope_slug: str
    source_owner_display: str
    source_owner_handle: str
    alias: str
    mode: str
    created_at: datetime
