import uuid

from sqlalchemy import CheckConstraint, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin

PRINCIPAL_KIND_CLERK = "clerk"
PRINCIPAL_KIND_PARTNER_TENANT = "partner_tenant"


class User(Base, TimestampMixin):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint(
            "partner_tenant_ref",
            name="uq_users_partner_tenant_ref",
        ),
        CheckConstraint(
            "(principal_kind = 'clerk' AND clerk_id IS NOT NULL "
            "AND partner_tenant_ref IS NULL) OR "
            "(principal_kind = 'partner_tenant' AND clerk_id IS NULL "
            "AND partner_tenant_ref IS NOT NULL)",
            name="ck_users_principal_identity",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    clerk_id: Mapped[str | None] = mapped_column(String(200), unique=True)
    principal_kind: Mapped[str] = mapped_column(
        String(32),
        default=PRINCIPAL_KIND_CLERK,
        server_default=PRINCIPAL_KIND_CLERK,
        nullable=False,
    )
    partner_tenant_ref: Mapped[str | None] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(320))
    name: Mapped[str | None] = mapped_column(String(200))
    # Profile picture URL captured from the Clerk JWT `picture` claim
    # on sign-in. Refreshed every time the user signs in (Clerk rotates
    # the underlying signed URL periodically). Public session-share
    # pages render this so visitors see the owner's avatar in the
    # message stream.
    avatar_url: Mapped[str | None] = mapped_column(String(512))
    # Monotonic counter incremented on any skill insert / update /
    # soft-delete (`is_active=False`). Exposed as a collection-level
    # ETag on `GET /v1/skills` and embedded in SSE `skill_changed`
    # event payloads so the daemon can detect missed events when
    # the stream drops mid-flight.
    skills_revision: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)


class UserSetting(Base, TimestampMixin):
    __tablename__ = "user_settings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, unique=True)
    settings: Mapped[dict] = mapped_column(JSONB, server_default="{}", nullable=False)
