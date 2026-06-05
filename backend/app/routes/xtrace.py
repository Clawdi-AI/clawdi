import asyncio
import hmac
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_scope
from app.core.config import settings
from app.core.database import get_session
from app.models.xtrace_backfill_job import XTraceBackfillJob
from app.schemas.common import Paginated
from app.schemas.xtrace import XTraceBackfillCreate, XTraceBackfillJobResponse
from app.services.xtrace_backfill import create_xtrace_backfill_job, run_xtrace_backfill_job

router = APIRouter(prefix="/api/xtrace", tags=["xtrace"])
log = logging.getLogger(__name__)

_BACKGROUND_TASKS: set[asyncio.Task[None]] = set()


@router.post("/backfills", status_code=status.HTTP_202_ACCEPTED)
async def create_backfill(
    body: XTraceBackfillCreate,
    auth: AuthContext = Depends(require_scope("memories:write")),
    db: AsyncSession = Depends(get_session),
    x_admin_key: str | None = Header(default=None, alias="X-Admin-Key"),
) -> XTraceBackfillJobResponse:
    scope_user_id = None if body.all_users else auth.user_id
    if body.all_users:
        _require_admin_key(x_admin_key)

    try:
        job = await create_xtrace_backfill_job(
            db,
            requested_by_user_id=auth.user_id,
            scope_user_id=scope_user_id,
            include_sessions=body.include_sessions,
            include_skills=body.include_skills,
            force=body.force,
            dry_run=body.dry_run,
            limit=body.limit,
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except RuntimeError as exc:
        message = str(exc)
        status_code = (
            status.HTTP_503_SERVICE_UNAVAILABLE
            if "not configured" in message
            else status.HTTP_409_CONFLICT
        )
        raise HTTPException(status_code, message) from exc

    _start_job(job.id)
    return _job_response(job)


@router.get("/backfills")
async def list_backfills(
    auth: AuthContext = Depends(require_scope("memories:read")),
    db: AsyncSession = Depends(get_session),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
) -> Paginated[XTraceBackfillJobResponse]:
    stmt = (
        select(XTraceBackfillJob)
        .where(
            (XTraceBackfillJob.scope_user_id == auth.user_id)
            | (XTraceBackfillJob.requested_by_user_id == auth.user_id)
        )
        .order_by(desc(XTraceBackfillJob.created_at))
    )
    rows = (
        await db.execute(stmt.offset((page - 1) * page_size).limit(page_size))
    ).scalars().all()
    total = len(
        (
            await db.execute(
                select(XTraceBackfillJob.id).where(
                    (XTraceBackfillJob.scope_user_id == auth.user_id)
                    | (XTraceBackfillJob.requested_by_user_id == auth.user_id)
                )
            )
        ).all()
    )
    return Paginated(
        items=[_job_response(job) for job in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/backfills/{job_id}")
async def get_backfill(
    job_id: UUID,
    auth: AuthContext = Depends(require_scope("memories:read")),
    db: AsyncSession = Depends(get_session),
    x_admin_key: str | None = Header(default=None, alias="X-Admin-Key"),
) -> XTraceBackfillJobResponse:
    job = await db.get(XTraceBackfillJob, job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "backfill job not found")
    if job.scope_user_id == auth.user_id or job.requested_by_user_id == auth.user_id:
        return _job_response(job)
    _require_admin_key(x_admin_key)
    return _job_response(job)


def _start_job(job_id: UUID) -> None:
    task = asyncio.create_task(run_xtrace_backfill_job(job_id), name=f"xtrace-backfill-{job_id}")
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)


def _require_admin_key(x_admin_key: str | None) -> None:
    expected = settings.admin_api_key
    if not expected:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "admin endpoints are disabled (admin_api_key not configured)",
        )
    if not x_admin_key or not hmac.compare_digest(x_admin_key, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid admin auth")


def _job_response(job: XTraceBackfillJob) -> XTraceBackfillJobResponse:
    return XTraceBackfillJobResponse(
        id=str(job.id),
        status=job.status,
        requested_by_user_id=str(job.requested_by_user_id) if job.requested_by_user_id else None,
        scope_user_id=str(job.scope_user_id) if job.scope_user_id else None,
        include_sessions=job.include_sessions,
        include_skills=job.include_skills,
        force=job.force,
        dry_run=job.dry_run,
        limit=job.limit,
        current_source_type=job.current_source_type,
        current_source_key=job.current_source_key,
        considered_count=job.considered_count,
        sent_count=job.sent_count,
        skipped_count=job.skipped_count,
        failed_count=job.failed_count,
        mirrored_count=job.mirrored_count,
        sessions_considered=job.sessions_considered,
        sessions_sent=job.sessions_sent,
        sessions_skipped=job.sessions_skipped,
        sessions_failed=job.sessions_failed,
        sessions_mirrored=job.sessions_mirrored,
        skills_considered=job.skills_considered,
        skills_sent=job.skills_sent,
        skills_skipped=job.skills_skipped,
        skills_failed=job.skills_failed,
        skills_mirrored=job.skills_mirrored,
        error=job.error,
        created_at=job.created_at,
        updated_at=job.updated_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
    )
