from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth
from app.core.database import get_session
from app.models.audit import ControlPlaneAuditEvent
from app.schemas.audit import (
    ControlPlaneAuditEventListResponse,
    ControlPlaneAuditEventResponse,
)

router = APIRouter(prefix="/api/audit", tags=["audit"])


@router.get("/events")
async def list_control_plane_audit_events(
    resource_type: str | None = Query(default=None, min_length=1, max_length=80),
    environment_id: UUID | None = None,
    channel_account_id: UUID | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ControlPlaneAuditEventListResponse:
    filters = [ControlPlaneAuditEvent.target_user_id == auth.user_id]
    if resource_type is not None:
        filters.append(ControlPlaneAuditEvent.resource_type == resource_type)
    if environment_id is not None:
        filters.append(ControlPlaneAuditEvent.environment_id == environment_id)
    if channel_account_id is not None:
        filters.append(ControlPlaneAuditEvent.channel_account_id == channel_account_id)
    result = await db.execute(
        select(ControlPlaneAuditEvent)
        .where(*filters)
        .order_by(ControlPlaneAuditEvent.created_at.desc(), ControlPlaneAuditEvent.id.desc())
        .limit(limit)
    )
    return ControlPlaneAuditEventListResponse(
        items=[
            ControlPlaneAuditEventResponse(
                id=event.id,
                actor_type=event.actor_type,
                actor_user_id=event.actor_user_id,
                target_user_id=event.target_user_id,
                source=event.source,
                action=event.action,
                resource_type=event.resource_type,
                resource_id=event.resource_id,
                environment_id=event.environment_id,
                channel_account_id=event.channel_account_id,
                channel_agent_link_id=event.channel_agent_link_id,
                details=event.details,
                created_at=event.created_at,
            )
            for event in result.scalars().all()
        ],
    )
