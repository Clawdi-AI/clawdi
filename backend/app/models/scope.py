"""Scope — first-class container for skills, vaults, future memories.

A scope is a tenancy sub-unit owned by a user. Skills (and later vaults,
memories, sessions) belong to one scope at a time. Each user gets a
single Personal scope on signup; each registered agent environment
gets its own env-local scope on registration. Cross-scope sharing
(workspaces, teams, public marketplace) is a future milestone — the
schema here keeps `owner_user_id` single-valued and adds `kind` so
later sharing types extend cleanly via a CHECK-constraint update.

See `docs/plans/env-scoped-skills.md` for the architectural rationale.
"""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin

# Allowed values for `Scope.kind`. Future entries — `'shared'` for
# multi-user invited scopes, `'shared_public'` for subscribe-only
# marketplace scopes — will be added by dropping and re-adding the
# CHECK constraint, not via ENUM ALTER (cheaper to evolve).
SCOPE_KIND_PERSONAL = "personal"
SCOPE_KIND_ENVIRONMENT = "environment"
SCOPE_KINDS_V1 = (SCOPE_KIND_PERSONAL, SCOPE_KIND_ENVIRONMENT)


class Scope(Base, TimestampMixin):
    __tablename__ = "scopes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # User-readable name (display only) and stable URL slug. Both are
    # mutable; api uses `id` as the durable identifier so renaming
    # never breaks links. Slug uniqueness is per-user, not global.
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    slug: Mapped[str] = mapped_column(String(80), nullable=False)

    # Kind separates auto-managed scope types (personal, environment)
    # from future shareable types. CHECK constraint enforces the v1
    # set; new kinds get added by replacing the CHECK constraint.
    kind: Mapped[str] = mapped_column(String(32), nullable=False)

    # Env-local scopes record which env they were spawned for so the
    # dashboard can render "MacBook scope" without an extra join.
    # ON DELETE SET NULL: deleting an env doesn't destroy its scope —
    # the scope orphans and the user keeps history. A future archive
    # workflow can clean up orphaned env-scopes if desired.
    origin_environment_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_environments.id", ondelete="SET NULL"),
        index=True,
    )

    description: Mapped[str | None] = mapped_column(Text)

    # Soft-delete column — lets the dashboard show closed scopes
    # without losing history. Phase 1 doesn't surface this; reserved.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        # Slug unique per owner so the dashboard URL `/scopes/{slug}`
        # is unambiguous within an account; slugs can repeat across
        # owners.
        UniqueConstraint("user_id", "slug", name="uq_scopes_user_slug"),
        # Database-enforced kind whitelist. v1 covers personal +
        # environment; future ALTERs extend it.
        CheckConstraint(
            "kind IN ('personal', 'environment')",
            name="ck_scopes_kind_v1",
        ),
        # Exactly one personal-kind scope per user. Partial unique
        # index — environment-kind scopes are unrestricted (one per
        # env, naturally unique on `origin_environment_id`).
        Index(
            "uq_scopes_one_personal_per_user",
            "user_id",
            unique=True,
            postgresql_where=("kind = 'personal'"),
        ),
    )
