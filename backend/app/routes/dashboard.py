import asyncio
import logging
from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_clerk_id, require_web_auth
from app.core.config import settings
from app.core.database import get_session
from app.models.session import Session
from app.schemas.dashboard import ContributionDayResponse, DashboardStatsResponse
from app.services import composio

router = APIRouter(prefix="/dashboard", tags=["dashboard"])
log = logging.getLogger(__name__)

_DASHBOARD_DAYS_MAX = 3660
_CONNECTORS_COUNT_CACHE_TTL = timedelta(minutes=2)
_CONNECTORS_COUNT_TIMEOUT_SECONDS = 2.0
_CONNECTORS_COUNT_CACHE_MAX = 1024
_connectors_count_cache: dict[str, tuple[datetime, int]] = {}

# These endpoints aggregate by `user_id` across every project/env
# the user owns. An Agent API key (full-permission api_key
# minted with `scopes=None` but pinned to `environment_id=A`)
# would otherwise read account-wide totals — sessions, message
# counts, token usage, contribution graph, skill/vault/memory
# counts — for sibling envs B/C/D that the resource-level routes
# (memories.py, vault.py, skills.py) explicitly hide from it.
# Forcing `require_web_auth` (Clerk JWT only, no api_keys at
# all) keeps the deploy-key isolation model intact: Agent environment
# keys can read/write within their Agent Project, but never see the
# user-wide aggregate that would let them infer activity in
# other envs. The dashboard is the only consumer here — no CLI
# callsites.


@router.get("/stats")
async def get_stats(
    response: Response,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
    days: int = Query(default=365, ge=1, le=_DASHBOARD_DAYS_MAX),
) -> DashboardStatsResponse:
    response.headers["Cache-Control"] = "private, max-age=30, stale-while-revalidate=30"
    now = datetime.now(UTC)
    since = now - timedelta(days=days)
    current_floor = now.date() - timedelta(days=1)
    weekly_since = now - timedelta(days=7)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    result = await db.execute(
        text(
            """
            WITH visible_projects AS (
                SELECT id
                FROM projects
                WHERE user_id = :user_id
                UNION
                SELECT project_id
                FROM project_memberships
                WHERE member_user_id = :user_id
            ),
            visible_vaults AS (
                SELECT vaults.id
                FROM vaults
                WHERE vaults.user_id = :user_id
                   OR EXISTS (
                       SELECT 1
                       FROM vault_project_attachments
                       WHERE vault_project_attachments.vault_id = vaults.id
                         AND vault_project_attachments.project_id IN (
                             SELECT id FROM visible_projects
                         )
                   )
            ),
            all_session_count AS (
                SELECT count(*)::integer AS total_sessions
                FROM sessions
                WHERE user_id = :user_id
            ),
            session_window AS (
                SELECT
                    COALESCE(sum(message_count), 0)::bigint AS total_messages,
                    COALESCE(sum(input_tokens + output_tokens), 0)::bigint AS total_tokens
                FROM sessions
                WHERE user_id = :user_id
                  AND started_at >= :since
            ),
            day_counts AS (
                SELECT
                    CAST(started_at AT TIME ZONE 'UTC' AS date) AS day,
                    count(*)::integer AS count
                FROM sessions
                WHERE user_id = :user_id
                  AND started_at >= :since
                GROUP BY CAST(started_at AT TIME ZONE 'UTC' AS date)
            ),
            favorite_model AS (
                SELECT model
                FROM sessions
                WHERE user_id = :user_id
                  AND model IS NOT NULL
                GROUP BY model
                ORDER BY count(*) DESC
                LIMIT 1
            ),
            peak_hour AS (
                SELECT CAST(EXTRACT(hour FROM started_at) AS integer) AS peak_hour
                FROM sessions
                WHERE user_id = :user_id
                GROUP BY EXTRACT(hour FROM started_at)
                ORDER BY count(*) DESC
                LIMIT 1
            ),
            days AS (
                SELECT DISTINCT CAST(started_at AT TIME ZONE 'UTC' AS date) AS day
                FROM sessions
                WHERE user_id = :user_id
            ),
            numbered AS (
                SELECT
                    day,
                    day - CAST(row_number() OVER (ORDER BY day) AS integer) AS streak_group
                FROM days
            ),
            runs AS (
                SELECT
                    min(day) AS start_day,
                    max(day) AS end_day,
                    count(*)::integer AS streak_len
                FROM numbered
                GROUP BY streak_group
            ),
            streaks AS (
                SELECT
                    COALESCE(
                        max(streak_len) FILTER (WHERE end_day >= :current_floor),
                        0
                    )::integer AS current_streak,
                    COALESCE(max(streak_len), 0)::integer AS longest_streak
                FROM runs
            ),
            resource_counts AS (
                SELECT
                    (SELECT count(*)::integer
                     FROM skills
                     WHERE is_active
                       AND project_id IN (SELECT id FROM visible_projects)) AS skills_count,
                    (SELECT count(*)::integer
                     FROM memories
                     WHERE user_id = :user_id) AS memories_count,
                    (SELECT count(*)::integer
                     FROM visible_vaults) AS vault_count,
                    (SELECT count(*)::integer
                     FROM vault_items
                     WHERE vault_id IN (SELECT id FROM visible_vaults)) AS vault_keys_count
            ),
            weekly_sessions AS (
                SELECT
                    count(*) FILTER (
                        WHERE summary IS NULL
                           OR (summary NOT LIKE 'Cron:%' AND summary NOT LIKE '[%')
                    )::integer AS manual_sessions_last_7_days,
                    count(*) FILTER (
                        WHERE summary LIKE 'Cron:%' OR summary LIKE '[%'
                    )::integer AS automated_sessions_last_7_days,
                    count(*) FILTER (
                        WHERE started_at >= :today_start
                    )::integer AS sessions_today
                FROM sessions
                WHERE user_id = :user_id
                  AND started_at >= :weekly_since
            ),
            weekly_top_model AS (
                SELECT model
                FROM sessions
                WHERE user_id = :user_id
                  AND started_at >= :weekly_since
                  AND model IS NOT NULL
                GROUP BY model
                ORDER BY count(*) DESC, model
                LIMIT 1
            )
            SELECT
                all_session_count.total_sessions,
                session_window.total_messages,
                session_window.total_tokens,
                (SELECT count(*)::integer FROM day_counts) AS active_days,
                (SELECT model FROM favorite_model) AS favorite_model,
                COALESCE((SELECT peak_hour FROM peak_hour), 0)::integer AS peak_hour,
                streaks.current_streak,
                streaks.longest_streak,
                resource_counts.skills_count,
                resource_counts.memories_count,
                resource_counts.vault_count,
                resource_counts.vault_keys_count,
                weekly_sessions.manual_sessions_last_7_days,
                weekly_sessions.automated_sessions_last_7_days,
                weekly_sessions.sessions_today,
                (SELECT model FROM weekly_top_model) AS top_model_last_7_days,
                day_counts.day AS contribution_day,
                day_counts.count AS contribution_count
            FROM session_window
            CROSS JOIN all_session_count
            CROSS JOIN streaks
            CROSS JOIN resource_counts
            CROSS JOIN weekly_sessions
            LEFT JOIN day_counts ON true
            ORDER BY day_counts.day
            """
        ),
        {
            "user_id": auth.user_id,
            "since": since,
            "current_floor": current_floor,
            "weekly_since": weekly_since,
            "today_start": today_start,
        },
    )
    rows = result.mappings().all()
    row = rows[0]
    day_map = {
        str(item["contribution_day"]): int(item["contribution_count"] or 0)
        for item in rows
        if item["contribution_day"] is not None
    }

    connectors_count = await _cached_connectors_count(require_clerk_id(auth))

    return DashboardStatsResponse(
        total_sessions=int(row["total_sessions"] or 0),
        total_messages=int(row["total_messages"] or 0),
        total_tokens=int(row["total_tokens"] or 0),
        active_days=int(row["active_days"] or 0),
        current_streak=int(row["current_streak"] or 0),
        longest_streak=int(row["longest_streak"] or 0),
        peak_hour=int(row["peak_hour"] or 0),
        favorite_model=row["favorite_model"],
        skills_count=int(row["skills_count"] or 0),
        memories_count=int(row["memories_count"] or 0),
        vault_count=int(row["vault_count"] or 0),
        vault_keys_count=int(row["vault_keys_count"] or 0),
        connectors_count=connectors_count,
        manual_sessions_last_7_days=int(row["manual_sessions_last_7_days"] or 0),
        automated_sessions_last_7_days=int(row["automated_sessions_last_7_days"] or 0),
        top_model_last_7_days=row["top_model_last_7_days"],
        sessions_today=int(row["sessions_today"] or 0),
        contribution=_build_contribution_graph(
            day_map,
            since_date=since.date(),
            end_date=now.date(),
        ),
    )


async def _cached_connectors_count(clerk_id: str) -> int:
    if not settings.composio_api_key:
        return 0

    now = datetime.now(UTC)
    cached = _connectors_count_cache.get(clerk_id)
    if cached and cached[0] > now:
        return cached[1]

    try:
        # Composio entity_id is the Clerk user id, not the local PG UUID.
        accounts = await asyncio.wait_for(
            composio.get_connected_accounts(clerk_id),
            timeout=_CONNECTORS_COUNT_TIMEOUT_SECONDS,
        )
    except (composio.ComposioRouteError, TimeoutError) as exc:
        log.warning(
            "dashboard connectors count unavailable: error_type=%s",
            type(exc).__name__,
        )
        return cached[1] if cached else 0

    connectors_count = sum(1 for account in accounts if account.status.upper() == "ACTIVE")
    _remember_connectors_count(clerk_id, connectors_count, now=now)
    return connectors_count


def _remember_connectors_count(clerk_id: str, count: int, *, now: datetime) -> None:
    expired_keys = [
        key for key, (expires_at, _) in _connectors_count_cache.items() if expires_at <= now
    ]
    for key in expired_keys:
        _connectors_count_cache.pop(key, None)

    if len(_connectors_count_cache) >= _CONNECTORS_COUNT_CACHE_MAX:
        oldest_key = min(_connectors_count_cache, key=lambda key: _connectors_count_cache[key][0])
        _connectors_count_cache.pop(oldest_key, None)

    _connectors_count_cache[clerk_id] = (now + _CONNECTORS_COUNT_CACHE_TTL, count)


@router.get("/contribution")
async def get_contribution_graph(
    response: Response,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
    days: int = Query(default=365, ge=1, le=_DASHBOARD_DAYS_MAX),
) -> list[ContributionDayResponse]:
    response.headers["Cache-Control"] = "private, max-age=30, stale-while-revalidate=30"
    now = datetime.now(UTC)
    since = now - timedelta(days=days)

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

    day_map = {str(r[0]): int(r[1]) for r in rows}
    return _build_contribution_graph(
        day_map,
        since_date=since.date(),
        end_date=now.date(),
    )


def _build_contribution_graph(
    day_map: dict[str, int],
    *,
    since_date: date,
    end_date: date,
) -> list[ContributionDayResponse]:
    max_count = max(day_map.values()) if day_map else 1

    contributions: list[ContributionDayResponse] = []
    current = since_date
    while current <= end_date:
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
