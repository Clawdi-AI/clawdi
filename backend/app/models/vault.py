import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    LargeBinary,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.project import Project


class Vault(Base, TimestampMixin):
    __tablename__ = "vaults"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    slug: Mapped[str] = mapped_column(String(200), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)

    runtime_revision: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")

    # Vaults are account-owned resources. Projects do not own keys;
    # they attach to vaults through VaultProjectAttachment.
    __table_args__ = (UniqueConstraint("user_id", "slug", name="uq_vault_user_slug"),)


class VaultProjectAttachment(Base, TimestampMixin):
    __tablename__ = "vault_project_attachments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    vault_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("vaults.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(Project.id, ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    __table_args__ = (
        UniqueConstraint("vault_id", "project_id", name="uq_vault_project_attachment"),
    )


class VaultProjectSlugAlias(Base, TimestampMixin):
    __tablename__ = "vault_project_slug_aliases"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    vault_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("vaults.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(Project.id, ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    slug: Mapped[str] = mapped_column(String(200), nullable=False)
    is_legacy: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    # Compatibility for pre-sharing clawdi://project/.../vault/<slug>/...
    # references after Vault slugs become account-scoped.
    __table_args__ = (
        UniqueConstraint("project_id", "slug", name="uq_vault_project_slug_alias_project_slug"),
    )


class VaultItem(Base, TimestampMixin):
    __tablename__ = "vault_items"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    vault_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("vaults.id", ondelete="CASCADE"), nullable=False
    )
    item_name: Mapped[str] = mapped_column(String(200), nullable=False)
    section: Mapped[str] = mapped_column(String(200), server_default="", nullable=False)
    encrypted_value: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)

    __table_args__ = (
        UniqueConstraint("vault_id", "section", "item_name", name="uq_vault_item_section_name"),
    )


class VaultCredentialProfile(Base, TimestampMixin):
    __tablename__ = "vault_credential_profiles"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(Project.id, ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    tool: Mapped[str] = mapped_column(String(80), nullable=False)
    profile: Mapped[str] = mapped_column(String(120), nullable=False, server_default="default")
    encrypted_payload: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "project_id",
            "tool",
            "profile",
            name="uq_vault_credential_profiles_user_project_tool_profile",
        ),
    )


class VaultSecretRequest(Base, TimestampMixin):
    """A pending field reservation, never a substitute encrypted secret."""

    __tablename__ = "vault_secret_requests"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    vault_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("vaults.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey(Project.id, ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    section: Mapped[str] = mapped_column(String(200), nullable=False)
    fields: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    # Null records absence; an empty map is reserved for legacy capabilities.
    # Never expose these request-local snapshots through API or runtime metadata.
    field_baselines: Mapped[dict[str, str | None]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    supplied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    conflicted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
