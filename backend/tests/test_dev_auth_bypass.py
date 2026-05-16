from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import HTTPException
from httpx import ASGITransport
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import _auth_via_dev_bypass
from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.project import PROJECT_KIND_PERSONAL, Project
from app.models.user import User


@pytest.mark.asyncio
async def test_dev_auth_bypass_disabled_returns_none(db_session: AsyncSession, monkeypatch) -> None:
    monkeypatch.setattr(settings, "dev_auth_bypass", False)

    ctx = await _auth_via_dev_bypass("dev-bypass", db_session)

    assert ctx is None


@pytest.mark.asyncio
async def test_dev_auth_bypass_refuses_non_development(
    db_session: AsyncSession, monkeypatch
) -> None:
    monkeypatch.setattr(settings, "dev_auth_bypass", True)
    monkeypatch.setattr(settings, "dev_auth_token", "dev-bypass")
    monkeypatch.setattr(settings, "environment", "production")

    with pytest.raises(HTTPException) as exc:
        await _auth_via_dev_bypass("dev-bypass", db_session)

    assert exc.value.status_code == 500


@pytest.mark.asyncio
async def test_dev_auth_bypass_authenticates_web_route_and_creates_personal_project(
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    clerk_id = f"dev_test_{uuid.uuid4().hex[:12]}"
    monkeypatch.setattr(settings, "dev_auth_bypass", True)
    monkeypatch.setattr(settings, "dev_auth_token", "dev-bypass")
    monkeypatch.setattr(settings, "dev_auth_clerk_id", clerk_id)
    monkeypatch.setattr(settings, "dev_auth_email", "dev-test@clawdi.local")
    monkeypatch.setattr(settings, "dev_auth_name", "Dev Test User")
    monkeypatch.setattr(settings, "environment", "development")

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override_get_session
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.get(
                "/api/auth/me",
                headers={"Authorization": "Bearer dev-bypass"},
            )

        assert response.status_code == 200
        body = response.json()
        assert body["auth_type"] == "clerk"
        assert body["email"] == "dev-test@clawdi.local"
        assert body["name"] == "Dev Test User"

        user = (
            await db_session.execute(select(User).where(User.clerk_id == clerk_id))
        ).scalar_one()
        personal_project = (
            await db_session.execute(
                select(Project).where(
                    Project.user_id == user.id,
                    Project.kind == PROJECT_KIND_PERSONAL,
                )
            )
        ).scalar_one()
        assert personal_project.slug == "personal"
    finally:
        app.dependency_overrides.clear()
        existing = (
            await db_session.execute(select(User).where(User.clerk_id == clerk_id))
        ).scalar_one_or_none()
        if existing is not None:
            await db_session.delete(existing)
            await db_session.commit()
