from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app.models.agent_project_binding import AgentProjectBinding
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.skill import SKILL_AUTHORITY_CLOUD, Skill
from app.models.user import User
from app.models.vault import Vault, VaultProjectAttachment
from app.services import sync_events
from tests.conftest import create_env_with_project

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


async def test_project_detail_reports_server_side_resource_counts(
    client,
    db_session,
    seed_user,
    workspace_project,
    channel_agent,
):
    other_user = User(
        clerk_id=f"project-count-other-{workspace_project.id}",
        email=f"project-count-other-{workspace_project.id}@clawdi.local",
        name="Other Project User",
    )
    db_session.add(other_user)
    await db_session.flush()
    other_agent = await create_env_with_project(
        db_session,
        user_id=other_user.id,
        machine_id=f"project-count-other-{workspace_project.id}",
        machine_name="Other User Agent",
    )
    archived_agent = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"project-count-archived-{workspace_project.id}",
        machine_name="Archived Agent",
    )
    archived_agent.archived_at = datetime.now(UTC)
    vault = Vault(user_id=seed_user.id, slug="counted-vault", name="Counted Vault")
    db_session.add(vault)
    await db_session.flush()
    db_session.add_all(
        [
            Skill(
                user_id=seed_user.id,
                project_id=workspace_project.id,
                skill_key="counted-skill",
                name="Counted Skill",
                description="Counted without a client-side inventory fetch",
                content_hash="a" * 64,
                authority=SKILL_AUTHORITY_CLOUD,
            ),
            VaultProjectAttachment(vault_id=vault.id, project_id=workspace_project.id),
            AgentProjectBinding(
                agent_id=channel_agent.id,
                project_id=workspace_project.id,
                binding_type="context",
                priority=1,
                created_by_user_id=seed_user.id,
            ),
            AgentProjectBinding(
                agent_id=other_agent.id,
                project_id=workspace_project.id,
                binding_type="context",
                priority=1,
                created_by_user_id=seed_user.id,
            ),
            AgentProjectBinding(
                agent_id=archived_agent.id,
                project_id=workspace_project.id,
                binding_type="context",
                priority=1,
                created_by_user_id=seed_user.id,
            ),
        ]
    )
    await db_session.commit()

    response = await client.get(f"/v1/projects/{workspace_project.id}")
    assert response.status_code == 200, response.text
    body = response.json()
    assert {
        key: body[key] for key in ("skill_count", "vault_count", "agent_count", "member_count")
    } == {
        "skill_count": 1,
        "vault_count": 1,
        "agent_count": 1,
        "member_count": 0,
    }


async def test_project_update_and_archive_unlinks_agents_but_protects_workspace(
    client,
    db_session,
    seed_user,
    workspace_project,
    environment_project,
    channel_agent,
):
    linked = await client.post(
        f"/v1/agents/{channel_agent.id}/project-bindings/context",
        json={"project_id": str(workspace_project.id)},
    )
    assert linked.status_code == 200, linked.text
    seed_user.name = "Archive Owner"
    share_link = await client.post(
        f"/v1/projects/{workspace_project.id}/share-links",
        json={},
    )
    assert share_link.status_code == 200, share_link.text
    share_token = share_link.json()["raw_token"]

    updated = await client.patch(
        f"/v1/projects/{workspace_project.id}",
        json={"name": "  Renamed   Project  ", "description": "  Useful bundle  "},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "Renamed Project"
    assert updated.json()["description"] == "Useful bundle"

    protected_update = await client.patch(
        f"/v1/projects/{environment_project.id}",
        json={"name": "Not allowed"},
    )
    protected_archive = await client.delete(f"/v1/projects/{environment_project.id}")
    assert protected_update.status_code == 409, protected_update.text
    assert protected_archive.status_code == 409, protected_archive.text

    queue = sync_events.subscribe(seed_user.id, frozenset(), environment_id=channel_agent.id)
    try:
        archived = await client.delete(f"/v1/projects/{workspace_project.id}")
        assert queue.get_nowait() == {
            "type": "runtime_manifest_changed",
            "environment_id": str(channel_agent.id),
        }
    finally:
        sync_events.unsubscribe(seed_user.id, queue)
    assert archived.status_code == 200, archived.text
    assert archived.json() == {"status": "archived", "unlinked_agent_count": 1}
    assert (
        await db_session.execute(
            select(AgentProjectBinding).where(
                AgentProjectBinding.project_id == workspace_project.id,
                AgentProjectBinding.binding_type == "context",
            )
        )
    ).scalar_one_or_none() is None
    await db_session.refresh(workspace_project)
    assert workspace_project.archived_at is not None
    assert (await client.get(f"/v1/projects/{workspace_project.id}")).status_code == 404
    assert (await client.get(f"/v1/share/{share_token}/preview")).status_code == 410


async def test_agents_project_filter_is_explicit_and_bounded(
    client,
    workspace_project,
    channel_agent,
):
    linked = await client.post(
        f"/v1/agents/{channel_agent.id}/project-bindings/context",
        json={"project_id": str(workspace_project.id)},
    )
    assert linked.status_code == 200, linked.text

    response = await client.get("/v1/agents", params={"project_id": str(workspace_project.id)})
    assert response.status_code == 200, response.text
    assert [agent["id"] for agent in response.json()] == [str(channel_agent.id)]


async def test_project_batch_link_preserves_an_existing_owned_agent(
    client,
    db_session,
    workspace_project,
    channel_agent,
    second_channel_agent,
):
    first_link = await client.post(
        f"/v1/agents/{channel_agent.id}/project-bindings/context",
        json={"project_id": str(workspace_project.id)},
    )
    assert first_link.status_code == 200, first_link.text

    linked = await client.post(
        f"/v1/projects/{workspace_project.id}/agents",
        json={"agent_ids": [str(second_channel_agent.id)]},
    )
    assert linked.status_code == 200, linked.text
    assert linked.json() == {
        "project_id": str(workspace_project.id),
        "bound_agent_ids": [str(second_channel_agent.id)],
    }

    bindings = (
        (
            await db_session.execute(
                select(AgentProjectBinding).where(
                    AgentProjectBinding.project_id == workspace_project.id,
                    AgentProjectBinding.binding_type == "context",
                )
            )
        )
        .scalars()
        .all()
    )
    assert {binding.agent_id for binding in bindings} == {
        channel_agent.id,
        second_channel_agent.id,
    }

    detail = await client.get(f"/v1/projects/{workspace_project.id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["agent_count"] == 2

    filtered = await client.get("/v1/agents", params={"project_id": str(workspace_project.id)})
    assert filtered.status_code == 200, filtered.text
    assert {agent["id"] for agent in filtered.json()} == {
        str(channel_agent.id),
        str(second_channel_agent.id),
    }


async def test_global_search_finds_projects_by_name_and_slug(client):
    created = await client.post("/v1/projects", json={"name": "Redpill Launch"})
    assert created.status_code == 201, created.text
    project_id = created.json()["id"]

    by_name = await client.get("/v1/search", params={"q": "redpill"})
    assert by_name.status_code == 200, by_name.text
    project_hits = [h for h in by_name.json()["results"] if h["type"] == "project"]
    assert [(h["id"], h["href"]) for h in project_hits] == [(project_id, f"/projects/{project_id}")]

    by_slug = await client.get("/v1/search", params={"q": "redpill-launch"})
    slug_hits = [h for h in by_slug.json()["results"] if h["type"] == "project"]
    assert [h["id"] for h in slug_hits] == [project_id]


async def test_global_search_projects_excludes_archived(client):
    created = await client.post("/v1/projects", json={"name": "Archived Search Target"})
    assert created.status_code == 201, created.text
    project_id = created.json()["id"]
    archived = await client.delete(f"/v1/projects/{project_id}")
    assert archived.status_code == 200, archived.text

    response = await client.get("/v1/search", params={"q": "Archived Search Target"})
    assert response.status_code == 200, response.text
    assert [h for h in response.json()["results"] if h["type"] == "project"] == []
