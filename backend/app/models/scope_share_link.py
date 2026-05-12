"""One share-link row per generated link.

Owners create multiple links per scope (one to share with a team, one
with a community, etc.). Each is independently revocable. The raw
token is never stored - only `token_hash = sha256(token)`. The first
8 chars of the raw token are kept in `token_prefix` purely for the
owner's UI ("link starting with abc12345...") so they can identify
which one to revoke without seeing the rest.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.scope import Scope as Scope  # noqa: F401
from app.models.user import User as User  # noqa: F401


class ScopeShareLink(Base, TimestampMixin):
    __tablename__ = "scope_share_links"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    scope_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scopes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # sha256(raw_token), 64 hex chars. Unique -> fast lookup.
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    # First 8 chars of raw token; safe to store + display since the full
    # token has 35 chars of remaining entropy (43-8). Used in
    # GET /share-links to identify which link this is.
    token_prefix: Mapped[str] = mapped_column(String(8), nullable=False)
    label: Mapped[str | None] = mapped_column(String(200))
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Owner handle frozen at link creation; every downstream consumer
    # (anonymous redeem response, membership row at upgrade time)
    # reads this same value. See spec sections 11.2 and 11.6.
    resolved_owner_handle: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    redeem_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    last_redeemed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
