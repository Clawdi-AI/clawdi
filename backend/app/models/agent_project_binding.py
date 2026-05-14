"""Agent-scoped multi-project runtime bindings.

Each agent has exactly one `primary` binding and zero or more `context`
bindings ordered by `priority`.
"""

import uuid

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Index, Integer, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.scope import Scope as Scope  # noqa: F401 - FK target
from app.models.session import AgentEnvironment as AgentEnvironment  # noqa: F401 - FK target
from app.models.user import User as User  # noqa: F401 - FK target


class AgentProjectBinding(Base, TimestampMixin):
    __tablename__ = "agent_project_bindings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_environments.id", ondelete="CASCADE"),
        nullable=False,
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scopes.id", ondelete="CASCADE"),
        nullable=False,
    )
    binding_type: Mapped[str] = mapped_column(nullable=False)
    # Primary uses priority 0. Context rows use explicit order values.
    priority: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    default_write_enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default="false",
    )
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint("agent_id", "project_id", name="uq_agent_project_bindings_agent_project"),
        UniqueConstraint(
            "agent_id",
            "binding_type",
            "priority",
            name="uq_agent_project_bindings_agent_type_priority",
        ),
        Index(
            "uq_agent_project_bindings_one_primary",
            "agent_id",
            unique=True,
            postgresql_where=("binding_type = 'primary'"),
        ),
        CheckConstraint(
            "binding_type IN ('primary', 'context')",
            name="ck_agent_project_bindings_type_v1",
        ),
        CheckConstraint(
            "(binding_type = 'primary' AND default_write_enabled = true AND priority = 0) "
            "OR (binding_type = 'context' AND default_write_enabled = false AND priority >= 1)",
            name="ck_agent_project_bindings_write_priority_v1",
        ),
        Index("ix_agent_project_bindings_agent", "agent_id"),
        Index("ix_agent_project_bindings_project", "project_id"),
    )
