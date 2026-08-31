from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from app.services.file_store import FileStore
from app.services.session_events import EMPTY_EVENT_HEAD, advance_event_head, canonical_event_json


class _UnavailableReadFileStore:
    def __init__(self, delegate: FileStore) -> None:
        self._delegate = delegate

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        await self._delegate.put(key, data, content_type)

    async def get(self, key: str) -> bytes:
        raise RuntimeError("object store unavailable")

    async def delete(self, key: str) -> None:
        await self._delegate.delete(key)

    async def exists(self, key: str) -> bool:
        return await self._delegate.exists(key)


async def _seed_session(client: httpx.AsyncClient) -> tuple[str, str, list[dict[str, str]]]:
    environment = await client.post(
        "/v1/environments",
        json={
            "machine_id": "share-machine",
            "machine_name": "Share machine",
            "agent_type": "claude-code",
            "agent_version": "1.0.0",
            "os": "linux",
        },
    )
    assert environment.status_code == 200, environment.text
    local_id = "immutable-session-share"
    messages = [
        {"role": "user", "content": "Original question"},
        {"role": "assistant", "content": "Original answer", "model": "test-model"},
        {"role": "user", "content": "Follow-up"},
    ]
    data = json.dumps(messages).encode()
    batch = await client.post(
        "/v1/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": environment.json()["id"],
                    "local_session_id": local_id,
                    "started_at": datetime.now(UTC).isoformat(),
                    "message_count": len(messages),
                    "summary": "Immutable share",
                    "model": "test-model",
                    "content_hash": hashlib.sha256(data).hexdigest(),
                }
            ]
        },
    )
    assert batch.status_code == 200, batch.text
    upload = await client.post(
        f"/v1/sessions/{local_id}/upload",
        files={"file": ("session.json", data, "application/json")},
    )
    assert upload.status_code == 200, upload.text
    listing = (await client.get("/v1/sessions")).json()
    session_id = next(
        item["id"] for item in listing["items"] if item["local_session_id"] == local_id
    )
    return session_id, local_id, messages


def _event(seq: int, record_id: str, role: str, content: str) -> dict[str, Any]:
    source = {
        "adapter": "pi",
        "session_key": "share-fixture",
        "record_id": record_id,
    }
    return {
        "seq": seq,
        "event_id": hashlib.sha256(
            canonical_event_json({"source": source, "type": "message"})
        ).hexdigest(),
        "source": source,
        "type": "message",
        "role": role,
        "parts": [{"type": "text", "text": content}],
    }


def _event_chunk(events: list[dict[str, Any]]) -> tuple[bytes, str]:
    data = b"".join(canonical_event_json(event) + b"\n" for event in events)
    return data, hashlib.sha256(data).hexdigest()


async def _seed_event_session(client: httpx.AsyncClient) -> tuple[str, str, str, str]:
    registered = await client.post(
        "/v1/agents",
        json={
            "machine_id": f"share-{uuid.uuid4().hex}",
            "machine_name": "Share fixture",
            "agent_type": "pi",
            "agent_version": "1.0.0",
            "os": "linux",
            "adapter_modules": ["sessions"],
        },
    )
    assert registered.status_code == 200, registered.text
    environment_id = registered.json()["id"]
    local_id = "immutable-event-session-share"
    batch = await client.post(
        "/v1/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": environment_id,
                    "local_session_id": local_id,
                    "started_at": datetime.now(UTC).isoformat(),
                    "message_count": 2,
                    "content_protocol": "events-v1",
                }
            ]
        },
    )
    assert batch.status_code == 200, batch.text

    events = [
        _event(0, "user", "user", "Original question"),
        _event(1, "assistant", "assistant", "Original answer"),
    ]
    generation = str(uuid.uuid4())
    append_id = str(uuid.uuid4())
    head = advance_event_head(EMPTY_EVENT_HEAD, events)
    stage = await client.post(
        f"/v1/sessions/{local_id}/events/generations",
        json={
            "environment_id": environment_id,
            "generation": generation,
            "append_id": append_id,
            "base_generation": None,
            "base_revision": 0,
            "base_count": 0,
            "base_head_hash": EMPTY_EVENT_HEAD,
            "final_count": len(events),
            "final_head_hash": head,
        },
    )
    assert stage.status_code == 200, stage.text
    data, content_hash = _event_chunk(events)
    upload = await client.put(
        f"/v1/sessions/{local_id}/events/generations/{generation}/chunks/0",
        data={"base_head_hash": EMPTY_EVENT_HEAD, "content_hash": content_hash},
        files={"file": ("0.ndjson", data, "application/x-ndjson")},
    )
    assert upload.status_code == 200, upload.text
    commit = await client.post(
        f"/v1/sessions/{local_id}/events/generations/{generation}/commit",
        json={
            "append_id": append_id,
            "base_generation": None,
            "base_revision": 0,
            "base_count": 0,
            "base_head_hash": EMPTY_EVENT_HEAD,
            "final_count": len(events),
            "final_head_hash": head,
        },
    )
    assert commit.status_code == 200, commit.text
    listing = (await client.get("/v1/sessions")).json()
    session_id = next(
        item["id"] for item in listing["items"] if item["local_session_id"] == local_id
    )
    return session_id, local_id, environment_id, generation


@pytest.mark.asyncio
async def test_session_shares_freeze_scope_and_revoke(
    client: httpx.AsyncClient,
    anon_client: httpx.AsyncClient,
) -> None:
    session_id, local_id, original = await _seed_session(client)

    full = await client.post(
        f"/v1/sessions/{session_id}/shares",
        json={"scope": "session"},
    )
    assert full.status_code == 201, full.text
    full_share = full.json()
    assert full_share["message_count"] == 3
    assert full_share["share_url"].endswith(f"/s/{full_share['id']}")

    response = await client.post(
        f"/v1/sessions/{session_id}/shares",
        json={"scope": "response", "position": 1},
    )
    assert response.status_code == 201, response.text
    response_share = response.json()
    response_detail = await anon_client.get(f"/v1/public/session-shares/{response_share['id']}")
    assert response_detail.json()["title"] == "Shared response"
    single = await anon_client.get(f"/v1/public/session-shares/{response_share['id']}/messages")
    assert single.status_code == 200
    assert single.json()["items"] == [{**original[1], "timestamp": None}]

    through = await client.post(
        f"/v1/sessions/{session_id}/shares",
        json={"scope": "through", "position": 1},
    )
    assert through.status_code == 201, through.text
    through_messages = await anon_client.get(
        f"/v1/public/session-shares/{through.json()['id']}/messages"
    )
    assert [item["content"] for item in through_messages.json()["items"]] == [
        "Original question",
        "Original answer",
    ]

    invalid = await client.post(
        f"/v1/sessions/{session_id}/shares",
        json={"scope": "response", "position": 0},
    )
    assert invalid.status_code == 409

    replacement = json.dumps([{"role": "user", "content": "New mutable content"}]).encode()
    upload = await client.post(
        f"/v1/sessions/{local_id}/upload",
        files={"file": ("session.json", replacement, "application/json")},
    )
    assert upload.status_code == 200, upload.text

    frozen = await anon_client.get(
        f"/v1/public/session-shares/{full_share['id']}/messages?limit=10"
    )
    assert frozen.status_code == 200
    assert frozen.json()["items"] == [
        {
            "role": message["role"],
            "content": message["content"],
            "model": message.get("model"),
            "timestamp": None,
        }
        for message in original
    ]

    listed = await client.get(f"/v1/sessions/{session_id}/shares")
    assert listed.status_code == 200
    assert {share["id"] for share in listed.json()["shares"]} == {
        full_share["id"],
        response_share["id"],
        through.json()["id"],
    }

    revoked = await client.delete(f"/v1/session-shares/{full_share['id']}")
    assert revoked.status_code == 204
    expired = await anon_client.get(f"/v1/public/session-shares/{full_share['id']}")
    assert expired.status_code == 410
    assert expired.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_event_session_share_keeps_its_frozen_prefix_after_append(
    client: httpx.AsyncClient,
    anon_client: httpx.AsyncClient,
) -> None:
    session_id, local_id, environment_id, generation = await _seed_event_session(client)
    created = await client.post(
        f"/v1/sessions/{session_id}/shares",
        json={"scope": "session"},
    )
    assert created.status_code == 201, created.text

    base = await client.get(f"/v1/sessions/{session_id}/events")
    assert base.status_code == 200, base.text
    appended_event = _event(2, "assistant-2", "assistant", "Later answer")
    data, content_hash = _event_chunk([appended_event])
    final_head = advance_event_head(base.json()["head_hash"], [appended_event])
    appended = await client.post(
        f"/v1/sessions/{local_id}/events/append",
        data={
            "environment_id": environment_id,
            "append_id": str(uuid.uuid4()),
            "generation": generation,
            "base_revision": str(base.json()["revision"]),
            "base_count": str(base.json()["count"]),
            "base_head_hash": base.json()["head_hash"],
            "final_count": "3",
            "final_head_hash": final_head,
            "content_hash": content_hash,
        },
        files={"file": ("2.ndjson", data, "application/x-ndjson")},
    )
    assert appended.status_code == 200, appended.text

    frozen = await anon_client.get(f"/v1/public/session-shares/{created.json()['id']}/messages")
    assert frozen.status_code == 200, frozen.text
    assert [item["content"] for item in frozen.json()["items"]] == [
        "Original question",
        "Original answer",
    ]


@pytest.mark.asyncio
async def test_session_share_reports_storage_outages(
    client: httpx.AsyncClient,
    anon_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.routes import session_shares as session_shares_route

    session_id, _, _ = await _seed_session(client)
    created = await client.post(
        f"/v1/sessions/{session_id}/shares",
        json={"scope": "session"},
    )
    assert created.status_code == 201, created.text

    monkeypatch.setattr(
        session_shares_route,
        "file_store",
        _UnavailableReadFileStore(session_shares_route.file_store),
    )
    response = await anon_client.get(f"/v1/public/session-shares/{created.json()['id']}/messages")
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
