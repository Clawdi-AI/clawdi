from __future__ import annotations

import io
import tarfile
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth, get_auth_short_session
from app.core.config import settings
from app.main import app
from app.models.agent_project_binding import AgentProjectBinding
from app.models.api_key import ApiKey
from app.models.hosted_runtime import HostedRuntimeConfigObservation, HostedRuntimeState
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.session import AgentEnvironment
from app.models.skill import SKILL_AUTHORITY_AGENT_SYNC, SKILL_AUTHORITY_CLOUD, Skill
from app.models.user import User
from app.routes import skills as skill_routes
from app.routes.skills import _compute_file_tree_hash
from app.services import project_runtime_skills
from app.services.file_store import get_file_store
from app.services.project_runtime_skills import CONNECTED_PROJECT_SKILL_CAPABILITY_TTL
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


def _skill_archive(
    skill_key: str,
    marker: str = "Project runtime",
    *,
    local_skill_key: str | None = None,
) -> bytes:
    content = (
        f"---\nname: {local_skill_key or skill_key}\n"
        f"description: Project runtime test\n---\n# {marker}\n"
    )
    archive, _ = tar_from_content(skill_key, content)
    return archive


async def _upload_project_skill(
    client: httpx.AsyncClient,
    project_id: uuid.UUID,
    skill_key: str,
    marker: str = "Project runtime",
    *,
    local_skill_key: str | None = None,
) -> httpx.Response:
    return await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": skill_key},
        files={
            "file": (
                f"{skill_key}.tar.gz",
                _skill_archive(skill_key, marker, local_skill_key=local_skill_key),
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


def _set_auth(auth: AuthContext) -> None:
    async def current_auth() -> AuthContext:
        return auth

    app.dependency_overrides[get_auth] = current_auth
    app.dependency_overrides[get_auth_short_session] = current_auth


def _connected_agent_auth(user: User) -> AuthContext:
    return AuthContext(
        user=user,
        api_key=ApiKey(
            user_id=user.id,
            key_hash="0" * 64,
            key_prefix="clawdi_test",
            label="test",
            environment_id=None,
            scopes=["skills:read", "skills:write"],
            managed=False,
        ),
    )


async def _report_connected_project_skill_capability(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    *,
    user: User,
    agent_id: uuid.UUID,
) -> httpx.Response:
    _set_auth(_connected_agent_auth(user))
    try:
        agent = await db_session.get(AgentEnvironment, agent_id)
        assert agent is not None
        registered = await client.post(
            "/v1/agents",
            json={
                "machine_id": agent.machine_id,
                "machine_name": agent.machine_name,
                "agent_type": agent.agent_type,
                "agent_version": agent.agent_version,
                "os": agent.os,
            },
        )
        assert registered.status_code == 200, registered.text
        assert registered.json()["id"] == str(agent_id)
        return await client.put(
            "/v1/runtime/project-skill-capability",
            params={"environment_id": str(agent_id)},
            json={"project_skill_reconcile_version": 1},
        )
    finally:
        _set_auth(AuthContext(user=user))


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
    source_skill_key = "devops/phala-cloud-admin-ops"
    local_skill_key = "phala-cloud-admin-ops"
    uploaded = await _upload_project_skill(
        client,
        workspace_project.id,
        source_skill_key,
        local_skill_key=local_skill_key,
    )
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

    entry = rendered.manifest["skills"]["entries"][local_skill_key]
    assert entry["enabled"] is True
    assert entry["source"]["type"] == "project"
    assert entry["source"]["projectId"] == str(workspace_project.id)
    assert entry["source"]["contentHash"] == uploaded.json()["content_hash"]
    archive_path = urlsplit(entry["source"]["archiveUrl"]).path
    assert archive_path.endswith(f"/{local_skill_key}.tar.gz")
    assert urlsplit(entry["source"]["installUrl"]).path.endswith("/SKILL.md")

    archive = await client.get(archive_path)
    assert archive.status_code == 200, archive.text
    with tarfile.open(fileobj=io.BytesIO(archive.content), mode="r:gz") as result:
        assert result.getnames() == [f"{local_skill_key}/SKILL.md"]


@pytest.mark.asyncio
async def test_connected_project_skill_desired_inventory_uses_local_name(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    workspace_project: Project,
    environment_project: Project,
):
    agent_id = environment_project.origin_environment_id
    assert agent_id is not None
    uploaded = await _upload_project_skill(
        client,
        workspace_project.id,
        "devops/phala-cloud-admin-ops",
        local_skill_key="phala-cloud-admin-ops",
    )
    assert uploaded.status_code == 200, uploaded.text
    capability = await _report_connected_project_skill_capability(
        client,
        db_session,
        user=seed_user,
        agent_id=agent_id,
    )
    assert capability.status_code == 204, capability.text
    linked = await _link(client, agent_id=agent_id, project_id=workspace_project.id)
    assert linked.status_code == 200, linked.text

    _set_auth(_connected_agent_auth(seed_user))
    try:
        desired = await client.get(
            "/v1/runtime/project-skills",
            params={"environment_id": str(agent_id)},
        )
    finally:
        _set_auth(AuthContext(user=seed_user))
    assert desired.status_code == 200, desired.text
    assert desired.json()["skills"][0]["skill_key"] == "phala-cloud-admin-ops"
    assert desired.json()["skills"][0]["archive_url"].endswith("/phala-cloud-admin-ops.tar.gz")


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
            name="duplicate",
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
            skill_key="team/duplicate",
            name="duplicate",
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
            name="managed-only",
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
    assert connected_conflict.json()["detail"] == {
        "code": "project_skill_delivery_update_required",
        "message": "Update this Agent, then try again.",
    }

    capability = await _report_connected_project_skill_capability(
        client,
        db_session,
        user=seed_user,
        agent_id=environment_project.origin_environment_id,
    )
    assert capability.status_code == 204, capability.text

    connected_workspace_conflict = Project(
        user_id=seed_user.id,
        name="Connected Workspace conflict",
        slug=f"connected-conflict-{uuid.uuid4().hex[:8]}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(connected_workspace_conflict)
    await db_session.flush()
    db_session.add_all(
        [
            Skill(
                user_id=seed_user.id,
                project_id=environment_project.id,
                skill_key="connected-local",
                name="connected-local",
                description="Observed Agent Workspace projection",
                content_hash="5" * 64,
                authority=SKILL_AUTHORITY_AGENT_SYNC,
                authority_agent_id=environment_project.origin_environment_id,
            ),
            Skill(
                user_id=seed_user.id,
                project_id=connected_workspace_conflict.id,
                skill_key="team/connected-local",
                name="connected-local",
                description="Conflicts with the Agent Workspace",
                content_hash="6" * 64,
                authority=SKILL_AUTHORITY_CLOUD,
            ),
        ]
    )
    await db_session.commit()
    known_local_conflict = await _link(
        client,
        agent_id=environment_project.origin_environment_id,
        project_id=connected_workspace_conflict.id,
    )
    assert known_local_conflict.status_code == 409, known_local_conflict.text
    assert known_local_conflict.json()["detail"]["code"] == "project_skill_name_conflict"
    assert (
        await db_session.execute(
            select(AgentProjectBinding).where(
                AgentProjectBinding.agent_id == environment_project.origin_environment_id,
                AgentProjectBinding.project_id == connected_workspace_conflict.id,
            )
        )
    ).scalar_one_or_none() is None

    connected_link = await _link(
        client,
        agent_id=environment_project.origin_environment_id,
        project_id=workspace_project.id,
    )
    assert connected_link.status_code == 200, connected_link.text

    duplicate_local_name = await _upload_project_skill(
        client,
        workspace_project.id,
        "devops/managed-only",
        local_skill_key="managed-only",
    )
    assert duplicate_local_name.status_code == 409, duplicate_local_name.text
    assert duplicate_local_name.json()["detail"]["code"] == "project_skill_name_conflict"

    # A downgraded Connected Agent still emits the byte-frozen heartbeat contract,
    # but it cannot renew the separate Project Skill lease. Once that observation
    # is stale, every graph mutation fails closed without disturbing the existing
    # linked Project or its Vault access.
    downgraded = await client.post(
        f"/v1/agents/{environment_project.origin_environment_id}/sync-heartbeat",
        json={},
    )
    assert downgraded.status_code == 204, downgraded.text
    connected_agent = await db_session.get(
        AgentEnvironment,
        environment_project.origin_environment_id,
    )
    assert connected_agent is not None
    assert connected_agent.connected_agent_registered_at is not None
    assert connected_agent.project_skill_reconcile_version == 1
    connected_agent.project_skill_reconcile_observed_at = (
        datetime.now(UTC) - CONNECTED_PROJECT_SKILL_CAPABILITY_TTL - timedelta(seconds=1)
    )
    await db_session.commit()
    rejected_connected_write = await _upload_project_skill(
        client,
        workspace_project.id,
        "after-downgrade",
    )
    assert rejected_connected_write.status_code == 409, rejected_connected_write.text
    assert rejected_connected_write.json()["detail"] == {
        "code": "project_skill_delivery_update_required",
        "message": "Update this Agent, then try again.",
    }
    rejected_connected_delete = await client.delete(
        f"/v1/projects/{workspace_project.id}/skills/managed-only"
    )
    assert rejected_connected_delete.status_code == 409, rejected_connected_delete.text
    assert rejected_connected_delete.json()["detail"] == {
        "code": "project_skill_delivery_update_required",
        "message": "Update this Agent, then try again.",
    }
    assert (
        await db_session.execute(
            select(Skill).where(
                Skill.project_id == workspace_project.id,
                Skill.skill_key == "managed-only",
                Skill.is_active,
            )
        )
    ).scalar_one_or_none() is not None

    _set_auth(
        AuthContext(
            user=seed_user,
            api_key=ApiKey(
                user_id=seed_user.id,
                key_hash="1" * 64,
                key_prefix="clawdi_test",
                label="stale-connected-agent",
                environment_id=environment_project.origin_environment_id,
                scopes=["skills:read", "skills:write"],
                managed=False,
            ),
        )
    )
    stale_workspace_write = await client.post(
        f"/v1/agents/{environment_project.origin_environment_id}/skills/sync/upload",
        data={"skill_key": "stale-workspace-write"},
        files={
            "file": (
                "stale-workspace-write.tar.gz",
                _skill_archive("stale-workspace-write"),
                "application/gzip",
            )
        },
    )
    _set_auth(AuthContext(user=seed_user))
    assert stale_workspace_write.status_code == 200, stale_workspace_write.text

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
async def test_connected_capability_report_rejects_hosted_v2_deployment(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    _set_auth(_connected_agent_auth(seed_user))
    try:
        hosted_v2_report = await client.put(
            "/v1/runtime/project-skill-capability",
            params={"environment_id": str(channel_agent.id)},
            json={"project_skill_reconcile_version": 1},
        )
    finally:
        _set_auth(AuthContext(user=seed_user))
    assert hosted_v2_report.status_code == 409, hosted_v2_report.text
    assert hosted_v2_report.json()["detail"]["code"] == "connected_agent_required"
    await db_session.refresh(channel_agent)
    assert channel_agent.connected_agent_registered_at is None


@pytest.mark.asyncio
async def test_legacy_v1_hosted_identity_cannot_report_or_read_project_desired(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    workspace_project: Project,
    environment_project: Project,
):
    legacy_v1_agent_id = environment_project.origin_environment_id
    assert legacy_v1_agent_id is not None
    legacy_v1_agent = await db_session.get(AgentEnvironment, legacy_v1_agent_id)
    assert legacy_v1_agent is not None
    # Historical Admin registration without an explicit environment_id used
    # this same implicit registration shape. Legacy V1 Hosted then ran with a
    # persisted environment-bound key; managed=False/scopes=None was supported.
    # See _admin_register_environment and test_deploy_key_minted_with_full_access_by_default.
    assert legacy_v1_agent.registration_key is not None
    legacy_v1_runtime_key = ApiKey(
        user_id=seed_user.id,
        key_hash="2" * 64,
        key_prefix="clawdi_test",
        label="legacy-v1-hosted",
        environment_id=legacy_v1_agent_id,
        scopes=None,
        managed=False,
    )
    db_session.add(legacy_v1_runtime_key)
    await db_session.commit()

    _set_auth(AuthContext(user=seed_user, api_key=legacy_v1_runtime_key))
    legacy_v1_reregister = await client.post(
        "/v1/agents",
        json={
            "machine_id": legacy_v1_agent.machine_id,
            "machine_name": legacy_v1_agent.machine_name,
            "agent_type": legacy_v1_agent.agent_type,
            "agent_version": legacy_v1_agent.agent_version,
            "os": legacy_v1_agent.os,
        },
    )
    assert legacy_v1_reregister.status_code == 200, legacy_v1_reregister.text
    await db_session.refresh(legacy_v1_agent)
    assert legacy_v1_agent.connected_agent_registered_at is None

    # The durable Agent identity must win even if the caller itself is a valid
    # unbound OAuth CLI principal. Otherwise an account-level token could turn
    # a Legacy V1 Hosted row into a Connected Agent by registering or reporting once.
    _set_auth(
        AuthContext(
            user=seed_user,
            oauth_cli=True,
            oauth_access_expires_at=datetime.now(UTC) + timedelta(minutes=5),
        )
    )
    oauth_reregister = await client.post(
        "/v1/agents",
        json={
            "machine_id": legacy_v1_agent.machine_id,
            "machine_name": legacy_v1_agent.machine_name,
            "agent_type": legacy_v1_agent.agent_type,
            "agent_version": legacy_v1_agent.agent_version,
            "os": legacy_v1_agent.os,
        },
    )
    assert oauth_reregister.status_code == 200, oauth_reregister.text
    assert oauth_reregister.json()["id"] == str(legacy_v1_agent_id)
    await db_session.refresh(legacy_v1_agent)
    assert legacy_v1_agent.connected_agent_registered_at is None

    legacy_v1_report = await client.put(
        "/v1/runtime/project-skill-capability",
        params={"environment_id": str(legacy_v1_agent_id)},
        json={"project_skill_reconcile_version": 1},
    )
    assert legacy_v1_report.status_code == 409, legacy_v1_report.text
    assert legacy_v1_report.json()["detail"]["code"] == "connected_agent_required"
    legacy_v1_desired = await client.get(
        "/v1/runtime/project-skills",
        params={"environment_id": str(legacy_v1_agent_id)},
    )
    assert legacy_v1_desired.status_code == 409, legacy_v1_desired.text
    assert legacy_v1_desired.json()["detail"]["code"] == "connected_agent_required"

    # Removing the historical runtime key must not turn absence of negative
    # evidence into Connected eligibility. The positive origin marker is still
    # NULL because the attempted self-managed registration was not eligible.
    await db_session.delete(legacy_v1_runtime_key)
    await db_session.commit()
    report_after_key_removal = await client.put(
        "/v1/runtime/project-skill-capability",
        params={"environment_id": str(legacy_v1_agent_id)},
        json={"project_skill_reconcile_version": 1},
    )
    _set_auth(AuthContext(user=seed_user))
    assert report_after_key_removal.status_code == 409, report_after_key_removal.text
    assert report_after_key_removal.json()["detail"]["code"] == "connected_agent_required"
    await db_session.refresh(legacy_v1_agent)
    assert legacy_v1_agent.connected_agent_registered_at is None
    assert legacy_v1_agent.project_skill_reconcile_version is None
    assert legacy_v1_agent.project_skill_reconcile_observed_at is None

    uploaded = await _upload_project_skill(client, workspace_project.id, "legacy-v1-closed")
    assert uploaded.status_code == 200, uploaded.text
    rejected_link = await _link(
        client,
        agent_id=legacy_v1_agent_id,
        project_id=workspace_project.id,
    )
    assert rejected_link.status_code == 409, rejected_link.text
    assert rejected_link.json()["detail"]["code"] == "project_skill_delivery_update_required"


@pytest.mark.asyncio
@pytest.mark.parametrize("unsupported_evidence", ["unobserved", "old-cli"])
async def test_unsupported_hosted_v2_deployment_rejects_link_and_project_skill_render(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    workspace_project: Project,
    channel_agent,
    unsupported_evidence: str,
):
    observation = await db_session.get(HostedRuntimeConfigObservation, channel_agent.id)
    assert observation is not None
    if unsupported_evidence == "unobserved":
        await db_session.delete(observation)
    else:
        state = await db_session.get(HostedRuntimeState, channel_agent.id)
        assert state is not None
        state.cli_package_spec = "clawdi@1.2.2-test"
    await db_session.commit()
    uploaded = await _upload_project_skill(client, workspace_project.id, "needs-ready-agent")
    assert uploaded.status_code == 200, uploaded.text

    rejected = await _link(
        client,
        agent_id=channel_agent.id,
        project_id=workspace_project.id,
    )
    assert rejected.status_code == 409, rejected.text
    assert rejected.json()["detail"] == {
        "code": "project_skill_delivery_update_required",
        "message": "Update this Agent, then try again.",
    }
    assert (
        await db_session.execute(
            select(AgentProjectBinding).where(
                AgentProjectBinding.agent_id == channel_agent.id,
                AgentProjectBinding.project_id == workspace_project.id,
            )
        )
    ).scalar_one_or_none() is None

    # Links created before this source shape existed may already be present.
    # Preserve their Vault access, but do not expose Project Skill intent to an
    # old or unobserved Hosted V2 CLI merely because the binding row exists.
    db_session.add(
        AgentProjectBinding(
            agent_id=channel_agent.id,
            project_id=workspace_project.id,
            binding_type="context",
            priority=1,
            default_write_enabled=False,
            created_by_user_id=seed_user.id,
        )
    )
    await db_session.commit()
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
    entries = rendered.manifest.get("skills", {}).get("entries", {})
    assert "needs-ready-agent" not in entries


@pytest.mark.asyncio
async def test_agent_workspace_upload_rejects_linked_project_key_before_projection(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    workspace_project: Project,
    environment_project: Project,
):
    agent_id = environment_project.origin_environment_id
    assert agent_id is not None
    uploaded = await _upload_project_skill(
        client,
        workspace_project.id,
        "team/shared-key",
        local_skill_key="shared-key",
    )
    assert uploaded.status_code == 200, uploaded.text
    capability = await _report_connected_project_skill_capability(
        client,
        db_session,
        user=seed_user,
        agent_id=agent_id,
    )
    assert capability.status_code == 204, capability.text
    linked = await _link(client, agent_id=agent_id, project_id=workspace_project.id)
    assert linked.status_code == 200, linked.text

    archive = _skill_archive("shared-key", "Local Workspace copy")
    content_hash = _compute_file_tree_hash(archive, "shared-key")
    file_key = skill_routes._file_key(
        seed_user.id,
        environment_project.id,
        "shared-key",
        content_hash,
    )
    cli_auth = AuthContext(
        user=seed_user,
        api_key=ApiKey(
            user_id=seed_user.id,
            key_hash="0" * 64,
            key_prefix="clawdi_test",
            label="test",
            scopes=["skills:read", "skills:write"],
            managed=False,
        ),
    )

    async def current_auth() -> AuthContext:
        return cli_auth

    app.dependency_overrides[get_auth] = current_auth
    app.dependency_overrides[get_auth_short_session] = current_auth
    rejected = await client.post(
        f"/v1/agents/{agent_id}/skills/sync/upload",
        data={"skill_key": "shared-key"},
        files={"file": ("shared-key.tar.gz", archive, "application/gzip")},
    )
    assert rejected.status_code == 409, rejected.text
    assert rejected.json()["detail"]["code"] == ("agent_workspace_project_skill_name_conflict")
    assert (
        await db_session.execute(
            select(Skill).where(
                Skill.project_id == environment_project.id,
                Skill.skill_key == "shared-key",
                Skill.is_active,
            )
        )
    ).scalar_one_or_none() is None
    assert await get_file_store().exists(file_key) is False


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
            skill_key="devops/not_openclaw_safe",
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
async def test_project_skill_limit_blocks_link_and_first_skill_before_mutation(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    workspace_project: Project,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(project_runtime_skills, "MAX_AGENT_PROJECT_SKILLS", 1)
    first = await _upload_project_skill(client, workspace_project.id, "first-skill")
    assert first.status_code == 200, first.text
    first_link = await _link(
        client,
        agent_id=channel_agent.id,
        project_id=workspace_project.id,
    )
    assert first_link.status_code == 200, first_link.text

    full_project = Project(
        user_id=seed_user.id,
        name="Full Project",
        slug=f"full-{uuid.uuid4().hex[:8]}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    empty_project = Project(
        user_id=seed_user.id,
        name="Empty Project",
        slug=f"empty-limit-{uuid.uuid4().hex[:8]}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add_all([full_project, empty_project])
    await db_session.commit()
    second = await _upload_project_skill(client, full_project.id, "second-skill")
    assert second.status_code == 200, second.text

    rejected_link = await _link(
        client,
        agent_id=channel_agent.id,
        project_id=full_project.id,
    )
    assert rejected_link.status_code == 409, rejected_link.text
    assert rejected_link.json()["detail"]["code"] == "agent_project_skill_limit_exceeded"

    empty_link = await _link(
        client,
        agent_id=channel_agent.id,
        project_id=empty_project.id,
    )
    assert empty_link.status_code == 200, empty_link.text
    rejected_first_skill = await _upload_project_skill(
        client,
        empty_project.id,
        "over-limit",
    )
    assert rejected_first_skill.status_code == 409, rejected_first_skill.text
    assert rejected_first_skill.json()["detail"]["code"] == ("agent_project_skill_limit_exceeded")
    assert (
        await db_session.execute(
            select(Skill).where(
                Skill.project_id == empty_project.id,
                Skill.skill_key == "over-limit",
                Skill.is_active,
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
