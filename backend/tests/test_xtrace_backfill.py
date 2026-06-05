from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import UTC, datetime
from uuid import UUID

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.services.file_store import get_file_store
from app.services.tar_utils import tar_from_content
from app.services.xtrace_backfill import run_xtrace_backfill_job


@pytest.mark.asyncio
async def test_xtrace_backfill_job_dry_run_tracks_session_and_skill_progress(
    client: httpx.AsyncClient,
    db_session,
    engine,
    seed_user,
    project_id: str,
    monkeypatch: pytest.MonkeyPatch,
):
    from app.core.config import settings as app_settings
    from app.models.session import Session
    from app.models.skill import Skill

    session_bytes = json.dumps(
        [{"role": "user", "content": "Remember that preview backfills are tracked."}]
    ).encode()
    session_file_key = f"sessions/{seed_user.id}/xtrace-job-session.json"
    await get_file_store().put(session_file_key, session_bytes)
    db_session.add(
        Session(
            user_id=seed_user.id,
            local_session_id="xtrace-job-session",
            started_at=datetime.now(UTC),
            last_activity_at=datetime.now(UTC),
            message_count=1,
            file_key=session_file_key,
            content_hash=hashlib.sha256(session_bytes).hexdigest(),
        )
    )

    skill_bytes, skill_file_count = tar_from_content(
        "xtrace-job-skill",
        "---\nname: xtrace job skill\ndescription: tracked skill\n---\n# Skill\n",
    )
    skill_hash = hashlib.sha256(skill_bytes).hexdigest()
    skill_file_key = f"skills/{seed_user.id}/{project_id}/xtrace-job-skill.tar.gz"
    await get_file_store().put(skill_file_key, skill_bytes)
    db_session.add(
        Skill(
            user_id=seed_user.id,
            project_id=project_id,
            skill_key="xtrace-job-skill",
            name="xtrace job skill",
            description="tracked skill",
            content_hash=skill_hash,
            file_key=skill_file_key,
            file_count=skill_file_count,
            source="local",
        )
    )
    await db_session.commit()

    monkeypatch.setattr(app_settings, "xtrace_memory_enabled", True)
    monkeypatch.setattr(app_settings, "xtrace_api_key", "xtk_test")
    monkeypatch.setattr(app_settings, "xtrace_org_id", "org_test")
    monkeypatch.setattr("app.routes.xtrace._start_job", lambda job_id: None)

    created = await client.post("/api/xtrace/backfills", json={"dry_run": True})
    assert created.status_code == 202, created.text
    job_id = created.json()["id"]
    test_session_factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    await run_xtrace_backfill_job(UUID(job_id), session_factory=test_session_factory)

    job = None
    for _ in range(40):
        status = await client.get(f"/api/xtrace/backfills/{job_id}")
        assert status.status_code == 200, status.text
        job = status.json()
        if job["status"] == "succeeded":
            break
        await asyncio.sleep(0.05)

    assert job is not None
    assert job["status"] == "succeeded"
    assert job["considered_count"] == 2
    assert job["skipped_count"] == 2
    assert job["sent_count"] == 0
    assert job["sessions_considered"] == 1
    assert job["skills_considered"] == 1
    assert job["scope_user_id"] == str(seed_user.id)


@pytest.mark.asyncio
async def test_xtrace_backfill_requires_xtrace_configuration(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    from app.core.config import settings as app_settings

    monkeypatch.setattr(app_settings, "xtrace_memory_enabled", False)

    response = await client.post("/api/xtrace/backfills", json={"dry_run": True})
    assert response.status_code == 503
    assert "not configured" in response.text
