from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.models.memory import Memory
from app.models.session import Session
from app.models.skill import Skill
from app.models.vault import Vault, VaultItem
from app.schemas.dashboard import ContributionDayResponse, DashboardStatsResponse

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("/stats")
async def get_stats(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    days: int = Query(default=365),
) -> DashboardStatsResponse:
    since = datetime.now(UTC) - timedelta(days=days)

    result = await db.execute(
        select(
            func.count(Session.id),
            func.coalesce(func.sum(Session.message_count), 0),
            func.coalesce(func.sum(Session.input_tokens + Session.output_tokens), 0),
        ).where(Session.user_id == auth.user_id, Session.started_at >= since)
    )
    row = result.one()
    total_sessions, total_messages, total_tokens = int(row[0]), int(row[1]), int(row[2])

    # Active days
    result = await db.execute(
        select(func.count(func.distinct(func.date(Session.started_at)))).where(
            Session.user_id == auth.user_id, Session.started_at >= since
        )
    )
    active_days = result.scalar() or 0

    # Favorite model
    result = await db.execute(
        select(Session.model, func.count(Session.id).label("cnt"))
        .where(Session.user_id == auth.user_id, Session.model.isnot(None))
        .group_by(Session.model)
        .order_by(text("cnt DESC"))
        .limit(1)
    )
    fav_row = result.first()
    favorite_model = fav_row[0] if fav_row else None

    # Peak hour
    result = await db.execute(
        select(
            func.extract("hour", Session.started_at).label("hr"),
            func.count(Session.id).label("cnt"),
        )
        .where(Session.user_id == auth.user_id)
        .group_by(text("hr"))
        .order_by(text("cnt DESC"))
        .limit(1)
    )
    peak_row = result.first()
    peak_hour = int(peak_row[0]) if peak_row else 0

    # Streaks
    current_streak, longest_streak = await _calc_streaks(db, auth.user_id)

    # Module counts
    skills_count = (
        await db.execute(
            select(func.count(Skill.id)).where(Skill.user_id == auth.user_id, Skill.is_active)
        )
    ).scalar() or 0

    memories_count = (
        await db.execute(select(func.count(Memory.id)).where(Memory.user_id == auth.user_id))
    ).scalar() or 0

    vault_count = (
        await db.execute(select(func.count(Vault.id)).where(Vault.user_id == auth.user_id))
    ).scalar() or 0

    vault_keys_count = 0
    vault_ids = (
        (await db.execute(select(Vault.id).where(Vault.user_id == auth.user_id))).scalars().all()
    )
    if vault_ids:
        vault_keys_count = (
            await db.execute(
                select(func.count(VaultItem.id)).where(VaultItem.vault_id.in_(vault_ids))
            )
        ).scalar() or 0

    # Connectors (Composio) — best-effort, don't fail if unavailable
    connectors_count = 0
    try:
        from app.core.config import settings
        from app.services.composio import get_connected_accounts

        if settings.composio_api_key:
            # Composio entity_id is the Clerk user id, not the local PG
            # UUID — must match what /api/connectors uses or this stat
            # silently reads zero for users who actually have connections.
            accounts = await get_connected_accounts(auth.user.clerk_id)
            connectors_count = sum(
                1 for a in accounts if (a.get("status") or "").upper() == "ACTIVE"
            )
    except Exception:
        pass

    return DashboardStatsResponse(
        total_sessions=total_sessions,
        total_messages=total_messages,
        total_tokens=total_tokens,
        active_days=active_days,
        current_streak=current_streak,
        longest_streak=longest_streak,
        peak_hour=peak_hour,
        favorite_model=favorite_model,
        skills_count=skills_count,
        memories_count=memories_count,
        vault_count=vault_count,
        vault_keys_count=vault_keys_count,
        connectors_count=connectors_count,
    )


@router.get("/contribution")
async def get_contribution_graph(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    days: int = Query(default=365),
) -> list[ContributionDayResponse]:
    since = datetime.now(UTC) - timedelta(days=days)

    result = await db.execute(
        select(
            func.date(Session.started_at).label("day"),
            func.count(Session.id).label("count"),
        )
        .where(Session.user_id == auth.user_id, Session.started_at >= since)
        .group_by(text("day"))
        .order_by(text("day"))
    )
    rows = result.all()

    # Build full date range with zeros
    day_map = {str(r[0]): int(r[1]) for r in rows}
    max_count = max(day_map.values()) if day_map else 1

    contributions: list[ContributionDayResponse] = []
    current = since.date()
    end = datetime.now(UTC).date()
    while current <= end:
        count = day_map.get(str(current), 0)
        level = 0
        if count > 0:
            ratio = count / max_count
            if ratio <= 0.25:
                level = 1
            elif ratio <= 0.5:
                level = 2
            elif ratio <= 0.75:
                level = 3
            else:
                level = 4
        contributions.append(ContributionDayResponse(date=current, count=count, level=level))
        current += timedelta(days=1)

    return contributions


async def _calc_streaks(db: AsyncSession, user_id) -> tuple[int, int]:
    result = await db.execute(
        select(func.distinct(func.date(Session.started_at)))
        .where(Session.user_id == user_id)
        .order_by(func.date(Session.started_at).desc())
    )
    dates = [r[0] for r in result.all()]

    if not dates:
        return 0, 0

    today = datetime.now(UTC).date()
    current_streak = 0
    if dates[0] >= today - timedelta(days=1):
        current_streak = 1
        for i in range(1, len(dates)):
            if dates[i] == dates[i - 1] - timedelta(days=1):
                current_streak += 1
            else:
                break

    longest_streak = 1 if dates else 0
    streak = 1
    for i in range(1, len(dates)):
        if dates[i] == dates[i - 1] - timedelta(days=1):
            streak += 1
            longest_streak = max(longest_streak, streak)
        else:
            streak = 1

    return current_streak, longest_streak
