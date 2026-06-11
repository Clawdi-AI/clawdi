from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel


class ControlPlaneAuditEventResponse(BaseModel):
    id: UUID
    actor_type: str
    actor_user_id: UUID | None = None
    target_user_id: UUID | None = None
    source: str
    action: str
    resource_type: str
    resource_id: str | None = None
    environment_id: UUID | None = None
    channel_account_id: UUID | None = None
    channel_agent_link_id: UUID | None = None
    details: dict[str, Any]
    created_at: datetime


class ControlPlaneAuditEventListResponse(BaseModel):
    items: list[ControlPlaneAuditEventResponse]
