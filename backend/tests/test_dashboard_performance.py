from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.config import settings
from app.models.memory import Memory
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.project_membership import ProjectMembership
from app.models.session import Session
from app.models.skill import Skill
from app.models.user import User
from app.models.vault import Vault, VaultItem, VaultProjectAttachment


async def _seed_dashboard_sessions(db_session: AsyncSession, user_id) -> datetime:
    now = datetime.now(UTC).replace(microsecond=0)
    day_offsets = [0, 1, 2, 5, 6, 7, 8]
    sessions = [
        Session(
            user_id=user_id,
            local_session_id=f"dashboard-perf-{offset}",
            started_at=now - timedelta(days=offset),
            last_activity_at=now - timedelta(days=offset),
            message_count=offset + 1,
            input_tokens=10,
            output_tokens=5,
            model="claude-sonnet" if offset < 5 else "gpt-4o-mini",
        )
        for offset in day_offsets
    ]
    db_session.add_all(sessions)
    await db_session.commit()
    return now


@pytest.mark.asyncio
async def test_dashboard_stats_uses_bounded_database_round_trips(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    seed_user,
    seed_project,
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "composio_api_key", "")
    seeded_now = await _seed_dashboard_sessions(db_session, seed_user.id)
    skill = Skill(
        user_id=seed_user.id,
        project_id=seed_project.id,
        skill_key="dashboard-perf",
        name="Dashboard Perf",
        content_hash="abc123",
        is_active=True,
    )
    memory = Memory(user_id=seed_user.id, content="Dashboard memory")
    vault = Vault(user_id=seed_user.id, slug="dashboard-perf", name="Dashboard Perf")
    db_session.add_all([skill, memory, vault])
    await db_session.flush()
    db_session.add(
        VaultItem(
            vault_id=vault.id,
            section="api",
            item_name="TOKEN",
            encrypted_value=b"x",
            nonce=b"y",
        )
    )
    await db_session.commit()

    statements: list[str] = []

    def before_cursor_execute(
        _conn,
        _cursor,
        statement,
        _parameters,
        _context,
        _executemany,
    ) -> None:
        if not statement.lstrip().startswith(("SAVEPOINT", "RELEASE SAVEPOINT")):
            statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", before_cursor_execute)
    try:
        response = await client.get("/v1/dashboard/stats")
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", before_cursor_execute)

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["total_sessions"] == 7
    assert data["active_days"] == 7
    assert data["favorite_model"] == "gpt-4o-mini"
    assert data["peak_hour"] == seeded_now.hour
    assert data["current_streak"] == 3
    assert data["longest_streak"] == 4
    assert data["skills_count"] == 1
    assert data["memories_count"] == 1
    assert data["vault_count"] == 1
    assert data["vault_keys_count"] == 1
    assert data["manual_sessions_last_7_days"] >= 1
    assert data["automated_sessions_last_7_days"] == 0
    assert data["top_model_last_7_days"] == "claude-sonnet"
    contribution_by_date = {entry["date"]: entry["count"] for entry in data["contribution"]}
    assert contribution_by_date[str(datetime.now(UTC).date())] == 1
    assert len(data["contribution"]) >= 365
    assert len(statements) <= 1


@pytest.mark.asyncio
async def test_dashboard_stats_matches_visible_inventory_and_one_week_started_at_window(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    seed_project,
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "composio_api_key", "")
    now = datetime.now(UTC).replace(microsecond=0)
    owner = User(
        clerk_id=f"dashboard-owner-{seed_user.id}",
        email=f"dashboard-owner-{seed_user.id}@clawdi.local",
        name="Dashboard Owner",
    )
    db_session.add(owner)
    await db_session.flush()
    shared_project = Project(
        user_id=owner.id,
        name="Shared Dashboard Project",
        slug="shared-dashboard-project",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(shared_project)
    await db_session.flush()
    db_session.add(
        ProjectMembership(
            project_id=shared_project.id,
            member_user_id=seed_user.id,
            role="viewer",
            joined_via="invite",
            joined_at=now,
            resolved_owner_handle="dashboard-owner",
        )
    )
    db_session.add_all(
        [
            Skill(
                user_id=seed_user.id,
                project_id=seed_project.id,
                skill_key="owned-active",
                name="Owned Active",
                content_hash="owned-active",
                is_active=True,
            ),
            Skill(
                user_id=owner.id,
                project_id=shared_project.id,
                skill_key="shared-active",
                name="Shared Active",
                content_hash="shared-active",
                is_active=True,
            ),
            Skill(
                user_id=owner.id,
                project_id=shared_project.id,
                skill_key="shared-archived",
                name="Shared Archived",
                content_hash="shared-archived",
                is_active=False,
            ),
        ]
    )
    owned_vault = Vault(user_id=seed_user.id, slug="owned", name="Owned")
    shared_vault = Vault(user_id=owner.id, slug="shared", name="Shared")
    hidden_vault = Vault(user_id=owner.id, slug="hidden", name="Hidden")
    db_session.add_all([owned_vault, shared_vault, hidden_vault])
    await db_session.flush()
    db_session.add(VaultProjectAttachment(vault_id=shared_vault.id, project_id=shared_project.id))
    db_session.add_all(
        [
            Session(
                user_id=seed_user.id,
                local_session_id="weekly-manual-1",
                started_at=now - timedelta(days=6, hours=20),
                last_activity_at=now - timedelta(days=30),
                summary="Manual work",
                model="weekly-model",
            ),
            Session(
                user_id=seed_user.id,
                local_session_id="weekly-manual-2",
                started_at=now - timedelta(days=1),
                last_activity_at=now - timedelta(days=30),
                summary=None,
                model="weekly-model",
            ),
            Session(
                user_id=seed_user.id,
                local_session_id="weekly-automated",
                started_at=now - timedelta(minutes=1),
                last_activity_at=now - timedelta(days=30),
                summary="Cron: health check",
                model="automation-model",
            ),
            Session(
                user_id=seed_user.id,
                local_session_id="stale-but-recently-active",
                started_at=now - timedelta(days=8),
                last_activity_at=now,
                summary="Old manual work",
                model="stale-model",
            ),
            Session(
                user_id=seed_user.id,
                local_session_id="historical-inventory-session",
                started_at=now - timedelta(days=400),
                last_activity_at=now - timedelta(days=400),
                summary="Historical work",
                model="historical-model",
            ),
        ]
    )
    await db_session.commit()

    response = await client.get("/v1/dashboard/stats")

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["total_sessions"] == 5
    assert data["manual_sessions_last_7_days"] == 2
    assert data["automated_sessions_last_7_days"] == 1
    assert data["top_model_last_7_days"] == "weekly-model"
    assert data["sessions_today"] == 1
    assert data["skills_count"] == 2
    assert data["vault_count"] == 2


@pytest.mark.asyncio
async def test_dashboard_stats_caches_connector_count(
    client: httpx.AsyncClient,
    monkeypatch,
) -> None:
    from app.services import composio

    monkeypatch.setattr(settings, "composio_api_key", "test-composio-key")

    calls = 0

    async def fake_get_connected_accounts(_clerk_id: str) -> list[dict]:
        nonlocal calls
        calls += 1
        return [{"status": "ACTIVE"}]

    monkeypatch.setattr(composio, "get_connected_accounts", fake_get_connected_accounts)

    first = await client.get("/v1/dashboard/stats")
    second = await client.get("/v1/dashboard/stats")

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["connectors_count"] == 1
    assert second.json()["connectors_count"] == 1
    assert calls == 1


@pytest.mark.asyncio
async def test_projects_list_uses_single_query_for_dashboard_user(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    seed_user,
) -> None:
    owner = User(
        clerk_id=f"project-owner-{seed_user.id}",
        email=f"project-owner-{seed_user.id}@clawdi.local",
        name="Project Owner",
    )
    db_session.add(owner)
    await db_session.flush()
    shared = Project(
        user_id=owner.id,
        name="Shared Project",
        slug="shared-project",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(shared)
    await db_session.flush()
    db_session.add(
        ProjectMembership(
            project_id=shared.id,
            member_user_id=seed_user.id,
            role="viewer",
            joined_via="link",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="project-owner",
        )
    )
    await db_session.commit()

    statements: list[str] = []

    def before_cursor_execute(
        _conn,
        _cursor,
        statement,
        _parameters,
        _context,
        _executemany,
    ) -> None:
        if not statement.lstrip().startswith(("SAVEPOINT", "RELEASE SAVEPOINT")):
            statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", before_cursor_execute)
    try:
        response = await client.get("/v1/projects")
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", before_cursor_execute)
        await db_session.delete(owner)
        await db_session.commit()

    assert response.status_code == 200, response.text
    body = response.json()
    assert any(project["is_owner"] is False for project in body)
    assert len(statements) <= 1


@pytest.mark.asyncio
async def test_sessions_count_query_does_not_compute_share_state(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    seed_user,
) -> None:
    await _seed_dashboard_sessions(db_session, seed_user.id)

    statements: list[str] = []

    def before_cursor_execute(
        _conn,
        _cursor,
        statement,
        _parameters,
        _context,
        _executemany,
    ) -> None:
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", before_cursor_execute)
    try:
        response = await client.get(
            "/v1/sessions",
            params={"page_size": 6, "automated": False},
        )
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", before_cursor_execute)

    assert response.status_code == 200, response.text
    count_statements = [
        statement
        for statement in statements
        if "count(" in statement.lower() or "count(*)" in statement.lower()
    ]
    assert count_statements
    assert all("session_permissions" not in statement.lower() for statement in count_statements)
    assert all("agent_environments" not in statement.lower() for statement in count_statements)
