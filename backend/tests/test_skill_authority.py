from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.core.auth import AuthContext, get_auth, get_auth_short_session
from app.core.skill_sync_protocol import (
    SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V0,
    SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
    SKILL_SYNC_PROTOCOL_HEADER,
)
from app.main import app
from app.models.api_key import ApiKey
from app.models.hosted_runtime import HostedRuntimeState
from app.models.project import PROJECT_KIND_ENVIRONMENT, Project
from app.models.session import AgentEnvironment
from app.models.skill import SKILL_AUTHORITY_AGENT_SYNC, SKILL_AUTHORITY_CLOUD, Skill
from app.models.user import User
from app.routes import skills as skill_routes
from app.routes.skills import _compute_file_tree_hash
from app.services.agent_skill_projection import (
    delete_agent_project_skill_rows,
    delete_agent_skill_files_best_effort,
)
from app.services.file_store import get_file_store
from app.services.sync_events import subscribe, unsubscribe
from app.services.tar_utils import tar_from_content

pytestmark = pytest.mark.committed_db

_AGENT_SYNC_HEADERS = {
    SKILL_SYNC_PROTOCOL_HEADER: SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
}


def test_agent_sync_delete_openapi_uses_bodyless_204() -> None:
    operation = app.openapi()["paths"]["/v1/agents/{agent_id}/skills/sync/{skill_key}"]["delete"]

    assert "200" not in operation["responses"]
    assert operation["responses"]["204"] == {"description": "Successful Response"}


def _api_key_auth(
    user: User,
    *,
    environment_id: uuid.UUID | None = None,
    scopes: list[str] | None = None,
) -> AuthContext:
    return AuthContext(
        user=user,
        api_key=ApiKey(
            user_id=user.id,
            key_hash="0" * 64,
            key_prefix="clawdi_test",
            label="test",
            environment_id=environment_id,
            scopes=scopes,
            managed=False,
        ),
    )


def _oauth_auth(user: User) -> AuthContext:
    return AuthContext(
        user=user,
        oauth_cli=True,
        oauth_access_expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )


def _set_auth(auth: AuthContext) -> None:
    async def current_auth() -> AuthContext:
        return auth

    app.dependency_overrides[get_auth] = current_auth
    app.dependency_overrides[get_auth_short_session] = current_auth


def _skill_archive(skill_key: str, marker: str = "Test") -> bytes:
    content = f"---\nname: {skill_key}\ndescription: authority test\n---\n# {marker}\n"
    archive, _ = tar_from_content(skill_key, content)
    return archive


def _skill_upload(
    skill_key: str = "owned",
    marker: str = "Test",
) -> tuple[dict[str, str], dict[str, tuple[str, bytes, str]]]:
    archive = _skill_archive(skill_key, marker)
    return (
        {"skill_key": skill_key},
        {"file": (f"{skill_key}.tar.gz", archive, "application/gzip")},
    )


@pytest.mark.asyncio
async def test_agent_sync_upload_rejects_browser(
    client: httpx.AsyncClient,
    environment_project,
):
    agent_id = environment_project.origin_environment_id
    data, files = _skill_upload()
    response = await client.post(
        f"/v1/agents/{agent_id}/skills/sync/upload",
        data=data,
        files=files,
    )
    assert response.status_code == 403, response.text
    assert response.json()["detail"]["code"] == "agent_sync_auth_required"


@pytest.mark.asyncio
@pytest.mark.parametrize("principal", ["oauth", "unbound_api_key"])
async def test_agent_sync_upload_allows_user_cli_for_owned_agent(
    client: httpx.AsyncClient,
    seed_user: User,
    environment_project,
    principal: str,
):
    auth = _oauth_auth(seed_user) if principal == "oauth" else _api_key_auth(seed_user)
    _set_auth(auth)
    agent_id = environment_project.origin_environment_id
    data, files = _skill_upload(f"owned-{principal}")
    response = await client.post(
        f"/v1/agents/{agent_id}/skills/sync/upload",
        data=data,
        files=files,
    )
    assert response.status_code == 200, response.text


@pytest.mark.asyncio
async def test_agent_sync_upload_env_bound_key_must_match_agent(
    client: httpx.AsyncClient,
    seed_user: User,
    environment_project,
    channel_agent,
):
    bound_agent_id = environment_project.origin_environment_id
    _set_auth(
        _api_key_auth(
            seed_user,
            environment_id=bound_agent_id,
            scopes=["skills:read", "skills:write"],
        )
    )
    data, files = _skill_upload("wrong-agent")
    response = await client.post(
        f"/v1/agents/{channel_agent.id}/skills/sync/upload",
        data=data,
        files=files,
    )
    assert response.status_code == 404, response.text


@pytest.mark.asyncio
async def test_agent_sync_upload_scoped_key_requires_skills_write(
    client: httpx.AsyncClient,
    seed_user: User,
    environment_project,
):
    agent_id = environment_project.origin_environment_id
    _set_auth(_api_key_auth(seed_user, environment_id=agent_id, scopes=["skills:read"]))
    data, files = _skill_upload("scope-denied")
    response = await client.post(
        f"/v1/agents/{agent_id}/skills/sync/upload",
        data=data,
        files=files,
    )
    assert response.status_code == 403, response.text
    assert "skills:write" in response.text


@pytest.mark.asyncio
async def test_agent_sync_upload_other_user_gets_404(
    client: httpx.AsyncClient,
    environment_project,
):
    other_user = User(
        id=uuid.uuid4(),
        clerk_id=f"other_{uuid.uuid4().hex}",
        email="other@example.test",
        name="Other",
    )
    _set_auth(_api_key_auth(other_user))
    data, files = _skill_upload("cross-user")
    response = await client.post(
        f"/v1/agents/{environment_project.origin_environment_id}/skills/sync/upload",
        data=data,
        files=files,
    )
    assert response.status_code == 404, response.text


@pytest.mark.asyncio
async def test_agent_sync_mutations_emit_additive_rolling_safe_events(
    client: httpx.AsyncClient,
    seed_user: User,
    environment_project,
):
    agent_id = environment_project.origin_environment_id
    _set_auth(_api_key_auth(seed_user))
    events = subscribe(seed_user.id, frozenset({environment_project.id}))
    try:
        data, files = _skill_upload("rolling-safe")
        uploaded = await client.post(
            f"/v1/agents/{agent_id}/skills/sync/upload",
            data=data,
            files=files,
        )
        assert uploaded.status_code == 200, uploaded.text
        changed = await asyncio.wait_for(events.get(), timeout=1)
        assert changed["type"] == "agent_skill_changed"

        deleted = await client.delete(
            f"/v1/agents/{agent_id}/skills/sync/rolling-safe",
            params={"project_id": str(environment_project.id)},
        )
        assert deleted.status_code == 204, deleted.text
        assert deleted.content == b""
        removed = await asyncio.wait_for(events.get(), timeout=1)
        assert removed["type"] == "agent_skill_deleted"

        # A lost success response leaves the durable delete queued. Replaying
        # the exact Agent+Project+key absence is the same bodyless success,
        # not a semantic 404 that the CLI could confuse with an old backend.
        replay = await client.delete(
            f"/v1/agents/{agent_id}/skills/sync/rolling-safe",
            params={"project_id": str(environment_project.id)},
        )
        assert replay.status_code == 204, replay.text
        assert replay.content == b""
    finally:
        unsubscribe(seed_user.id, events)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "protocol",
    [
        None,
        SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V0,
        SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
    ],
)
@pytest.mark.parametrize("route_kind", ["legacy", "project_explicit"])
async def test_generic_agent_project_upload_and_delete_support_mixed_cli_versions(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    environment_project,
    protocol: str | None,
    route_kind: str,
):
    protocol_label = protocol or "missing"
    skill_key = f"{route_kind}-{protocol_label}"
    upload_path = (
        "/v1/skills/upload"
        if route_kind == "legacy"
        else f"/v1/projects/{environment_project.id}/skills/upload"
    )
    headers = {} if protocol is None else {SKILL_SYNC_PROTOCOL_HEADER: protocol}

    data, files = _skill_upload(skill_key)
    browser = await client.post(
        upload_path,
        data=data,
        files=files,
        headers=headers,
    )
    assert browser.status_code == 409, browser.text
    assert browser.json()["detail"]["code"] == "agent_project_skills_read_only"

    _set_auth(_api_key_auth(seed_user))
    data, files = _skill_upload(skill_key)
    cli = await client.post(
        upload_path,
        data=data,
        files=files,
        headers=headers,
    )
    assert cli.status_code == 200, cli.text
    row = (
        await db_session.execute(
            select(Skill).where(
                Skill.project_id == environment_project.id,
                Skill.skill_key == skill_key,
                Skill.is_active,
            )
        )
    ).scalar_one()
    assert row.authority == SKILL_AUTHORITY_AGENT_SYNC
    assert row.authority_agent_id == environment_project.origin_environment_id

    deleted = await client.delete(
        f"/v1/projects/{environment_project.id}/skills/{skill_key}",
        headers=headers,
    )
    assert deleted.status_code == 200, deleted.text
    await db_session.refresh(row)
    assert row.is_active is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("protocol", "expected_status", "expected_code"),
    [
        ("agent-authoritative-v2", 400, "unsupported_skill_sync_protocol"),
        ("Agent authoritative", 400, "invalid_skill_sync_protocol"),
    ],
)
async def test_generic_agent_project_upload_rejects_unknown_or_malformed_protocol(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    environment_project,
    protocol: str | None,
    expected_status: int,
    expected_code: str,
):
    _set_auth(_api_key_auth(seed_user))
    data, files = _skill_upload("protocol-gated")
    headers = {} if protocol is None else {SKILL_SYNC_PROTOCOL_HEADER: protocol}
    response = await client.post(
        f"/v1/projects/{environment_project.id}/skills/upload",
        data=data,
        files=files,
        headers=headers,
    )
    assert response.status_code == expected_status, response.text
    assert response.json()["detail"]["code"] == expected_code
    assert (
        await db_session.execute(
            select(Skill).where(
                Skill.project_id == environment_project.id,
                Skill.skill_key == "protocol-gated",
                Skill.is_active,
            )
        )
    ).scalar_one_or_none() is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "protocol",
    [
        None,
        SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V0,
        SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
    ],
)
async def test_agent_project_listing_supports_mixed_cli_versions_and_conditional_304(
    client: httpx.AsyncClient,
    seed_user: User,
    environment_project,
    protocol: str | None,
):
    agent_id = environment_project.origin_environment_id
    _set_auth(
        _api_key_auth(
            seed_user,
            environment_id=agent_id,
            scopes=["skills:read", "skills:write"],
        )
    )
    params = {"project_id": str(environment_project.id)}
    headers = {} if protocol is None else {SKILL_SYNC_PROTOCOL_HEADER: protocol}
    listing = await client.get("/v1/skills", params=params, headers=headers)
    assert listing.status_code == 200, listing.text
    conditional = await client.get(
        "/v1/skills",
        params=params,
        headers={**headers, "If-None-Match": listing.headers["etag"]},
    )
    assert conditional.status_code == 304, conditional.text


@pytest.mark.asyncio
async def test_generic_agent_project_alias_fences_bound_agent_identity(
    client: httpx.AsyncClient,
    seed_user: User,
    environment_project,
    channel_agent,
):
    _set_auth(
        _api_key_auth(
            seed_user,
            environment_id=channel_agent.id,
            scopes=["skills:read", "skills:write"],
        )
    )
    data, files = _skill_upload("wrong-bound-generic")
    response = await client.post(
        f"/v1/projects/{environment_project.id}/skills/upload",
        data=data,
        files=files,
    )
    assert response.status_code == 403, response.text
    assert response.json()["detail"] == "api key not bound to this project"


@pytest.mark.asyncio
async def test_agent_project_cloud_content_and_install_mutations_fail_closed(
    client: httpx.AsyncClient,
    seed_user: User,
    environment_project,
):
    content_payload = {
        "content": "---\nname: denied\ndescription: denied\n---\n# Denied\n",
    }
    browser_content = await client.put(
        f"/v1/projects/{environment_project.id}/skills/denied/content",
        json=content_payload,
    )
    browser_install = await client.post(
        f"/v1/projects/{environment_project.id}/skills/install",
        json={"repo": "owner/repo", "path": "skills/denied"},
    )
    assert browser_content.status_code == 409, browser_content.text
    assert browser_install.status_code == 409, browser_install.text
    assert browser_content.json()["detail"]["code"] == "agent_project_skills_read_only"
    assert browser_install.json()["detail"]["code"] == "agent_project_skills_read_only"

    _set_auth(_api_key_auth(seed_user))
    cli_content = await client.put(
        f"/v1/projects/{environment_project.id}/skills/denied/content",
        json=content_payload,
    )
    cli_install = await client.post(
        f"/v1/projects/{environment_project.id}/skills/install",
        json={"repo": "owner/repo", "path": "skills/denied"},
    )
    assert cli_content.status_code == 409, cli_content.text
    assert cli_install.status_code == 409, cli_install.text
    assert cli_content.json()["detail"]["code"] == "agent_project_filesystem_required"
    assert cli_install.json()["detail"]["code"] == "agent_project_filesystem_required"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "protocol",
    [
        None,
        SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V0,
        SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
    ],
)
async def test_generic_agent_project_delete_treats_local_absence_as_legacy_migration_evidence(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    environment_project,
    protocol: str | None,
):
    legacy = Skill(
        user_id=seed_user.id,
        project_id=environment_project.id,
        skill_key="legacy-absence",
        name="Legacy absence",
        description="Unclaimed legacy projection",
        content_hash="b" * 64,
        authority=SKILL_AUTHORITY_CLOUD,
    )
    db_session.add(legacy)
    await db_session.commit()
    _set_auth(_api_key_auth(seed_user))
    headers = {} if protocol is None else {SKILL_SYNC_PROTOCOL_HEADER: protocol}

    deleted = await client.delete(
        f"/v1/projects/{environment_project.id}/skills/legacy-absence",
        headers=headers,
    )
    assert deleted.status_code == 200, deleted.text
    replay = await client.delete(
        f"/v1/projects/{environment_project.id}/skills/legacy-absence",
        headers=headers,
    )
    assert replay.status_code == 200, replay.text
    await db_session.refresh(legacy)
    assert legacy.is_active is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "protocol",
    [
        None,
        SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V0,
        SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
    ],
)
async def test_slug_only_delete_uses_bound_agent_project_for_mixed_cli_versions(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    environment_project,
    protocol: str | None,
):
    skill = Skill(
        user_id=seed_user.id,
        project_id=environment_project.id,
        skill_key="bound-legacy-delete",
        name="Bound legacy delete",
        description="Released slug-only compatibility",
        content_hash="e" * 64,
        authority=SKILL_AUTHORITY_CLOUD,
    )
    db_session.add(skill)
    await db_session.commit()
    _set_auth(
        _api_key_auth(
            seed_user,
            environment_id=environment_project.origin_environment_id,
            scopes=["skills:write"],
        )
    )
    headers = {} if protocol is None else {SKILL_SYNC_PROTOCOL_HEADER: protocol}

    response = await client.delete(
        "/v1/skills/bound-legacy-delete",
        headers=headers,
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"status": "deleted"}
    await db_session.refresh(skill)
    assert skill.is_active is False


@pytest.mark.asyncio
@pytest.mark.parametrize("principal", ["browser", "unbound_api_key", "oauth_cli"])
async def test_slug_only_delete_keeps_ambiguous_callers_on_410(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    environment_project,
    principal: str,
):
    skill = Skill(
        user_id=seed_user.id,
        project_id=environment_project.id,
        skill_key="ambiguous-legacy-delete",
        name="Ambiguous legacy delete",
        description="Must remain project-explicit",
        content_hash="f" * 64,
        authority=SKILL_AUTHORITY_CLOUD,
    )
    db_session.add(skill)
    await db_session.commit()
    if principal == "unbound_api_key":
        _set_auth(_api_key_auth(seed_user))
    elif principal == "oauth_cli":
        _set_auth(_oauth_auth(seed_user))

    response = await client.delete("/v1/skills/ambiguous-legacy-delete")

    assert response.status_code == 410, response.text
    assert response.json()["detail"]["code"] == "project_explicit_route_required"
    await db_session.refresh(skill)
    assert skill.is_active is True


@pytest.mark.asyncio
async def test_agent_project_download_preserves_legacy_access_and_current_cli_protection(
    client: httpx.AsyncClient,
    seed_user: User,
    environment_project,
    channel_agent,
):
    agent_id = environment_project.origin_environment_id
    _set_auth(_api_key_auth(seed_user))
    data, files = _skill_upload("download-compat")
    uploaded = await client.post(
        f"/v1/agents/{agent_id}/skills/sync/upload",
        data=data,
        files=files,
    )
    assert uploaded.status_code == 200, uploaded.text

    project_download = f"/v1/projects/{environment_project.id}/skills/download-compat/download"
    for protocol in (None, SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V0):
        headers = {} if protocol is None else {SKILL_SYNC_PROTOCOL_HEADER: protocol}
        legacy = await client.get(project_download, headers=headers)
        assert legacy.status_code == 200, legacy.text
        assert legacy.headers["content-type"].startswith("application/gzip")

    legacy_route = await client.get("/v1/skills/download-compat/download")
    assert legacy_route.status_code == 200, legacy_route.text

    current = await client.get(project_download, headers=_AGENT_SYNC_HEADERS)
    assert current.status_code == 409, current.text
    assert current.json()["detail"]["code"] == "agent_project_download_forbidden"

    for protocol, expected_code in (
        ("agent-authoritative-v2", "unsupported_skill_sync_protocol"),
        ("Agent authoritative", "invalid_skill_sync_protocol"),
    ):
        rejected = await client.get(
            project_download,
            headers={SKILL_SYNC_PROTOCOL_HEADER: protocol},
        )
        assert rejected.status_code == 400, rejected.text
        assert rejected.json()["detail"]["code"] == expected_code

    _set_auth(AuthContext(user=seed_user))
    dashboard = await client.get(project_download, headers=_AGENT_SYNC_HEADERS)
    assert dashboard.status_code == 200, dashboard.text

    _set_auth(
        _api_key_auth(
            seed_user,
            environment_id=channel_agent.id,
            scopes=["skills:read", "skills:write"],
        )
    )
    fenced = await client.get(project_download)
    assert fenced.status_code == 404, fenced.text


@pytest.mark.asyncio
async def test_agent_absence_can_remove_legacy_projection_while_manifest_reserves_key(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    environment_project,
):
    agent_id = environment_project.origin_environment_id
    legacy = Skill(
        user_id=seed_user.id,
        project_id=environment_project.id,
        skill_key="reserved-handoff",
        name="Reserved handoff",
        description="Legacy row that must not survive manifest takeover",
        content_hash="d" * 64,
        authority=SKILL_AUTHORITY_CLOUD,
    )
    state = HostedRuntimeState(
        environment_id=agent_id,
        deployment_id="dep-reserved-handoff",
        instance_id="iid-reserved-handoff",
        generation=1,
        cli_package_spec="clawdi@0.13.2-test",
        locale={"language": "en", "timezone": "UTC"},
        system={},
        runtimes={},
        live_sync={"enabled": True, "agents": ["codex"]},
        recovery={"cacheManifest": True, "allowOfflineBoot": True},
        skills={"entries": {"reserved-handoff": {"enabled": True, "version": 1}}},
    )
    db_session.add_all([legacy, state])
    await db_session.commit()
    _set_auth(_api_key_auth(seed_user))

    response = await client.delete(
        f"/v1/agents/{agent_id}/skills/sync/reserved-handoff",
        params={"project_id": str(environment_project.id)},
    )
    assert response.status_code == 204, response.text
    await db_session.refresh(legacy)
    assert legacy.is_active is False


@pytest.mark.asyncio
async def test_identical_hash_agent_claim_atomically_updates_authority(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    environment_project,
):
    agent_id = environment_project.origin_environment_id
    _set_auth(_api_key_auth(seed_user))
    archive = _skill_archive("claim-me")
    original_hash = _compute_file_tree_hash(archive, "claim-me")
    row = Skill(
        user_id=seed_user.id,
        project_id=environment_project.id,
        skill_key="claim-me",
        name="Marketplace name",
        description="stale metadata",
        content_hash=original_hash,
        file_count=99,
        source="marketplace",
        source_repo="vendor/catalog",
        authority=SKILL_AUTHORITY_CLOUD,
    )
    db_session.add(row)
    await db_session.commit()
    original_version = row.version

    data, files = _skill_upload("claim-me")
    claim = await client.post(
        f"/v1/agents/{agent_id}/skills/sync/upload",
        data=data,
        files=files,
    )
    assert claim.status_code == 200, claim.text
    assert claim.json()["version"] == original_version

    claimed = (
        await db_session.execute(
            select(Skill).where(
                Skill.project_id == environment_project.id,
                Skill.skill_key == "claim-me",
                Skill.is_active,
            )
        )
    ).scalar_one()
    assert claimed.authority == SKILL_AUTHORITY_AGENT_SYNC
    assert claimed.authority_agent_id == agent_id
    assert claimed.source == SKILL_AUTHORITY_AGENT_SYNC
    assert claimed.source_repo is None
    assert claimed.name == "claim-me"
    assert claimed.description == "authority test"
    assert claimed.file_count == 1

    listing = await client.get(
        "/v1/skills",
        params={"project_id": str(environment_project.id)},
        headers=_AGENT_SYNC_HEADERS,
    )
    assert listing.status_code == 200, listing.text
    assert listing.json()["items"][0]["authority"] == SKILL_AUTHORITY_AGENT_SYNC
    assert "authority_agent_id" not in listing.json()["items"][0]


@pytest.mark.asyncio
async def test_agent_sync_upload_rejects_mismatched_hash_without_claiming(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    environment_project,
):
    agent_id = environment_project.origin_environment_id
    _set_auth(_api_key_auth(seed_user))
    data, files = _skill_upload("hash-mismatch")
    data["content_hash"] = "0" * 64
    response = await client.post(
        f"/v1/agents/{agent_id}/skills/sync/upload",
        data=data,
        files=files,
    )
    assert response.status_code == 400, response.text
    assert response.json()["detail"]["code"] == "skill_content_hash_mismatch"
    assert (
        await db_session.execute(select(Skill).where(Skill.project_id == environment_project.id))
    ).scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_agent_sync_nested_key_and_different_bytes_replace_projection(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    environment_project,
):
    agent_id = environment_project.origin_environment_id
    _set_auth(_api_key_auth(seed_user))
    first_data, first_files = _skill_upload("category/owned", "First")
    first = await client.post(
        f"/v1/agents/{agent_id}/skills/sync/upload",
        data=first_data,
        files=first_files,
    )
    assert first.status_code == 200, first.text

    second_data, second_files = _skill_upload("category/owned", "Second")
    second = await client.post(
        f"/v1/agents/{agent_id}/skills/sync/upload",
        data=second_data,
        files=second_files,
    )
    assert second.status_code == 200, second.text
    assert second.json()["version"] == first.json()["version"] + 1
    assert second.json()["content_hash"] != first.json()["content_hash"]
    claimed = (
        await db_session.execute(
            select(Skill).where(
                Skill.project_id == environment_project.id,
                Skill.skill_key == "category/owned",
                Skill.is_active,
            )
        )
    ).scalar_one()
    assert claimed.authority_agent_id == agent_id


@pytest.mark.asyncio
async def test_agent_project_reassignment_deletes_old_claim_before_reprojecting(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    environment_project,
):
    agent_id = environment_project.origin_environment_id
    _set_auth(_api_key_auth(seed_user))
    data, files = _skill_upload("reassigned")
    claimed = await client.post(
        f"/v1/agents/{agent_id}/skills/sync/upload",
        data=data,
        files=files,
    )
    assert claimed.status_code == 200, claimed.text

    new_project = Project(
        user_id=seed_user.id,
        name="Replacement Agent Project",
        slug=f"replacement-{uuid.uuid4().hex[:8]}",
        kind=PROJECT_KIND_ENVIRONMENT,
    )
    db_session.add(new_project)
    await db_session.flush()
    agent = await db_session.get(AgentEnvironment, agent_id)
    assert agent is not None
    environment_project.origin_environment_id = None
    new_project.origin_environment_id = agent_id
    agent.default_project_id = new_project.id
    await db_session.commit()

    cleanup = await client.delete(
        f"/v1/agents/{agent_id}/skills/sync/reassigned",
        params={"project_id": str(environment_project.id)},
    )
    assert cleanup.status_code == 204, cleanup.text
    replay = await client.delete(
        f"/v1/agents/{agent_id}/skills/sync/reassigned",
        params={"project_id": str(environment_project.id)},
    )
    assert replay.status_code == 204, replay.text

    data, files = _skill_upload("reassigned")
    reprojection = await client.post(
        f"/v1/agents/{agent_id}/skills/sync/upload",
        data=data,
        files=files,
    )
    assert reprojection.status_code == 200, reprojection.text
    active_rows = (
        (
            await db_session.execute(
                select(Skill).where(
                    Skill.user_id == seed_user.id,
                    Skill.skill_key == "reassigned",
                    Skill.is_active,
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(active_rows) == 1
    assert active_rows[0].project_id == new_project.id
    assert active_rows[0].authority == SKILL_AUTHORITY_AGENT_SYNC
    assert active_rows[0].authority_agent_id == agent_id


@pytest.mark.asyncio
async def test_old_project_fence_cannot_delete_unclaimed_cloud_row(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    environment_project,
):
    agent_id = environment_project.origin_environment_id
    legacy = Skill(
        user_id=seed_user.id,
        project_id=environment_project.id,
        skill_key="old-unclaimed",
        name="Old unclaimed",
        description="Legacy Cloud row",
        content_hash="3" * 64,
        authority=SKILL_AUTHORITY_CLOUD,
    )
    db_session.add(legacy)
    await db_session.flush()

    new_project = Project(
        user_id=seed_user.id,
        name="Replacement Agent Project",
        slug=f"replacement-{uuid.uuid4().hex[:8]}",
        kind=PROJECT_KIND_ENVIRONMENT,
    )
    db_session.add(new_project)
    await db_session.flush()
    agent = await db_session.get(AgentEnvironment, agent_id)
    assert agent is not None
    environment_project.origin_environment_id = None
    new_project.origin_environment_id = agent_id
    agent.default_project_id = new_project.id
    await db_session.commit()

    _set_auth(_api_key_auth(seed_user))
    response = await client.delete(
        f"/v1/agents/{agent_id}/skills/sync/old-unclaimed",
        params={"project_id": str(environment_project.id)},
    )
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "agent_sync_old_project_unclaimed"
    await db_session.refresh(legacy)
    assert legacy.is_active is True


@pytest.mark.asyncio
async def test_dashboard_agent_delete_cleans_all_agent_project_rows_files_and_revision(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    environment_project,
    workspace_project,
):
    agent_id = environment_project.origin_environment_id
    file_store = get_file_store()
    agent_file_keys = (
        f"skill-authority-tests/{uuid.uuid4().hex}/legacy.tar.gz",
        f"skill-authority-tests/{uuid.uuid4().hex}/claimed.tar.gz",
        f"skill-authority-tests/{uuid.uuid4().hex}/old-project-claim.tar.gz",
    )
    workspace_file_key = f"skill-authority-tests/{uuid.uuid4().hex}/workspace.tar.gz"
    for file_key in (*agent_file_keys, workspace_file_key):
        await file_store.put(file_key, b"archive")

    old_project = Project(
        user_id=seed_user.id,
        name="Previous Agent Project",
        slug=f"previous-{uuid.uuid4().hex[:8]}",
        kind=PROJECT_KIND_ENVIRONMENT,
    )
    db_session.add(old_project)
    await db_session.flush()
    db_session.add_all(
        [
            Skill(
                user_id=seed_user.id,
                project_id=environment_project.id,
                skill_key="delete-legacy",
                name="Delete legacy",
                description="Legacy Cloud row",
                content_hash="4" * 64,
                file_key=agent_file_keys[0],
                authority=SKILL_AUTHORITY_CLOUD,
            ),
            Skill(
                user_id=seed_user.id,
                project_id=environment_project.id,
                skill_key="delete-claimed",
                name="Delete claimed",
                description="Agent projection",
                content_hash="5" * 64,
                file_key=agent_file_keys[1],
                source=SKILL_AUTHORITY_AGENT_SYNC,
                authority=SKILL_AUTHORITY_AGENT_SYNC,
                authority_agent_id=agent_id,
            ),
            Skill(
                user_id=seed_user.id,
                project_id=old_project.id,
                skill_key="delete-old-claim",
                name="Delete old claim",
                description="Projection claimed before Project reassignment",
                content_hash="c" * 64,
                file_key=agent_file_keys[2],
                source=SKILL_AUTHORITY_AGENT_SYNC,
                authority=SKILL_AUTHORITY_AGENT_SYNC,
                authority_agent_id=agent_id,
            ),
            Skill(
                user_id=seed_user.id,
                project_id=workspace_project.id,
                skill_key="keep-workspace",
                name="Keep workspace",
                description="Cloud-owned workspace Skill",
                content_hash="6" * 64,
                file_key=workspace_file_key,
                authority=SKILL_AUTHORITY_CLOUD,
            ),
        ]
    )
    await db_session.commit()
    before = await client.get("/v1/skills", params={"project_id": str(environment_project.id)})
    assert before.status_code == 200, before.text
    old_etag = before.headers["etag"]
    await db_session.refresh(seed_user)
    revision_before = seed_user.skills_revision
    events = subscribe(
        seed_user.id,
        frozenset({environment_project.id, old_project.id}),
    )
    try:
        deleted = await client.delete(f"/v1/agents/{agent_id}")
        assert deleted.status_code == 204, deleted.text
        deletion_events = [await asyncio.wait_for(events.get(), timeout=1) for _ in range(3)]
    finally:
        unsubscribe(seed_user.id, events)
    await db_session.refresh(seed_user)
    assert seed_user.skills_revision == revision_before + 3
    assert sorted(event["skills_revision"] for event in deletion_events) == [
        revision_before + 1,
        revision_before + 2,
        revision_before + 3,
    ]
    assert [event["project_id"] for event in deletion_events].count(
        str(environment_project.id)
    ) == 2
    assert [event["project_id"] for event in deletion_events].count(str(old_project.id)) == 1

    conditional = await client.get(
        "/v1/skills",
        params={"project_id": str(environment_project.id)},
        headers={"If-None-Match": old_etag},
    )
    assert conditional.status_code == 200, conditional.text
    assert conditional.headers["etag"] != old_etag
    assert conditional.json()["items"] == []
    assert (
        await db_session.execute(select(Skill).where(Skill.project_id == environment_project.id))
    ).scalars().all() == []
    assert (
        await db_session.execute(select(Skill).where(Skill.project_id == old_project.id))
    ).scalars().all() == []
    kept = (
        await db_session.execute(
            select(Skill).where(
                Skill.project_id == workspace_project.id,
                Skill.skill_key == "keep-workspace",
                Skill.is_active,
            )
        )
    ).scalar_one()
    assert kept.authority == SKILL_AUTHORITY_CLOUD
    assert await file_store.exists(workspace_file_key) is True
    for file_key in agent_file_keys:
        assert await file_store.exists(file_key) is False


@pytest.mark.asyncio
async def test_concurrent_agent_upload_and_delete_cannot_resurrect_row_or_archive(
    engine: AsyncEngine,
    db_session: AsyncSession,
    seed_user: User,
    environment_project,
    monkeypatch: pytest.MonkeyPatch,
):
    agent_id = environment_project.origin_environment_id
    archive = _skill_archive("delete-race")
    auth = _api_key_auth(seed_user)
    file_store = get_file_store()
    file_key = skill_routes._file_key(seed_user.id, environment_project.id, "delete-race")
    original_put = skill_routes.file_store.put
    put_started = asyncio.Event()
    release_put = asyncio.Event()

    async def blocking_put(key: str, data: bytes, content_type: str | None = None) -> None:
        put_started.set()
        await release_put.wait()
        await original_put(key, data, content_type)

    monkeypatch.setattr(skill_routes.file_store, "put", blocking_put)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def upload() -> None:
        async with session_factory() as session:
            await skill_routes._do_upload_skill(
                db=session,
                auth=auth,
                project_id=environment_project.id,
                skill_key="delete-race",
                data=archive,
                content_hash=None,
                authority=SKILL_AUTHORITY_AGENT_SYNC,
                authority_agent_id=agent_id,
            )

    async def delete_agent() -> None:
        async with session_factory() as session:
            agent = await session.get(AgentEnvironment, agent_id)
            assert agent is not None
            file_keys = await delete_agent_project_skill_rows(session, agent=agent)
            await session.delete(agent)
            await session.commit()
        await delete_agent_skill_files_best_effort(file_keys, agent_id=agent_id)

    upload_task = asyncio.create_task(upload())
    await asyncio.wait_for(put_started.wait(), timeout=2)
    delete_task = asyncio.create_task(delete_agent())
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(asyncio.shield(delete_task), timeout=0.05)
    release_put.set()
    await asyncio.gather(upload_task, delete_task)

    async with session_factory() as session:
        assert await session.get(AgentEnvironment, agent_id) is None
        surviving_rows = (
            (
                await session.execute(
                    select(Skill).where(
                        Skill.project_id == environment_project.id,
                        Skill.skill_key == "delete-race",
                    )
                )
            )
            .scalars()
            .all()
        )
        assert surviving_rows == []
    assert await file_store.exists(file_key) is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("authority", "agent_id"),
    [
        (SKILL_AUTHORITY_CLOUD, "present"),
        (SKILL_AUTHORITY_AGENT_SYNC, None),
    ],
)
async def test_skill_authority_database_invariants(
    db_session: AsyncSession,
    seed_user: User,
    environment_project,
    authority: str,
    agent_id: str | None,
):
    row = Skill(
        user_id=seed_user.id,
        project_id=environment_project.id,
        skill_key=f"invalid-{uuid.uuid4().hex[:8]}",
        name="invalid",
        description="invalid",
        content_hash="0" * 64,
        authority=authority,
        authority_agent_id=(
            environment_project.origin_environment_id if agent_id == "present" else None
        ),
    )
    db_session.add(row)
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_orphaned_environment_project_rows_stay_visible_but_mutations_fail_closed(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    environment_project,
):
    agent_id = environment_project.origin_environment_id
    skill = Skill(
        user_id=seed_user.id,
        project_id=environment_project.id,
        skill_key="orphaned-legacy",
        name="Orphaned legacy",
        description="A legacy Cloud row in a retained Agent Project",
        content_hash="1" * 64,
        authority=SKILL_AUTHORITY_CLOUD,
    )
    db_session.add(skill)
    await db_session.commit()

    agent = await db_session.get(AgentEnvironment, agent_id)
    assert agent is not None
    await db_session.delete(agent)
    await db_session.commit()
    await db_session.refresh(environment_project)
    assert environment_project.origin_environment_id is None

    response = await client.get(
        "/v1/skills",
        params={"project_id": str(environment_project.id), "q": "orphaned-legacy"},
    )
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert len(items) == 1
    assert items[0]["authority"] == SKILL_AUTHORITY_CLOUD

    deleted = await client.delete(f"/v1/projects/{environment_project.id}/skills/orphaned-legacy")
    assert deleted.status_code == 409, deleted.text
    assert deleted.json()["detail"]["code"] == "agent_project_skills_read_only"

    data, files = _skill_upload("orphaned-new")
    uploaded = await client.post(
        f"/v1/projects/{environment_project.id}/skills/upload",
        data=data,
        files=files,
    )
    assert uploaded.status_code == 409, uploaded.text
    assert uploaded.json()["detail"]["code"] == "agent_project_skills_read_only"

    _set_auth(_api_key_auth(seed_user))
    cli_delete = await client.delete(
        f"/v1/projects/{environment_project.id}/skills/orphaned-legacy",
        headers=_AGENT_SYNC_HEADERS,
    )
    assert cli_delete.status_code == 409, cli_delete.text
    assert cli_delete.json()["detail"]["code"] == "agent_project_orphaned"
