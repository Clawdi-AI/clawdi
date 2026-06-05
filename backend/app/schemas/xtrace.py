from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class XTraceBackfillCreate(BaseModel):
    include_sessions: bool = True
    include_skills: bool = True
    force: bool = False
    dry_run: bool = False
    limit: int | None = Field(default=None, ge=1, le=5000)
    all_users: bool = False


class XTraceBackfillJobResponse(BaseModel):
    id: str
    status: Literal["queued", "running", "succeeded", "failed"]
    requested_by_user_id: str | None
    scope_user_id: str | None
    include_sessions: bool
    include_skills: bool
    force: bool
    dry_run: bool
    limit: int | None
    current_source_type: str | None
    current_source_key: str | None
    considered_count: int
    sent_count: int
    skipped_count: int
    failed_count: int
    mirrored_count: int
    sessions_considered: int
    sessions_sent: int
    sessions_skipped: int
    sessions_failed: int
    sessions_mirrored: int
    skills_considered: int
    skills_sent: int
    skills_skipped: int
    skills_failed: int
    skills_mirrored: int
    error: str | None
    created_at: datetime | None
    updated_at: datetime | None
    started_at: datetime | None
    finished_at: datetime | None
