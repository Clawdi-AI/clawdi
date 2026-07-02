import pytest
from sqlalchemy import select

from app.models.project import PROJECT_KIND_WORKSPACE, Project

pytestmark = pytest.mark.asyncio


async def test_create_project_generates_workspace_slug(client, db_session, seed_user):
    response = await client.post("/v1/projects", json={"name": "Engineering Toolkit"})

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Engineering Toolkit"
    assert body["slug"] == "engineering-toolkit"
    assert body["kind"] == PROJECT_KIND_WORKSPACE
    assert body["is_owner"] is True

    result = await db_session.execute(
        select(Project).where(
            Project.user_id == seed_user.id,
            Project.slug == "engineering-toolkit",
        )
    )
    project = result.scalar_one()
    assert project.kind == PROJECT_KIND_WORKSPACE


async def test_create_project_suffixes_duplicate_slug(client):
    first = await client.post("/v1/projects", json={"name": "Client Alpha"})
    second = await client.post("/v1/projects", json={"name": "Client Alpha"})

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["slug"] == "client-alpha"
    assert second.json()["slug"] == "client-alpha-2"


async def test_create_project_rejects_duplicate_explicit_slug(client):
    first = await client.post(
        "/v1/projects",
        json={"name": "Client Alpha", "slug": "client-alpha"},
    )
    second = await client.post(
        "/v1/projects", json={"name": "Another Client", "slug": "client-alpha"}
    )

    assert first.status_code == 201
    assert second.status_code == 409


async def test_create_project_rejects_invalid_slug(client):
    response = await client.post(
        "/v1/projects",
        json={"name": "Valid Name", "slug": "../bad"},
    )

    assert response.status_code == 422
