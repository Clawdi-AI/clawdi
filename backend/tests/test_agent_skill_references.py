from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

import pytest
from sqlalchemy import select

from app.core.auth import AuthContext
from app.core.config import settings
from app.models.agent_project_binding import AgentProjectBinding
from app.models.hosted_runtime import HostedRuntimeState
from app.models.project_membership import ProjectMembership
from app.models.skill import AgentSkillReference, Skill
from app.models.user import User
from app.schemas.runtime_observation import RuntimeObservationEventV2
from app.services.runtime_observation import (
    ingest_runtime_observation,
    provision_runtime_environment_fence,
)
from app.services.runtime_source import (
    load_runtime_source_batch,
    render_runtime_source,
    vault_key_identity,
)
from tests.test_project_runtime_skills import (
    _link,
    _make_runtime_renderable,
    _set_auth,
    _upload_project_skill,
)
from tests.test_runtime_observation_companion import _payload


async def source_skill(client, db, project):
    response = await _upload_project_skill(
        client, project.id, "devops/runbook", local_skill_key="runbook"
    )
    assert response.status_code == 200, response.text
    return await db.scalar(
        select(Skill).where(
            Skill.project_id == project.id, Skill.skill_key == "devops/runbook", Skill.is_active
        )
    )


async def rendered(db, agent_id):
    batch = await load_runtime_source_batch(db, environment_ids=[agent_id])
    return render_runtime_source(
        batch,
        environment_id=agent_id,
        public_api_url=settings.public_api_url,
        vault_key_identity=vault_key_identity(settings.vault_encryption_key),
        decrypt_secrets=False,
    )


@pytest.mark.asyncio
async def test_reference_follows_source_without_project_binding_and_revokes_old_download(
    client, db_session, seed_user, workspace_project, channel_agent
):
    skill = await source_skill(client, db_session, workspace_project)
    await _make_runtime_renderable(db_session, user=seed_user, agent_id=channel_agent.id)
    path = f"/v1/agents/{channel_agent.id}/skill-references/{skill.id}"
    assert (await client.put(path)).status_code == 202
    assert (
        await db_session.scalar(
            select(AgentProjectBinding.id).where(
                AgentProjectBinding.agent_id == channel_agent.id,
                AgentProjectBinding.project_id == workspace_project.id,
            )
        )
        is None
    )
    inventory = (await client.get(f"/v1/agents/{channel_agent.id}/skills")).json()
    row = next(item for item in inventory["skills"] if item["skill_id"] == str(skill.id))
    assert (
        row["skill_key"],
        row["source_skill_key"],
        row["source"],
        row["read_only"],
        row["convergence"],
    ) == ("runbook", "devops/runbook", "library", False, "not_observed")
    detail = await client.get(path)
    assert detail.status_code == 200
    assert detail.json()["project_id"] == str(workspace_project.id)
    assert "Project runtime" in detail.json()["content"]
    first = await rendered(db_session, channel_agent.id)
    old_url = first.manifest["skills"]["entries"]["runbook"]["source"]["archiveUrl"]
    assert (await client.get(urlsplit(old_url).path)).status_code == 200
    update = await _upload_project_skill(
        client,
        workspace_project.id,
        "devops/runbook",
        marker="New source",
        local_skill_key="runbook",
    )
    assert update.status_code == 200, update.text
    second = await rendered(db_session, channel_agent.id)
    assert second.source_revision != first.source_revision
    assert (await client.get(urlsplit(old_url).path)).status_code == 404
    current_url = second.manifest["skills"]["entries"]["runbook"]["source"]["archiveUrl"]
    assert (await client.delete(path)).status_code == 202
    assert (await client.get(path)).status_code == 404
    assert (await client.get(urlsplit(current_url).path)).status_code == 404
    assert (await client.get(f"/v1/agents/{channel_agent.id}/skills")).json()["skills"] == []
    assert (await db_session.get(Skill, skill.id)).is_active
    assert (await client.put(path)).status_code == 202
    deleted = await client.delete(f"/v1/projects/{workspace_project.id}/skills/devops/runbook")
    assert deleted.status_code == 200, deleted.text
    assert (await client.get(urlsplit(current_url).path)).status_code == 404
    assert (await client.get(f"/v1/agents/{channel_agent.id}/skills")).json()["skills"] == []
    assert (await client.get(path)).status_code == 404


@pytest.mark.asyncio
async def test_reference_rejects_conflicts_and_deduplicates_linked_source(
    client, db_session, seed_user, workspace_project, channel_agent
):
    skill = await source_skill(client, db_session, workspace_project)
    await _make_runtime_renderable(db_session, user=seed_user, agent_id=channel_agent.id)
    state = await db_session.get(HostedRuntimeState, channel_agent.id)
    state.skills = {
        "entries": {
            "runbook": {
                "enabled": True,
                "source": {
                    "type": "github",
                    "url": "https://github.com/example/skills",
                    "path": "runbook",
                    "commit": "a" * 40,
                },
            }
        }
    }
    await db_session.commit()
    path = f"/v1/agents/{channel_agent.id}/skill-references/{skill.id}"
    assert (await client.put(path)).status_code == 409
    assert await db_session.get(AgentSkillReference, (channel_agent.id, skill.id)) is None
    state.skills = None
    await db_session.commit()
    assert (
        await _link(client, agent_id=channel_agent.id, project_id=workspace_project.id)
    ).status_code == 200
    assert (await client.put(path)).status_code == 202
    assert await db_session.get(AgentSkillReference, (channel_agent.id, skill.id)) is None
    row = (await client.get(f"/v1/agents/{channel_agent.id}/skills")).json()["skills"][0]
    assert row["source"] == "project" and row["read_only"] is True


@pytest.mark.asyncio
async def test_shared_source_read_permission_is_rechecked_and_revocation_removes_reference(
    client, db_session, seed_user, workspace_project, channel_agent
):
    skill = await source_skill(client, db_session, workspace_project)
    await _make_runtime_renderable(db_session, user=seed_user, agent_id=channel_agent.id)
    owner = User(clerk_id=f"library-owner-{uuid.uuid4().hex}", email="library-owner@example.test")
    db_session.add(owner)
    await db_session.flush()
    workspace_project.user_id = owner.id
    skill.user_id = owner.id
    db_session.add(
        ProjectMembership(
            project_id=workspace_project.id,
            member_user_id=seed_user.id,
            role="viewer",
            joined_via="invite",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="library-owner",
        )
    )
    await db_session.commit()
    path = f"/v1/agents/{channel_agent.id}/skill-references/{skill.id}"
    assert (await client.put(path)).status_code == 202
    assert (await client.get(path)).status_code == 200
    source = await rendered(db_session, channel_agent.id)
    archive = source.manifest["skills"]["entries"]["runbook"]["source"]["archiveUrl"]
    _set_auth(AuthContext(user=owner))
    response = await client.delete(f"/v1/projects/{workspace_project.id}/members/{seed_user.id}")
    assert response.status_code == 200, response.text
    _set_auth(AuthContext(user=seed_user))
    assert await db_session.get(AgentSkillReference, (channel_agent.id, skill.id)) is None
    assert (await client.get(path)).status_code == 404
    assert (await client.get(urlsplit(archive).path)).status_code == 404
    assert (await client.put(path)).status_code == 403
    # An Agent Workspace projection cannot be selected as a Library source.
    workspace_project.user_id = seed_user.id
    skill.user_id = seed_user.id
    skill.authority = "agent_sync"
    skill.authority_agent_id = channel_agent.id
    await db_session.commit()
    assert (await client.put(path)).status_code == 404


@pytest.mark.asyncio
async def test_canonical_observations_fence_revision_instance_generation_and_removed_readd(
    client, db_session, seed_user, workspace_project, channel_agent
):
    skill = await source_skill(client, db_session, workspace_project)
    await _make_runtime_renderable(db_session, user=seed_user, agent_id=channel_agent.id)
    path = f"/v1/agents/{channel_agent.id}/skill-references/{skill.id}"
    inventory_path = f"/v1/agents/{channel_agent.id}/skills"
    assert (await client.put(path)).status_code == 202
    state = await db_session.get(HostedRuntimeState, channel_agent.id)
    await provision_runtime_environment_fence(
        db_session,
        environment_id=channel_agent.id,
        owner_id=seed_user.id,
        deployment_id=state.deployment_id,
    )
    initial = (await client.get(inventory_path)).json()["skills"][0]
    captured = datetime.now(UTC)

    async def observe(
        sequence,
        *,
        status="installed",
        desired="present",
        instance=None,
        revision=None,
        generation=None,
        capture=None,
        boot="boot-session-0001",
    ):
        current_revision = revision or state.source_revision
        current_generation = generation or state.apply_generation or state.generation
        body = _payload(
            sequence=sequence,
            boot_session_id=boot,
            generation=current_generation,
            captured_at=capture or datetime.now(UTC),
        ).model_dump(mode="json", by_alias=True)
        body["applied"].update(
            instanceId=instance or state.instance_id,
            sourceRevision=current_revision,
            etag=f'"sha256:{current_revision}"',
        )
        body["skills"] = {
            "schemaVersion": 1,
            "entries": [
                {
                    "skillKey": "runbook",
                    "runtime": "openclaw",
                    "sourceIdentity": initial["source_identity"],
                    "digest": "c" * 64,
                    "sourceRevision": current_revision,
                    "generation": current_generation,
                    "desiredState": desired,
                    "status": status,
                    "errorCode": "reconcile_failed" if status == "failed" else None,
                }
            ],
        }
        await ingest_runtime_observation(
            db_session,
            environment_id=channel_agent.id,
            credential_deployment_id=state.deployment_id,
            value=RuntimeObservationEventV2.model_validate(body),
        )
        await db_session.commit()

    await observe(1, capture=captured)
    assert (await client.get(inventory_path)).json()["skills"][0]["convergence"] == "installed"
    await observe(2, instance="previous-instance")
    assert (await client.get(inventory_path)).json()["skills"][0]["convergence"] == "not_observed"
    await observe(3, revision="f" * 64)
    assert (await client.get(inventory_path)).json()["skills"][0]["convergence"] == "not_observed"
    await observe(4)
    assert (await client.delete(path)).status_code == 202
    await observe(5, status="failed", desired="absent")
    removed = (await client.get(inventory_path)).json()
    assert removed["skills"] == []
    assert removed["removal_failures"] == [
        {"skill_key": "runbook", "observation_error_code": "reconcile_failed"}
    ]
    assert (await client.put(path)).status_code == 202
    readded = (await client.get(inventory_path)).json()
    assert (
        readded["removal_failures"] == [] and readded["skills"][0]["convergence"] == "not_observed"
    )
    # An old captured success remains stale even when its delivery/sequence is new.
    await observe(6, capture=captured + timedelta(microseconds=1))
    assert (await client.get(inventory_path)).json()["skills"][0]["convergence"] == "not_observed"
    await observe(7)
    assert (await client.get(inventory_path)).json()["skills"][0]["convergence"] == "installed"
    await observe(1, boot="ambiguous-second-boot")
    assert (await client.get(inventory_path)).json()["skills"][0]["convergence"] == "not_observed"
    state.apply_generation = (state.apply_generation or state.generation) + 1
    await db_session.commit()
    assert (await client.get(inventory_path)).json()["skills"][0]["convergence"] == "not_observed"


@pytest.mark.asyncio
@pytest.mark.parametrize("cleanup", ["archive", "delete"])
async def test_agent_project_cleanup_captures_reference_consumers(
    client,
    db_session,
    seed_user,
    channel_agent,
    second_channel_agent,
    cleanup,
):
    from app.services.agent_lifecycle import archive_agent_and_project
    from app.services.agent_skill_projection import delete_agent_project_skill_rows

    source = Skill(
        user_id=seed_user.id,
        project_id=channel_agent.default_project_id,
        skill_key="legacy-runbook",
        name="legacy-runbook",
        content_hash="d" * 64,
    )
    db_session.add(source)
    await db_session.commit()
    await _make_runtime_renderable(db_session, user=seed_user, agent_id=second_channel_agent.id)
    path = f"/v1/agents/{second_channel_agent.id}/skill-references/{source.id}"
    response = await client.put(path)
    assert response.status_code == 202, response.text
    state = await db_session.get(HostedRuntimeState, second_channel_agent.id)
    previous_revision = state.source_revision
    if cleanup == "archive":
        await archive_agent_and_project(db_session, agent=channel_agent)
    else:
        await delete_agent_project_skill_rows(db_session, agent=channel_agent)
    await db_session.commit()
    assert await db_session.get(AgentSkillReference, (second_channel_agent.id, source.id)) is None
    assert state.source_revision != previous_revision
    response = await client.get(f"/v1/agents/{second_channel_agent.id}/skills")
    assert response.status_code == 200 and response.json()["skills"] == []
