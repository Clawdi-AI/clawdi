import uuid

from sqlalchemy import ForeignKey, LargeBinary, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.scope import (
    Scope as Scope,  # noqa: F401 — register `scopes` table for FK resolution
)


class Vault(Base, TimestampMixin):
    __tablename__ = "vaults"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # Scope the vault belongs to. Items inherit through the parent
    # vault — VaultItem deliberately doesn't carry its own scope_id
    # to avoid the "item says A, vault says B" invalid state. Phase 1
    # backfill assigns existing vaults to the user's Personal scope;
    # phase 4 wires the actual read/write filtering.
    scope_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        # CASCADE so scope delete propagates to vaults (and
        # transitively to vault_items via vault.id CASCADE).
        # Avoids RESTRICT deadlock when a user / scope is deleted.
        ForeignKey("scopes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    slug: Mapped[str] = mapped_column(String(200), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)

    # Slug uniqueness is per (user_id, scope_id, slug). With the
    # one-env-one-scope model, the same slug is free to exist in
    # different scopes — env A's "github" vault and env B's
    # "github" vault are independent rows.
    __table_args__ = (
        UniqueConstraint("user_id", "scope_id", "slug", name="uq_vault_user_scope_slug"),
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
