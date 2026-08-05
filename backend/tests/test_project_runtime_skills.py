from __future__ import annotations

import uuid
from urllib.parse import urlsplit

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.agent_project_binding import AgentProjectBinding
from app.models.hosted_runtime import HostedRuntimeState
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.skill import SKILL_AUTHORITY_CLOUD, Skill
from app.models.user import User
from app.services.runtime_source import (
    load_runtime_source_batch,
    render_runtime_source,
    vault_key_identity,
)
from app.services.tar_utils import tar_from_content
from tests.hosted_runtime_fixtures import (
    CANONICAL_CODEX_TOOLS,
    canonical_codex_tool_provider_graph,
)


def _skill_archive(skill_key: str, marker: str = "Project runtime") -> bytes:
    content = f"---\nname: {skill_key}\ndescription: Project runtime test\n---\n# {marker}\n"
    archive, _ = tar_from_content(skill_key, content)
    return archive


async def _upload_project_skill(
    client: httpx.AsyncClient,
    project_id: uuid.UUID,
    skill_key: str,
    marker: str = "Project runtime",
) -> httpx.Response:
    return await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": skill_key},
        files={
            "file": (
                f"{skill_key}.tar.gz",
                _skill_archive(skill_key, marker),
                "application/gzip",
            )
        },
    )


async def _link(
    client: httpx.AsyncClient,
    *,
    agent_id: uuid.UUID,
    project_id: uuid.UUID,
) -> httpx.Response:
    return await client.post(
        f"/v1/agents/{agent_id}/project-bindings/context",
        json={"project_id": str(project_id)},
    )


async def _make_runtime_renderable(
    db_session: AsyncSession,
    *,
    user: User,
    agent_id: uuid.UUID,
) -> None:
    state = await db_session.get(HostedRuntimeState, agent_id)
    assert state is not None
    state.tools = CANONICAL_CODEX_TOOLS
    provider, payload = canonical_codex_tool_provider_graph(user)
    db_session.add_all([provider, payload])
    await db_session.commit()


@pytest.mark.asyncio
async def test_linked_project_skill_is_composed_into_managed_runtime_manifest(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    workspace_project: Project,
    channel_agent,
):
    uploaded = await _upload_project_skill(client, workspace_project.id, "project-review")
    assert uploaded.status_code == 200, uploaded.text
    linked = await _link(
        client,
        agent_id=channel_agent.id,
        project_id=workspace_project.id,
    )
    assert linked.status_code == 200, linked.text

    await _make_runtime_renderable(
        db_session,
        user=seed_user,
        agent_id=channel_agent.id,
    )

    batch = await load_runtime_source_batch(
        db_session,
        environment_ids=[channel_agent.id],
        owner_user_id=seed_user.id,
    )
    rendered = render_runtime_source(
        batch,
        environment_id=channel_agent.id,
        public_api_url="https://cloud.example.test",
        vault_key_identity=vault_key_identity(settings.vault_encryption_key),
        decrypt_secrets=False,
    )

    entry = rendered.manifest["skills"]["entries"]["project-review"]
    assert entry["enabled"] is True
    assert entry["source"]["type"] == "clawdi"
    assert entry["source"]["projectId"] == str(workspace_project.id)
    assert entry["source"]["contentHash"] == uploaded.json()["content_hash"]
    assert urlsplit(entry["source"]["archiveUrl"]).path.endswith("/project-review.tar.gz")
    assert urlsplit(entry["source"]["installUrl"]).path.endswith("/SKILL.md")


@pytest.mark.asyncio
async def test_link_fails_closed_for_workspace_and_sibling_project_skill_conflicts(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    workspace_project: Project,
    channel_agent,
):
    state = await db_session.get(HostedRuntimeState, channel_agent.id)
    assert state is not None
    state.skills = {"entries": {"duplicate": {"enabled": True, "version": 1}}}
    db_session.add(
        Skill(
            user_id=seed_user.id,
            project_id=workspace_project.id,
            skill_key="duplicate",
            name="Duplicate",
            description="Conflicts with the Agent Workspace",
            content_hash="1" * 64,
            authority=SKILL_AUTHORITY_CLOUD,
        )
    )
    await db_session.commit()

    workspace_conflict = await _link(
        client,
        agent_id=channel_agent.id,
        project_id=workspace_project.id,
    )
    assert workspace_conflict.status_code == 409, workspace_conflict.text
    assert workspace_conflict.json()["detail"]["code"] == "project_skill_name_conflict"
    assert (
        await db_session.execute(
            select(AgentProjectBinding).where(
                AgentProjectBinding.agent_id == channel_agent.id,
                AgentProjectBinding.project_id == workspace_project.id,
                AgentProjectBinding.binding_type == "context",
            )
        )
    ).scalar_one_or_none() is None

    state.skills = None
    sibling = Project(
        user_id=seed_user.id,
        name="Sibling Project",
        slug=f"sibling-{uuid.uuid4().hex[:8]}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(sibling)
    await db_session.flush()
    db_session.add(
        Skill(
            user_id=seed_user.id,
            project_id=sibling.id,
            skill_key="duplicate",
            name="Duplicate",
            description="Conflicts with the first linked Project",
            content_hash="2" * 64,
            authority=SKILL_AUTHORITY_CLOUD,
        )
    )
    await db_session.commit()
    first_link = await _link(
        client,
        agent_id=channel_agent.id,
        project_id=workspace_project.id,
    )
    assert first_link.status_code == 200, first_link.text
    sibling_conflict = await _link(
        client,
        agent_id=channel_agent.id,
        project_id=sibling.id,
    )
    assert sibling_conflict.status_code == 409, sibling_conflict.text
    assert sibling_conflict.json()["detail"]["code"] == "project_skill_name_conflict"


@pytest.mark.asyncio
async def test_connected_agent_and_project_skill_write_fail_before_mutation(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    workspace_project: Project,
    environment_project: Project,
    channel_agent,
):
    db_session.add(
        Skill(
            user_id=seed_user.id,
            project_id=workspace_project.id,
            skill_key="managed-only",
            name="Managed only",
            description="Requires managed delivery",
            content_hash="3" * 64,
            authority=SKILL_AUTHORITY_CLOUD,
        )
    )
    await db_session.commit()
    connected_conflict = await _link(
        client,
        agent_id=environment_project.origin_environment_id,
        project_id=workspace_project.id,
    )
    assert connected_conflict.status_code == 409, connected_conflict.text
    assert connected_conflict.json()["detail"]["code"] == "project_skills_require_managed_agent"

    empty_project = Project(
        user_id=seed_user.id,
        name="Empty linked Project",
        slug=f"empty-{uuid.uuid4().hex[:8]}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(empty_project)
    await db_session.commit()
    linked = await _link(client, agent_id=channel_agent.id, project_id=empty_project.id)
    assert linked.status_code == 200, linked.text
    state = await db_session.get(HostedRuntimeState, channel_agent.id)
    assert state is not None
    state.skills = {"entries": {"write-conflict": {"enabled": True, "version": 1}}}
    await db_session.commit()

    rejected = await _upload_project_skill(client, empty_project.id, "write-conflict")
    assert rejected.status_code == 409, rejected.text
    assert rejected.json()["detail"]["code"] == "project_skill_name_conflict"
    assert (
        await db_session.execute(
            select(Skill).where(
                Skill.project_id == empty_project.id,
                Skill.skill_key == "write-conflict",
                Skill.is_active,
            )
        )
    ).scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_link_rejects_project_skill_name_outside_native_runtime_contract(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    workspace_project: Project,
    channel_agent,
):
    db_session.add(
        Skill(
            user_id=seed_user.id,
            project_id=workspace_project.id,
            skill_key="not_openclaw_safe",
            name="Not OpenClaw safe",
            description="The desired state must be installable by the native CLI",
            content_hash="4" * 64,
            authority=SKILL_AUTHORITY_CLOUD,
        )
    )
    await db_session.commit()

    rejected = await _link(
        client,
        agent_id=channel_agent.id,
        project_id=workspace_project.id,
    )
    assert rejected.status_code == 409, rejected.text
    assert rejected.json()["detail"]["code"] == "project_skill_name_incompatible"
    assert (
        await db_session.execute(
            select(AgentProjectBinding).where(
                AgentProjectBinding.agent_id == channel_agent.id,
                AgentProjectBinding.project_id == workspace_project.id,
            )
        )
    ).scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_signed_project_skill_delivery_stops_working_after_unlink(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    workspace_project: Project,
    channel_agent,
):
    uploaded = await _upload_project_skill(client, workspace_project.id, "signed-skill")
    assert uploaded.status_code == 200, uploaded.text
    linked = await _link(
        client,
        agent_id=channel_agent.id,
        project_id=workspace_project.id,
    )
    assert linked.status_code == 200, linked.text

    await _make_runtime_renderable(
        db_session,
        user=seed_user,
        agent_id=channel_agent.id,
    )

    batch = await load_runtime_source_batch(
        db_session,
        environment_ids=[channel_agent.id],
        owner_user_id=seed_user.id,
    )
    rendered = render_runtime_source(
        batch,
        environment_id=channel_agent.id,
        public_api_url="http://test",
        vault_key_identity=vault_key_identity(settings.vault_encryption_key),
        decrypt_secrets=False,
    )
    archive_url = rendered.manifest["skills"]["entries"]["signed-skill"]["source"]["archiveUrl"]
    install_url = rendered.manifest["skills"]["entries"]["signed-skill"]["source"]["installUrl"]
    archive_before = await client.get(urlsplit(archive_url).path)
    assert archive_before.status_code == 200, archive_before.text
    assert archive_before.headers["content-type"] == "application/gzip"
    before = await client.get(urlsplit(install_url).path)
    assert before.status_code == 200, before.text
    assert b"name: signed-skill" in before.content

    unlinked = await client.delete(
        f"/v1/agents/{channel_agent.id}/project-bindings/{linked.json()['id']}"
    )
    assert unlinked.status_code == 200, unlinked.text
    archive_after = await client.get(urlsplit(archive_url).path)
    assert archive_after.status_code == 404, archive_after.text
    after = await client.get(urlsplit(install_url).path)
    assert after.status_code == 404, after.text
