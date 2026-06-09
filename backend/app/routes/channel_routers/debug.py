from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth
from app.core.database import get_session
from app.services.channel_debug_events import (
    ChannelDebugEventFilters,
    channel_debug_event_response,
    channel_debug_health,
    list_channel_debug_events,
)

router = APIRouter(prefix="/api/channels/debug", tags=["channels"])


@router.get("/events")
async def list_debug_events(
    account_id: UUID | None = None,
    provider: str | None = None,
    external_chat_id: str | None = None,
    direction: str | None = None,
    stage: str | None = None,
    outcome: str | None = None,
    limit: int | None = Query(default=None, ge=1, le=1000),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    events = await list_channel_debug_events(
        db,
        ChannelDebugEventFilters(
            user_id=auth.user_id,
            account_id=account_id,
            provider=provider,
            external_chat_id=external_chat_id,
            direction=direction,
            stage=stage,
            outcome=outcome,
            limit=limit,
        ),
    )
    return [channel_debug_event_response(event) for event in events]


@router.get("/health")
async def get_debug_health(
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return {"channels": await channel_debug_health(db, user_id=auth.user_id)}
