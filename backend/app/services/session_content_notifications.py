"""Commit-only session content hints, carried by the shared PostgreSQL listener."""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.channel_wakeups import ChannelWakeup

SESSION_CONTENT_CHANGED = "session_content_changed"
session_content_changed = ChannelWakeup()


async def notify_session_content_changed(db: AsyncSession, session_id: UUID) -> None:
    await db.execute(
        text("SELECT pg_notify(:channel, :key)"),
        {"channel": SESSION_CONTENT_CHANGED, "key": str(session_id)},
    )


def on_session_content_changed(_pid: int, _channel: str, payload: str) -> None:
    try:
        session_id = UUID(payload)
    except ValueError:
        return
    session_content_changed.signal(str(session_id))
