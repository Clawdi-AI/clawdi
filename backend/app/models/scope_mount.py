"""Scope composition primitive.

Where a `ScopeMembership` row says "user X can read scope Y" (the
capability layer), a `ScopeMount` says "scope Y's content appears
under scope X in the viewer's composed workspace" (the composition
layer). Mount edges are configuration on the PARENT (X), not
permission grants on the SOURCE (Y) — the resolver always re-checks
the viewer's independent membership in the source.

See `docs/superpowers/specs/2026-05-11-scope-sharing-spec.md`
§ "Data model" and § "Auto-mount target resolution" for the full
contract.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.scope import Scope as Scope  # noqa: F401 - FK target
from app.models.user import User as User  # noqa: F401 - FK target


class ScopeMount(Base, TimestampMixin):
    __tablename__ = "scope_mounts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    parent_scope_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scopes.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_scope_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scopes.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Alias is unique within parent_scope_id (see uq below). Natural
    # form is `@<owner-handle>/<source-slug>` — suffix-bumped only on
    # collision per spec § Hard questions #7.
    alias: Mapped[str] = mapped_column(String(80), nullable=False)
    # 'live' is the only v2 mode. 'snapshot_rev_N' reserved for v3
    # (pin a mount to a specific revision of the source); CHECK
    # extended via DROP+ADD when that ships.
    mode: Mapped[str] = mapped_column(String(20), nullable=False, default="live")
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        # Same (parent, source) can only be mounted once. Updates to
        # alias/mode go via UPDATE rather than re-INSERT.
        UniqueConstraint(
            "parent_scope_id", "source_scope_id",
            name="uq_scope_mounts_parent_source",
        ),
        # Alias must be unique within a parent so the composed
        # namespace (`@alice/eng`, `@bob/eng`) stays unambiguous.
        UniqueConstraint(
            "parent_scope_id", "alias",
            name="uq_scope_mounts_parent_alias",
        ),
        CheckConstraint("mode IN ('live')", name="ck_scope_mounts_mode_v2"),
        Index("ix_scope_mounts_parent", "parent_scope_id"),
        Index("ix_scope_mounts_source", "source_scope_id"),
    )
