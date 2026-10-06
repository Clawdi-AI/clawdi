import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app.models.session import AgentProfile, Session, SessionSyncSuppression
from tests.conftest import create_env_with_project


async def inventory(client, env, keys, complete=True):
    return await client.put(
        f"/v1/agents/{env.id}/profiles",
        json={
            "complete": complete,
            "profiles": [{"upstream_key": k, "is_default": k == "default"} for k in keys],
        },
    )


def metadata(env, lid="same"):
    return {
        "environment_id": str(env.id),
        "local_session_id": lid,
        "started_at": datetime.now(UTC).isoformat(),
        "summary": "initial",
    }


@pytest.mark.asyncio
async def test_old_cli_zero_one_many_profiles(client, db_session, seed_user):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=uuid.uuid4().hex,
        machine_name="test",
        agent_type="hermes",
    )
    body = metadata(env)
    res = await client.post("/v1/sessions/batch", json={"sessions": [body]})
    assert res.status_code == 200, res.text
    row = (
        await db_session.execute(select(Session).where(Session.origin_environment_id == env.id))
    ).scalar_one()
    assert row.origin_profile_key == ""
    row.origin_profile_key = "work"
    await db_session.flush()
    res = await client.post(
        "/v1/sessions/batch", json={"sessions": [{**body, "summary": "updated"}]}
    )
    assert res.status_code == 200, res.text
    await db_session.refresh(row)
    assert row.summary == "updated" and row.origin_profile_key == "work"
    res = await client.get("/v1/sessions/same/events/head", params={"environment_id": str(env.id)})
    assert res.status_code == 200
    res = await client.post("/v1/sessions/batch", json={"profile_key": "other", "sessions": [body]})
    assert res.status_code == 200, res.text
    assert res.json()["rejected"] == ["same"]
    await db_session.refresh(row)
    assert row.origin_profile_key == "work" and row.summary == "updated"
    res = await client.get(
        "/v1/sessions/same/events/head",
        params={"environment_id": str(env.id), "profile_key": "work"},
    )
    assert res.status_code == 200


@pytest.mark.asyncio
async def test_inventory_removal_keeps_sessions_and_shows_offline(client, db_session, seed_user):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=uuid.uuid4().hex,
        machine_name="test",
        agent_type="hermes",
    )
    assert (await inventory(client, env, ["default", "work"])).status_code == 200
    await client.post(
        "/v1/sessions/batch", json={"profile_key": "work", "sessions": [metadata(env)]}
    )
    res = await inventory(client, env, ["default"], complete=False)
    assert next(p for p in res.json() if p["profile_key"] == "work")["state"] == "active"
    res = await inventory(client, env, ["default"])
    work = next(p for p in res.json() if p["profile_key"] == "work")
    assert work["state"] == "removed" and work["online"] is False and work["session_count"] == 1
    res = await client.get(
        "/v1/sessions", params={"environment_id": str(env.id), "profile_key": "work"}
    )
    assert res.status_code == 200, res.text
    assert res.json()["items"][0]["profile_display_name"] == "work"


@pytest.mark.asyncio
async def test_hermes_rename_moves_metadata_in_place(client, db_session, seed_user):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=uuid.uuid4().hex,
        machine_name="test",
        agent_type="hermes",
    )
    await inventory(client, env, ["default", "work"])
    await client.post(
        "/v1/sessions/batch", json={"profile_key": "work", "sessions": [metadata(env)]}
    )
    row = (
        await db_session.execute(select(Session).where(Session.origin_environment_id == env.id))
    ).scalar_one()
    row.file_key = "unchanged-content-key"
    row.content_hash = "a" * 64
    row.event_revision = 3
    original = (row.id, row.updated_at, row.file_key, row.content_hash, row.event_revision)
    db_session.add(
        SessionSyncSuppression(
            user_id=seed_user.id,
            origin_environment_id=env.id,
            origin_profile_key="work",
            local_session_id="deleted",
        )
    )
    await db_session.flush()
    old_id = (
        await db_session.execute(
            select(AgentProfile.id).where(
                AgentProfile.environment_id == env.id, AgentProfile.profile_key == "work"
            )
        )
    ).scalar_one()
    await inventory(client, env, ["default", "job"])
    path = f"/v1/agents/{env.id}/profiles/work/rename"
    res = await client.post(path, json={"new_upstream_key": "job"})
    assert res.status_code == 200, res.text
    assert res.json() == {"sessions_moved": 1, "suppressions_moved": 1}
    await db_session.refresh(row)
    assert row.origin_profile_key == "job"
    assert (row.id, row.updated_at, row.file_key, row.content_hash, row.event_revision) == original
    profile = (
        await db_session.execute(select(AgentProfile).where(AgentProfile.id == old_id))
    ).scalar_one()
    assert profile.profile_key == "job" and profile.state == "active"
    assert (await client.post(path, json={"new_upstream_key": "job"})).json()["sessions_moved"] == 0


@pytest.mark.asyncio
async def test_openclaw_attribution_is_scoped_idempotent_and_preserves_suppression(
    client, db_session, seed_user
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=uuid.uuid4().hex,
        machine_name="test",
        agent_type="openclaw",
    )
    other = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=uuid.uuid4().hex,
        machine_name="test",
        agent_type="openclaw",
    )
    await inventory(client, env, ["default", "sales"])
    for agent in (env, other):
        await client.post("/v1/sessions/batch", json={"sessions": [metadata(agent)]})
    db_session.add(
        SessionSyncSuppression(
            user_id=seed_user.id, origin_environment_id=env.id, local_session_id="deleted"
        )
    )
    await db_session.flush()
    path = f"/v1/agents/{env.id}/profiles/sales/attribute-sessions"
    res = await client.post(path, json={"local_session_ids": ["same", "deleted"]})
    assert res.status_code == 200, res.text
    assert res.json() == {"sessions_moved": 1, "suppressions_moved": 1}
    assert (await client.post(path, json={"local_session_ids": ["same", "deleted"]})).json()[
        "sessions_moved"
    ] == 0
    res = await client.post("/v1/sessions/batch", json={"sessions": [metadata(env, "deleted")]})
    assert res.json()["suppressed"] == ["deleted"]
    rows = (
        (await db_session.execute(select(Session).where(Session.local_session_id == "same")))
        .scalars()
        .all()
    )
    assert {s.origin_environment_id: s.origin_profile_key for s in rows} == {
        env.id: "sales",
        other.id: "",
    }


@pytest.mark.asyncio
async def test_inventory_validates_input_and_owner(client):
    res = await client.put(
        f"/v1/agents/{uuid.uuid4()}/profiles", json={"complete": True, "profiles": []}
    )
    assert res.status_code == 404
    res = await client.put(
        f"/v1/agents/{uuid.uuid4()}/profiles",
        json={"complete": True, "profiles": [{"upstream_key": "../escape", "is_default": False}]},
    )
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_profile_writes_enforce_bound_key_and_machine_fence(
    cli_client, db_session, seed_user
):
    from app.core.auth import AuthContext, get_auth
    from app.main import app
    from app.models.api_key import ApiKey

    first = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="installation",
        machine_name="test",
        agent_type="hermes",
    )
    other = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="other",
        machine_name="test",
        agent_type="hermes",
    )

    async def bound_auth():
        return AuthContext(
            user=seed_user,
            api_key=ApiKey(
                user_id=seed_user.id, environment_id=first.id, scopes=["sessions:write"]
            ),
        )

    app.dependency_overrides[get_auth] = bound_auth
    res = await cli_client.put(
        f"/v1/agents/{other.id}/profiles", json={"complete": True, "profiles": []}
    )
    assert res.status_code == 403
    res = await cli_client.post(
        f"/v1/agents/{other.id}/profiles/work/rename", json={"new_upstream_key": "job"}
    )
    assert res.status_code == 403

    async def connected_auth():
        return AuthContext(
            user=seed_user, api_key=ApiKey(user_id=seed_user.id, scopes=["sessions:write"])
        )

    app.dependency_overrides[get_auth] = connected_auth
    first.connected_agent_registered_at = datetime.now(UTC)
    first.machine_fence_required = True
    await db_session.flush()
    res = await cli_client.put(
        f"/v1/agents/{first.id}/profiles", json={"complete": True, "profiles": []}
    )
    assert res.status_code == 403
    res = await cli_client.put(
        f"/v1/agents/{first.id}/profiles",
        json={"complete": True, "profiles": [{"upstream_key": "default", "is_default": True}]},
        headers={"X-Clawdi-Machine-Id": "installation"},
    )
    assert res.status_code == 200, res.text


@pytest.mark.asyncio
async def test_named_snapshot_content_keeps_existing_storage_paths(client, db_session, seed_user):
    import hashlib
    import json

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=uuid.uuid4().hex,
        machine_name="test",
        agent_type="hermes",
    )
    keys = []
    contents = {}
    # Both identities exist before the default's empty multipart field is sent.
    for profile in ("", "work"):
        content = json.dumps(
            [{"role": "user", "content": profile or "default"}], separators=(",", ":")
        ).encode()
        digest = hashlib.sha256(content).hexdigest()
        res = await client.post(
            "/v1/sessions/batch",
            json={
                "profile_key": profile,
                "sessions": [{**metadata(env, profile or "default"), "content_hash": digest}],
            },
        )
        assert res.status_code == 200, res.text
        contents[profile] = (content, digest)
    for profile, (content, digest) in contents.items():
        res = await client.post(
            f"/v1/sessions/{profile or 'default'}/upload",
            data={
                "environment_id": str(env.id),
                "profile_key": profile,
                "expected_content_hash": digest,
            },
            files={"file": ("same.json", content, "application/json")},
        )
        assert res.status_code == 200, res.text
        row = (
            await db_session.execute(
                select(Session).where(
                    Session.origin_environment_id == env.id, Session.origin_profile_key == profile
                )
            )
        ).scalar_one()
        keys.append(row.file_key)
    assert len(set(keys)) == 2
    assert keys == [
        f"sessions/{seed_user.id}/{env.id}/default.json",
        f"sessions/{seed_user.id}/{env.id}/work.json",
    ]


@pytest.mark.asyncio
async def test_rename_rejects_occupied_target_without_partial_updates(
    client, db_session, seed_user
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=uuid.uuid4().hex,
        machine_name="test",
        agent_type="hermes",
    )
    await inventory(client, env, ["default", "work", "job"])
    for key in ("work", "job"):
        await client.post(
            "/v1/sessions/batch", json={"profile_key": key, "sessions": [metadata(env, key)]}
        )
    res = await client.post(
        f"/v1/agents/{env.id}/profiles/work/rename", json={"new_upstream_key": "job"}
    )
    assert res.status_code == 409
    rows = (
        (
            await db_session.execute(
                select(Session.origin_profile_key).where(Session.origin_environment_id == env.id)
            )
        )
        .scalars()
        .all()
    )
    assert set(rows) == {"work", "job"}


@pytest.mark.asyncio
async def test_default_event_append_and_commit_remain_compatible(client, db_session, seed_user):
    from app.services.session_events import EMPTY_EVENT_HEAD, advance_event_head
    from tests.test_session_events import _chunk, _commit_generation, _event

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=uuid.uuid4().hex,
        machine_name="test",
        agent_type="hermes",
    )
    body = {**metadata(env), "content_protocol": "events-v1"}
    assert (
        await client.post("/v1/sessions/batch", json={"profile_key": "", "sessions": [body]})
    ).status_code == 200
    first = _event(
        0, "message", "first", role="user", parts=[{"type": "text", "text": "first input"}]
    )
    generation, head, append_id = await _commit_generation(
        client, environment_id=str(env.id), local_session_id="same", events=[first]
    )
    assert (
        await client.post(
            "/v1/sessions/batch",
            json={"profile_key": "work", "sessions": [{**body, "local_session_id": "named"}]},
        )
    ).status_code == 200
    commit = {
        "append_id": append_id,
        "base_generation": None,
        "base_revision": 0,
        "base_count": 0,
        "base_head_hash": EMPTY_EVENT_HEAD,
        "final_count": 1,
        "final_head_hash": head,
    }
    path = f"/v1/sessions/same/events/generations/{generation}/commit"
    ambiguous = await client.post(path, json=commit)
    assert ambiguous.status_code == 200, ambiguous.text
    exact = await client.post(path, json={**commit, "profile_key": ""})
    assert exact.status_code == 200, exact.text
    second = _event(
        1, "message", "second", role="user", parts=[{"type": "text", "text": "second input"}]
    )
    data, digest = _chunk([second])
    appended = await client.post(
        "/v1/sessions/same/events/append",
        data={
            "environment_id": str(env.id),
            "profile_key": "",
            "append_id": str(uuid.uuid4()),
            "generation": generation,
            "base_revision": "1",
            "base_count": "1",
            "base_head_hash": head,
            "final_count": "2",
            "final_head_hash": advance_event_head(head, [second]),
            "content_hash": digest,
        },
        files={"file": ("1.ndjson", data, "application/x-ndjson")},
    )
    assert appended.status_code == 200, appended.text
    for profile, lid, count in [("", "same", 2), ("work", "named", 0)]:
        res = await client.get(
            f"/v1/sessions/{lid}/events/head",
            params={"environment_id": str(env.id), "profile_key": profile},
        )
        assert res.json()["count"] == count


@pytest.mark.asyncio
async def test_get_profiles_lazily_creates_default_during_deploy_window(
    client, db_session, seed_user
):
    from sqlalchemy import delete

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=uuid.uuid4().hex,
        machine_name="test",
        agent_type="hermes",
    )
    await db_session.execute(delete(AgentProfile).where(AgentProfile.environment_id == env.id))
    for _ in range(2):
        res = await client.get(f"/v1/agents/{env.id}/profiles")
        assert res.status_code == 200, res.text
        assert [(p["profile_key"], p["is_default"]) for p in res.json()] == [("", True)]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path,body",
    [
        ("work/rename", {"new_upstream_key": "job"}),
        ("work/attribute-sessions", {"local_session_ids": ["same"]}),
    ],
)
async def test_profile_metadata_moves_require_sessions_write(
    cli_client, db_session, seed_user, path, body
):
    from app.core.auth import AuthContext, get_auth
    from app.main import app
    from app.models.api_key import ApiKey

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=uuid.uuid4().hex,
        machine_name="test",
        agent_type="hermes",
    )

    async def skills_auth():
        return AuthContext(
            user=seed_user, api_key=ApiKey(user_id=seed_user.id, scopes=["skills:write"])
        )

    app.dependency_overrides[get_auth] = skills_auth
    response = await cli_client.post(f"/v1/agents/{env.id}/profiles/{path}", json=body)
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_old_cli_ambiguous_session_resolution_requires_profile():
    from unittest.mock import AsyncMock, Mock

    from fastapi import HTTPException

    from app.services.session_profile import resolve_session_profile

    # A later contract schema may contain duplicate local IDs. Released callers
    # must continue receiving the established compatibility error there.
    result = Mock()
    result.scalars.return_value = ["work", "other"]
    db = AsyncMock()
    db.execute.return_value = result
    with pytest.raises(HTTPException) as error:
        await resolve_session_profile(db, uuid.uuid4(), uuid.uuid4(), "same", None)
    assert error.value.status_code == 409
    assert error.value.detail["code"] == "profile_required"


@pytest.mark.asyncio
async def test_batch_ambiguity_rejects_only_the_ambiguous_item(
    client, db_session, seed_user, monkeypatch
):
    from types import SimpleNamespace
    from unittest.mock import Mock

    from sqlalchemy.sql import Select

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=uuid.uuid4().hex,
        machine_name="test",
        agent_type="hermes",
    )
    assert (
        await client.post("/v1/sessions/batch", json={"sessions": [metadata(env)]})
    ).status_code == 200
    execute = db_session.execute
    injected = False

    async def contract_rows(statement, *args, **kwargs):
        nonlocal injected
        result = await execute(statement, *args, **kwargs)
        if (
            not injected
            and isinstance(statement, Select)
            and set(statement.selected_columns.keys())
            == {
                "local_session_id",
                "environment_id",
                "origin_environment_id",
                "origin_profile_key",
                "content_hash",
                "file_key",
                "content_protocol",
            }
        ):
            injected = True
            rows = result.all()
            # Model the duplicate identity that becomes possible after contract,
            # while retaining the expand constraint for the unaffected upsert.
            duplicate = SimpleNamespace(**{**dict(rows[0]._mapping), "origin_profile_key": "work"})
            result = Mock()
            result.all.return_value = [*rows, duplicate]
        return result

    monkeypatch.setattr(db_session, "execute", contract_rows)
    res = await client.post(
        "/v1/sessions/batch", json={"sessions": [metadata(env), metadata(env, "good")]}
    )
    assert res.status_code == 200, res.text
    assert res.json()["rejected"] == ["same"]
    assert res.json()["created"] == 1
    assert res.json()["needs_content"] == ["good"]
