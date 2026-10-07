"""Optional SDK capture, privacy, retry identity and real PostgreSQL commit boundaries."""

from uuid import uuid4

import pytest
from sqlalchemy import select

from app.core import posthog
from app.core.config import settings
from app.models.user import User


class FakePostHog:
    def __init__(self):
        self.events = []

    def capture(self, name, **kwargs):
        self.events.append({"event": name, **kwargs})
        return str(kwargs["uuid"])

    def shutdown(self):
        pass


@pytest.fixture
def captures(monkeypatch):
    fake = FakePostHog()
    monkeypatch.setattr(settings, "posthog_api_key", "test-project-capture-key")
    monkeypatch.setattr(posthog, "_get_posthog_client", lambda: fake)
    return fake.events


def test_optional_sdk_is_not_initialized_without_key(monkeypatch):
    monkeypatch.setattr(settings, "posthog_api_key", "")
    monkeypatch.setattr(posthog, "_posthog_client", None)
    monkeypatch.setattr(posthog, "_posthog_init_attempted", False)
    monkeypatch.setattr(posthog, "_posthog_init_retry_at", 0)
    assert not posthog.capture_event(
        "agent_connected", distinct_id="user_opaque", event_key="identity"
    )
    assert posthog._posthog_client is None


def test_capture_identity_schema_privacy_and_idempotency(captures):
    session_id = str(uuid4())
    for _ in range(2):
        assert posthog.capture_event(
            "session_synced",
            distinct_id="user_opaque",
            event_key="same-revision",
            properties={
                "protocol": "snapshot-v1",
                "session_id": session_id,
                "has_messages": True,
                "message_count": 2,
            },
        )
    assert captures[0]["uuid"] == captures[1]["uuid"]
    assert captures[0]["properties"]["$insert_id"] == captures[1]["properties"]["$insert_id"]
    assert captures[0]["properties"]["schema_version"] == 1
    assert captures[0]["distinct_id"] == "user_opaque"
    for properties in [
        {"email": "private@example.test"},
        {"token": "secret"},
        {"message_count": True},
        {"feature": ["private"]},
        {"session_id": "/private/path"},
    ]:
        assert not posthog.capture_event(
            "session_synced",
            distinct_id="user_opaque",
            event_key="bad",
            properties={
                "protocol": "snapshot-v1",
                "session_id": session_id,
                "has_messages": True,
                "message_count": 2,
                **properties,
            },
        )
    assert not posthog.capture_event("INVALID_EVENT", distinct_id="user_opaque", event_key="bad")
    assert len(captures) == 2
    assert not posthog.capture_event(
        "session_synced", distinct_id="user_opaque", event_key="missing-schema"
    )


def test_final_sdk_sanitizer_removes_automatic_context():
    payload = {
        "event": "agent_connected",
        "properties": {
            "distinct_id": "user_opaque",
            "source": "cloud",
            "schema_version": 1,
            "$insert_id": str(uuid4()),
            "$os": "private-host",
            "email": "private@example.test",
            "request_id": "private",
            "token": "secret",
        },
    }
    sanitized = posthog._before_send(payload)
    assert sanitized is not None
    assert set(sanitized["properties"]) == {"distinct_id", "source", "schema_version", "$insert_id"}


async def test_business_capture_waits_for_commit_and_rollback_discards(
    db_session, seed_user, captures
):
    await db_session.execute(select(User.id))
    posthog.stage_capture(db_session, "agent_connected", user=seed_user, event_key="test-agent")
    assert not captures
    await db_session.rollback()
    assert not captures
    await db_session.refresh(seed_user)
    posthog.stage_capture(db_session, "agent_connected", user=seed_user, event_key="test-agent")
    posthog.stage_capture(db_session, "agent_connected", user=seed_user, event_key="test-agent")
    await db_session.commit()
    assert len(captures) == 1


async def test_savepoint_commit_waits_for_outer_transaction(db_session, seed_user, captures):
    await db_session.execute(select(User.id))
    nested = await db_session.begin_nested()
    posthog.stage_capture(db_session, "agent_connected", user=seed_user, event_key="nested")
    await nested.commit()
    assert not captures
    await db_session.rollback()
    assert not captures


async def test_savepoint_rollback_preserves_parent_capture(db_session, seed_user, captures):
    await db_session.execute(select(User.id))
    posthog.stage_capture(db_session, "agent_connected", user=seed_user, event_key="parent")
    nested = await db_session.begin_nested()
    posthog.stage_capture(db_session, "agent_connected", user=seed_user, event_key="child")
    await nested.rollback()
    await db_session.commit()
    assert len(captures) == 1
    assert captures[0]["uuid"] == posthog.event_insert_id(
        "agent_connected", seed_user.clerk_id, "parent"
    )


async def test_connected_registration_emits_once_and_workspace_uses_no_pii(cli_client, captures):
    # Use just the active fixture's CLI auth for registration; capture identity
    # always comes from the resolved User, never request-supplied metadata.
    body = {
        "machine_id": "private-machine",
        "machine_name": "private@example.test",
        "agent_type": "claude_code",
        "os": "darwin",
    }
    for _ in range(2):
        result = await cli_client.post("/v1/agents", json=body)
        assert result.status_code == 200, result.text
    events = [entry for entry in captures if entry["event"] == "agent_connected"]
    assert len(events) == 1
    assert "private" not in str(events[0])
    result = await cli_client.post("/v1/projects", json={"name": "Private Project"})
    assert result.status_code == 201, result.text
    event = next(entry for entry in captures if entry["event"] == "project_created")
    assert event["properties"]["feature"] == "projects"
    assert "Private Project" not in str(event)


def test_sdk_errors_are_nonfatal(monkeypatch):
    class BrokenPostHog:
        def capture(self, *args, **kwargs):
            raise RuntimeError("private")

    monkeypatch.setattr(posthog, "_get_posthog_client", lambda: BrokenPostHog())
    assert not posthog.capture_event("agent_connected", distinct_id="user_opaque", event_key="key")


async def test_synced_snapshot_replay_has_one_insert_id_and_no_content(cli_client, captures):
    from datetime import UTC, datetime

    client = cli_client
    agent = await client.post(
        "/v1/agents",
        json={
            "machine_id": "analytics",
            "machine_name": "fixture",
            "agent_type": "claude_code",
            "os": "linux",
        },
    )
    assert agent.status_code == 200, agent.text
    batch = await client.post(
        "/v1/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": agent.json()["id"],
                    "local_session_id": "analytics-session",
                    "started_at": datetime.now(UTC).isoformat(),
                    "message_count": 1,
                }
            ]
        },
    )
    assert batch.status_code == 200, batch.text
    for _ in range(2):
        response = await client.post(
            "/v1/sessions/analytics-session/upload",
            files={
                "file": (
                    "private-file.json",
                    b'[{"role":"user","content":"PRIVATE MESSAGE"}]',
                    "application/json",
                ),
            },
        )
        assert response.status_code == 200, response.text
    events = [event for event in captures if event["event"] == "session_synced"]
    assert events
    assert len({event["uuid"] for event in events}) == 1
    assert events[0]["properties"]["message_count"] == 1
    assert events[0]["properties"]["has_messages"] is True
    assert "PRIVATE MESSAGE" not in str(events)
    assert "private-file" not in str(events)
