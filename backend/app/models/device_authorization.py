import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class DeviceAuthorization(Base, TimestampMixin):
    """Short-lived record for the CLI device-authorization flow.

    The CLI starts a flow with no auth, learns a `device_code` (kept secret) and
    a `user_code` (shown in URL + UI). The user opens the dashboard, signs in
    via Clerk, and approves — at which point we mint an API key and stash the
    *raw* string here keyed by `device_code`. The CLI polls for that value and
    consumes it on first read. The whole row TTLs out after `expires_at`.
    """

    __tablename__ = "device_authorizations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    user_code: Mapped[str] = mapped_column(String(16), unique=True, nullable=False, index=True)

    # Display-only client metadata so the user knows what they're authorizing.
    # Filled in by the CLI on /device (machine name, agent type, CLI version).
    client_label: Mapped[str | None] = mapped_column(String(200))

    # pending → approved → consumed (one-shot poll), or → denied / expired.
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="pending")

    # Set when status = approved. Owns both the user the key was minted for
    # and a back-reference to the api_keys row we created.
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    api_key_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    # Plaintext API key, populated at approve and CLEARED on first poll. Only
    # exists for the few seconds between Approve click and CLI poll. The hashed
    # form is the durable record in api_keys; this is the one-time delivery
    # channel back to the CLI.
    api_key_raw: Mapped[str | None] = mapped_column(Text)

    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
