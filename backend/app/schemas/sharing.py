"""Pydantic models for cross-user project sharing and binding flows."""

from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class ShareLinkCreate(BaseModel):
    """Body for POST /api/projects/{project_id}/share-links."""

    label: str | None = Field(default=None, max_length=200)
    expires_at: datetime | None = None


class ShareLinkCreated(BaseModel):
    """Returned once on link creation; includes the raw token."""

    id: str
    raw_token: str
    url: str
    prefix: str
    owner_handle: str
    label: str | None
    created_at: datetime
    expires_at: datetime | None


class ShareLinkResponse(BaseModel):
    """Returned by GET /api/projects/{project_id}/share-links."""

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
    """Body for POST /api/projects/{project_id}/invitations."""

    email: str

    @field_validator("email")
    @classmethod
    def _validate_email_shape(cls, value: str) -> str:
        local, separator, domain = value.partition("@")
        if not separator or not local or "." not in domain or domain.endswith("."):
            raise ValueError("invalid email address")
        return value


class InvitationResponse(BaseModel):
    """Returned by owner and sharee invitation listings."""

    id: str
    project_id: str
    project_name: str
    project_kind: str
    owner_display: str
    owner_handle: str
    invitee_email: str
    invited_by_user_id: str
    invited_by_display: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class MemberResponse(BaseModel):
    """Returned by GET /api/projects/{project_id}/members."""

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
    """Returned by POST /api/projects/{project_id}/unshare."""

    links_revoked: int
    members_removed: int
    invitations_cancelled: int
    agent_bindings_removed: int = 0


class ShareRedeemResponse(BaseModel):
    """Returned by POST /api/share/{token}/redeem."""

    project_id: str
    project_name: str
    owner_display: str
    owner_handle: str
    skill_count: int
    vault_count: int
    vault_locked: bool


class SharedProjectResponse(BaseModel):
    """An entry in GET /api/me/projects when listing shared projects."""

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

    Accepting access does not auto-bind by default. Callers can pass
    explicit `agent_ids` to attach the accepted Project for reads.
    """

    agent_ids: list[str] | None = None
    bind_as: str = "context"

    @field_validator("bind_as")
    @classmethod
    def _validate_bind_as(cls, value: str) -> str:
        if value != "context":
            raise ValueError("bind_as must be 'context'; Agent Project is fixed")
        return value


class InboxAcceptLinkBody(UpgradeBody):
    """Body for POST /api/inbox/accept-link."""

    token: str | None = None
    url: str | None = None


class InboxAcceptInvitationBody(UpgradeBody):
    """Body for POST /api/inbox/accept-invitation."""

    invitation_id: str


class BindingCreate(BaseModel):
    project_id: str
    priority: int | None = None


class BindingReorderItem(BaseModel):
    binding_id: str
    priority: int


class BindingReorderBody(BaseModel):
    items: list[BindingReorderItem]


class AgentProjectBindingResponse(BaseModel):
    id: str
    agent_id: str
    project_id: str
    binding_type: str
    priority: int
    default_write_enabled: bool
    created_at: datetime

    model_config = {"from_attributes": True}
