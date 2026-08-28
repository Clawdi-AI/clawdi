from __future__ import annotations

import hashlib
import threading
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.session import Session, SessionMessageSearch
from app.services.session_events import (
    EMPTY_EVENT_HEAD,
    EVENT_ADAPTER,
    ValidatedEventChunk,
    advance_event_head,
    canonical_event_json,
    project_safe_messages,
)
from app.services.session_search import rebuild_session_search_index


def _source(record_id: str, part_index: int | None = None) -> dict[str, Any]:
    return {
        "adapter": "pi",
        "session_key": "fixture-session",
        "record_id": record_id,
        **({} if part_index is None else {"part_index": part_index}),
    }


def _event(seq: int, event_type: str, record_id: str, **fields: Any) -> dict[str, Any]:
    source = _source(record_id, fields.pop("part_index", None))
    event_id = hashlib.sha256(
        canonical_event_json({"source": source, "type": event_type})
    ).hexdigest()
    return {
        "seq": seq,
        "event_id": event_id,
        "source": source,
        "type": event_type,
        **fields,
    }


def _chunk(events: list[dict[str, Any]]) -> tuple[bytes, str]:
    data = b"".join(canonical_event_json(event) + b"\n" for event in events)
    return data, hashlib.sha256(data).hexdigest()


@pytest.mark.asyncio
async def test_event_chunk_validation_runs_off_the_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import session_events

    event_loop_thread = threading.get_ident()
    validation_thread: int | None = None
    expected = ValidatedEventChunk(
        events=[],
        raw_events=[],
        content_hash="a" * 64,
        result_head_hash="b" * 64,
    )

    def validate(data: bytes, *, start_seq: int, base_head_hash: str) -> ValidatedEventChunk:
        nonlocal validation_thread
        assert data == b"chunk"
        assert start_seq == 7
        assert base_head_hash == EMPTY_EVENT_HEAD
        validation_thread = threading.get_ident()
        return expected

    monkeypatch.setattr(session_events, "validate_event_chunk", validate)

    actual = await session_events.validate_event_chunk_async(
        b"chunk", start_seq=7, base_head_hash=EMPTY_EVENT_HEAD
    )

    assert actual is expected
    assert validation_thread is not None
    assert validation_thread != event_loop_thread


def test_hermes_event_semantics_are_strict_and_normalized() -> None:
    event = _event(
        0,
        "message",
        "42",
        role="user",
        parts=[{"type": "text", "text": "durable context"}],
        semantics={
            "lifecycle": "inactive",
            "display": "event",
            "compressed_summary": False,
            "display_kind": "auto_continue",
            "display_metadata": {"attempt": 2},
        },
    )
    event["source"]["adapter"] = "hermes"
    event["event_id"] = hashlib.sha256(
        canonical_event_json({"source": event["source"], "type": "message"})
    ).hexdigest()

    validated = EVENT_ADAPTER.validate_python(event, strict=True)

    assert validated.source.adapter == "hermes"
    assert validated.semantics is not None
    assert validated.semantics.lifecycle == "inactive"
    assert validated.semantics.display_metadata is not None
    assert validated.semantics.display_metadata.attempt == 2


def test_reasoning_event_requires_private_content() -> None:
    with pytest.raises(ValidationError):
        EVENT_ADAPTER.validate_python(
            _event(0, "reasoning", "empty", kind="thinking", parts=[]), strict=True
        )


def test_safe_projection_keeps_hidden_opencode_content_private() -> None:
    visible = EVENT_ADAPTER.validate_python(
        _event(
            0,
            "message",
            "visible",
            role="assistant",
            parts=[{"type": "text", "text": "visible answer"}],
        ),
        strict=True,
    )
    hidden_payload = _event(
        1,
        "message",
        "ignored",
        role="assistant",
        parts=[{"type": "text", "text": "private ignored text"}],
        semantics={
            "lifecycle": "active",
            "display": "hidden",
            "compressed_summary": False,
            "display_kind": "ignored_text",
        },
    )
    hidden_payload["source"]["adapter"] = "opencode"
    hidden_payload["event_id"] = hashlib.sha256(
        canonical_event_json({"source": hidden_payload["source"], "type": "message"})
    ).hexdigest()
    hidden = EVENT_ADAPTER.validate_python(hidden_payload, strict=True)

    assert hidden.source.adapter == "opencode"
    assert project_safe_messages([visible, hidden]) == [
        {"role": "assistant", "content": "visible answer"}
    ]


async def _register_session(
    client: httpx.AsyncClient,
    db: AsyncSession,
    *,
    local_session_id: str,
) -> tuple[str, Session]:
    registered = await client.post(
        "/v1/agents",
        json={
            "machine_id": f"pi-{uuid.uuid4().hex}",
            "machine_name": "Pi fixture",
            "agent_type": "pi",
            "agent_version": "0.50.2",
            "os": "linux",
            "adapter_modules": ["sessions"],
        },
    )
    assert registered.status_code == 200, registered.text
    environment_id = registered.json()["id"]
    batch = await client.post(
        "/v1/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": environment_id,
                    "local_session_id": local_session_id,
                    "started_at": datetime.now(UTC).isoformat(),
                    "message_count": 2,
                    "content_protocol": "events-v1",
                }
            ]
        },
    )
    assert batch.status_code == 200, batch.text
    assert batch.json()["needs_content"] == []
    session = (
        await db.execute(
            select(Session).where(
                Session.origin_environment_id == uuid.UUID(environment_id),
                Session.local_session_id == local_session_id,
            )
        )
    ).scalar_one()
    return environment_id, session


async def _commit_generation(
    client: httpx.AsyncClient,
    *,
    environment_id: str,
    local_session_id: str,
    events: list[dict[str, Any]],
    base_generation: str | None = None,
    base_revision: int = 0,
    base_count: int = 0,
    base_head_hash: str = EMPTY_EVENT_HEAD,
) -> tuple[str, str, str]:
    generation = str(uuid.uuid4())
    append_id = str(uuid.uuid4())
    final_head = advance_event_head(EMPTY_EVENT_HEAD, events)
    staged = await client.post(
        f"/v1/sessions/{local_session_id}/events/generations",
        json={
            "environment_id": environment_id,
            "generation": generation,
            "append_id": append_id,
            "base_generation": base_generation,
            "base_revision": base_revision,
            "base_count": base_count,
            "base_head_hash": base_head_hash,
            "final_count": len(events),
            "final_head_hash": final_head,
        },
    )
    assert staged.status_code == 200, staged.text
    data, content_hash = _chunk(events)
    uploaded = await client.put(
        f"/v1/sessions/{local_session_id}/events/generations/{generation}/chunks/0",
        data={"base_head_hash": EMPTY_EVENT_HEAD, "content_hash": content_hash},
        files={"file": ("0.ndjson", data, "application/x-ndjson")},
    )
    assert uploaded.status_code == 200, uploaded.text
    committed = await client.post(
        f"/v1/sessions/{local_session_id}/events/generations/{generation}/commit",
        json={
            "append_id": append_id,
            "base_generation": base_generation,
            "base_revision": base_revision,
            "base_count": base_count,
            "base_head_hash": base_head_hash,
            "final_count": len(events),
            "final_head_hash": final_head,
        },
    )
    assert committed.status_code == 200, committed.text
    return generation, final_head, append_id


@pytest.mark.asyncio
async def test_legacy_batch_does_not_request_snapshot_over_committed_events(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    local_id = "pi.legacy-client-session"
    environment_id, session = await _register_session(client, db_session, local_session_id=local_id)
    events = [
        _event(
            0,
            "message",
            "user",
            role="user",
            parts=[{"type": "text", "text": "event content"}],
        )
    ]
    generation, head_hash, _ = await _commit_generation(
        client,
        environment_id=environment_id,
        local_session_id=local_id,
        events=events,
    )

    # Old clients omit content_protocol, so the request defaults to
    # snapshot-v1 even after the row has been upgraded to events-v1.
    legacy_batch = await client.post(
        "/v1/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": environment_id,
                    "local_session_id": local_id,
                    "started_at": datetime.now(UTC).isoformat(),
                    "message_count": 99,
                    "content_hash": "b" * 64,
                }
            ]
        },
    )
    assert legacy_batch.status_code == 200, legacy_batch.text
    assert legacy_batch.json()["needs_content"] == []

    await db_session.refresh(session)
    assert session.content_protocol == "events-v1"
    assert str(session.event_generation_id) == generation
    assert session.event_count == len(events)
    assert session.event_head_hash == head_hash
    assert session.content_hash == head_hash
    assert session.content_uploaded_at is not None


@pytest.mark.asyncio
async def test_events_v1_strict_append_idempotency_and_safe_projection(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.routes import session_events as event_routes

    local_id = "pi.fixture-session"
    environment_id, session = await _register_session(client, db_session, local_session_id=local_id)
    events = [
        _event(
            0,
            "message",
            "system",
            role="system",
            parts=[{"type": "text", "text": "private context"}],
            timestamp="2026-08-25T10:00:00.000Z",
        ),
        _event(
            1,
            "message",
            "user",
            role="user",
            parts=[
                {"type": "text", "text": "inspect this"},
                {
                    "type": "attachment",
                    "attachment_id": "sha256:" + ("a" * 64),
                    "availability": "external",
                    "uri": "https://cdn.example.com/screen.png",
                    "media_type": "image/png",
                    "name": "screen.png",
                    "size_bytes": 42,
                    "sha256": "b" * 64,
                },
            ],
        ),
        _event(
            2,
            "tool_call",
            "assistant",
            part_index=1,
            call_id="call-1",
            name="read",
            arguments_json='{"path":"README.md"}',
        ),
        _event(
            3,
            "tool_result",
            "result",
            call_id="call-1",
            name="read",
            status="completed",
            parts=[{"type": "text", "text": "secret tool output"}],
        ),
        _event(
            4,
            "message",
            "assistant",
            role="assistant",
            parts=[{"type": "text", "text": "visible answer"}],
            model="claude-sonnet",
        ),
    ]
    generation, base_head, generation_append_id = await _commit_generation(
        client,
        environment_id=environment_id,
        local_session_id=local_id,
        events=events,
    )
    initial_messages = await client.get(
        f"/v1/sessions/{session.id}/messages",
        params={"direction": "desc", "limit": 2},
    )
    assert initial_messages.status_code == 200, initial_messages.text
    assert initial_messages.json() == {
        "items": [
            {
                "role": "assistant",
                "content": "visible answer",
                "model": "claude-sonnet",
                "timestamp": None,
            },
            {"role": "user", "content": "inspect this", "model": None, "timestamp": None},
        ],
        "total": 2,
        "offset": 0,
        "limit": 2,
    }
    generation_commit = {
        "append_id": generation_append_id,
        "base_generation": None,
        "base_revision": 0,
        "base_count": 0,
        "base_head_hash": EMPTY_EVENT_HEAD,
        "final_count": len(events),
        "final_head_hash": base_head,
    }
    committed_retry = await client.post(
        f"/v1/sessions/{local_id}/events/generations/{generation}/commit",
        json=generation_commit,
    )
    assert committed_retry.status_code == 200, committed_retry.text
    assert committed_retry.json() == {
        "generation": generation,
        "revision": 1,
        "count": len(events),
        "head_hash": base_head,
    }

    invalid = {**_event(5, "message", "invalid", role="assistant", parts=[]), "raw": "forbidden"}
    invalid_data, invalid_hash = _chunk([invalid])
    rejected = await client.post(
        f"/v1/sessions/{local_id}/events/append",
        data={
            "environment_id": environment_id,
            "append_id": str(uuid.uuid4()),
            "generation": generation,
            "base_revision": "1",
            "base_count": "5",
            "base_head_hash": base_head,
            "final_count": "6",
            "final_head_hash": advance_event_head(base_head, [invalid]),
            "content_hash": invalid_hash,
        },
        files={"file": ("5.ndjson", invalid_data, "application/x-ndjson")},
    )
    assert rejected.status_code == 422

    class NoReadStore:
        def __init__(self, delegate: Any) -> None:
            self.delegate = delegate
            self.get_calls = 0

        async def get(self, key: str) -> bytes:
            self.get_calls += 1
            raise AssertionError(f"append read existing object {key}")

        async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
            await self.delegate.put(key, data, content_type)

    no_read = NoReadStore(event_routes.file_store)
    monkeypatch.setattr(event_routes, "file_store", no_read)
    appended_event = _event(
        5,
        "reasoning",
        "assistant-2",
        kind="thinking",
        parts=[{"type": "text", "text": "private chain of thought"}],
        payload_json='{"signature":"opaque"}',
    )
    appended_data, appended_hash = _chunk([appended_event])
    final_head = advance_event_head(base_head, [appended_event])
    append_id = str(uuid.uuid4())
    append_form = {
        "environment_id": environment_id,
        "append_id": append_id,
        "generation": generation,
        "base_revision": "1",
        "base_count": "5",
        "base_head_hash": base_head,
        "final_count": "6",
        "final_head_hash": final_head,
        "content_hash": appended_hash,
    }
    appended = await client.post(
        f"/v1/sessions/{local_id}/events/append",
        data=append_form,
        files={"file": ("5.ndjson", appended_data, "application/x-ndjson")},
    )
    assert appended.status_code == 200, appended.text
    assert appended.json()["head_hash"] == final_head
    retried = await client.post(
        f"/v1/sessions/{local_id}/events/append",
        data=append_form,
        files={"file": ("5.ndjson", appended_data, "application/x-ndjson")},
    )
    assert retried.status_code == 200, retried.text
    assert retried.json() == appended.json()
    assert no_read.get_calls == 0

    append_identity_conflict = await client.post(
        f"/v1/sessions/{local_id}/events/append",
        data={**append_form, "base_revision": "0"},
        files={"file": ("5.ndjson", appended_data, "application/x-ndjson")},
    )
    assert append_identity_conflict.status_code == 409

    stale_committed_retry = await client.post(
        f"/v1/sessions/{local_id}/events/generations/{generation}/commit",
        json=generation_commit,
    )
    assert stale_committed_retry.status_code == 409

    second_event = _event(
        6,
        "message",
        "assistant-3",
        role="assistant",
        parts=[{"type": "text", "text": "appended left\x00right answer"}],
    )
    second_data, second_hash = _chunk([second_event])
    second_head = advance_event_head(final_head, [second_event])
    second_append = await client.post(
        f"/v1/sessions/{local_id}/events/append",
        data={
            "environment_id": environment_id,
            "append_id": str(uuid.uuid4()),
            "generation": generation,
            "base_revision": "2",
            "base_count": "6",
            "base_head_hash": final_head,
            "final_count": "7",
            "final_head_hash": second_head,
            "content_hash": second_hash,
        },
        files={"file": ("6.ndjson", second_data, "application/x-ndjson")},
    )
    assert second_append.status_code == 200, second_append.text
    await db_session.refresh(session)
    assert session.event_head_hash == second_head
    assert session.content_hash == second_head
    assert session.content_uploaded_at is not None

    stale_append_retry = await client.post(
        f"/v1/sessions/{local_id}/events/append",
        data=append_form,
        files={"file": ("5.ndjson", appended_data, "application/x-ndjson")},
    )
    assert stale_append_retry.status_code == 409

    mismatched_stage_retry = await client.post(
        f"/v1/sessions/{local_id}/events/generations",
        json={
            "environment_id": environment_id,
            "generation": generation,
            "append_id": generation_append_id,
            "base_generation": None,
            "base_revision": 1,
            "base_count": 0,
            "base_head_hash": EMPTY_EVENT_HEAD,
            "final_count": len(events),
            "final_head_hash": base_head,
        },
    )
    assert mismatched_stage_retry.status_code == 409

    other_event = _event(
        5, "message", "other", role="assistant", parts=[{"type": "text", "text": "other answer"}]
    )
    other_data, other_hash = _chunk([other_event])
    conflict = await client.post(
        f"/v1/sessions/{local_id}/events/append",
        data={
            **append_form,
            "append_id": str(uuid.uuid4()),
            "final_head_hash": advance_event_head(base_head, [other_event]),
            "content_hash": other_hash,
        },
        files={"file": ("5.ndjson", other_data, "application/x-ndjson")},
    )
    assert conflict.status_code == 409
    monkeypatch.setattr(event_routes, "file_store", no_read.delegate)

    private = await client.get(f"/v1/sessions/{session.id}/events")
    assert private.status_code == 200, private.text
    assert [event["type"] for event in private.json()["events"]] == [
        "message",
        "message",
        "tool_call",
        "tool_result",
        "message",
        "reasoning",
        "message",
    ]
    private_reasoning = private.json()["events"][5]
    assert private_reasoning["kind"] == "thinking"
    assert private_reasoning["parts"] == [{"type": "text", "text": "private chain of thought"}]
    assert private_reasoning["payload_json"] == '{"signature":"opaque"}'
    assert private.json()["events"][6]["parts"] == [
        {"type": "text", "text": "appended left\x00right answer"}
    ]
    projected = await client.get(f"/v1/sessions/{session.id}/content")
    assert projected.status_code == 200, projected.text
    assert projected.json() == [
        {"role": "user", "content": "inspect this", "model": None, "timestamp": None},
        {
            "role": "assistant",
            "content": "visible answer",
            "model": "claude-sonnet",
            "timestamp": None,
        },
        {
            "role": "assistant",
            "content": "appended left\x00right answer",
            "model": None,
            "timestamp": None,
        },
    ]
    assert "private context" not in projected.text
    assert "private chain of thought" not in projected.text
    assert "opaque" not in projected.text
    assert "secret tool output" not in projected.text

    # The committed generation now spans three immutable chunks. The read path
    # must use the new event head after both appends instead of serving the
    # two-message projection cached before them.
    latest_messages = await client.get(
        f"/v1/sessions/{session.id}/messages",
        params={"direction": "desc", "limit": 2},
    )
    assert latest_messages.status_code == 200, latest_messages.text
    assert latest_messages.json() == {
        "items": [
            {
                "role": "assistant",
                "content": "appended left\x00right answer",
                "model": None,
                "timestamp": None,
            },
            {
                "role": "assistant",
                "content": "visible answer",
                "model": "claude-sonnet",
                "timestamp": None,
            },
        ],
        "total": 3,
        "offset": 0,
        "limit": 2,
    }

    anchored_messages = await client.get(
        f"/v1/sessions/{session.id}/messages",
        params={
            "direction": "desc",
            "limit": 2,
            "anchor_kind": "event_seq",
            "anchor_position": 4,
            "anchor_revision": f"events:{second_head}",
        },
    )
    assert anchored_messages.status_code == 200, anchored_messages.text
    assert anchored_messages.json()["anchor_offset"] == 1
    assert [item["content"] for item in anchored_messages.json()["items"]] == [
        "appended left\x00right answer",
        "visible answer",
    ]

    visible_search = (await client.get("/v1/sessions", params={"q": "visible answer"})).json()
    assert [item["local_session_id"] for item in visible_search["items"]] == [local_id]
    assert visible_search["items"][0]["search_match"] == {
        "role": "assistant",
        "excerpt": "visible answer",
        "anchor": {
            "kind": "event_seq",
            "position": 4,
            "revision": f"events:{second_head}",
        },
    }
    event_navigation = await client.get(
        f"/v1/sessions/{session.id}/messages",
        params={
            "anchor_kind": "event_seq",
            "anchor_position": 4,
            "anchor_revision": f"events:{second_head}",
            "search_query": "answer",
        },
    )
    assert event_navigation.status_code == 200, event_navigation.text
    assert event_navigation.json()["search_navigation"] == {
        "index": 1,
        "total": 2,
        "previous": None,
        "next": {
            "kind": "event_seq",
            "position": 6,
            "revision": f"events:{second_head}",
        },
    }
    appended_search = (await client.get("/v1/sessions", params={"q": "right answer"})).json()
    assert [item["local_session_id"] for item in appended_search["items"]] == [local_id]
    assert appended_search["items"][0]["search_match"] == {
        "role": "assistant",
        "excerpt": "appended left\ufffdright answer",
        "anchor": {
            "kind": "event_seq",
            "position": 6,
            "revision": f"events:{second_head}",
        },
    }
    for private_query in ("private chain of thought", "secret tool output"):
        private_search = (await client.get("/v1/sessions", params={"q": private_query})).json()
        assert all(item["search_match"] is None for item in private_search["items"])

    await db_session.execute(
        delete(SessionMessageSearch).where(SessionMessageSearch.session_id == session.id)
    )
    session.search_index_revision = None
    await db_session.commit()
    await rebuild_session_search_index(db_session, session, event_routes.file_store)
    await db_session.commit()
    rebuilt_search = (await client.get("/v1/sessions", params={"q": "visible answer"})).json()
    assert [item["local_session_id"] for item in rebuilt_search["items"]] == [local_id]


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_event_search_rebuild_does_not_replace_a_concurrent_append(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    engine,
) -> None:
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.routes import session_events as event_routes

    local_id = "pi.search-rebuild-race"
    environment_id, session = await _register_session(client, db_session, local_session_id=local_id)
    original = [
        _event(
            0,
            "message",
            "original",
            role="user",
            parts=[{"type": "text", "text": "original searchable event"}],
        )
    ]
    generation, original_head, _ = await _commit_generation(
        client,
        environment_id=environment_id,
        local_session_id=local_id,
        events=original,
    )
    appended = _event(
        1,
        "message",
        "appended",
        role="assistant",
        parts=[{"type": "text", "text": "concurrent appended search event"}],
    )
    appended_data, appended_hash = _chunk([appended])
    appended_head = advance_event_head(original_head, [appended])
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    class RacingFileStore:
        triggered = False

        async def get(self, key: str) -> bytes:
            if not self.triggered:
                self.triggered = True
                response = await client.post(
                    f"/v1/sessions/{local_id}/events/append",
                    data={
                        "environment_id": environment_id,
                        "append_id": str(uuid.uuid4()),
                        "generation": generation,
                        "base_revision": 1,
                        "base_count": 1,
                        "base_head_hash": original_head,
                        "final_count": 2,
                        "final_head_hash": appended_head,
                        "content_hash": appended_hash,
                    },
                    files={
                        "file": (
                            "1.ndjson",
                            appended_data,
                            "application/x-ndjson",
                        )
                    },
                )
                assert response.status_code == 200, response.text
            return await event_routes.file_store.get(key)

    async with session_factory() as backfill_db:
        stale = await backfill_db.get(Session, session.id)
        assert stale is not None
        rebuilt = await rebuild_session_search_index(backfill_db, stale, RacingFileStore())
        await backfill_db.commit()
    assert rebuilt is False

    search = (
        await client.get("/v1/sessions", params={"q": "concurrent appended search event"})
    ).json()
    assert [item["local_session_id"] for item in search["items"]] == [local_id]
    assert search["items"][0]["search_match"]["anchor"]["revision"] == (f"events:{appended_head}")


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_event_search_rebuild_fences_same_head_generation_replacement(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    engine,
) -> None:
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.routes import session_events as event_routes

    local_id = "pi.search-rebuild-generation-race"
    environment_id, session = await _register_session(client, db_session, local_session_id=local_id)
    events = [
        _event(
            0,
            "message",
            "stable",
            role="assistant",
            parts=[{"type": "text", "text": "same head replacement remains searchable"}],
        )
    ]
    generation, head, _ = await _commit_generation(
        client,
        environment_id=environment_id,
        local_session_id=local_id,
        events=events,
    )
    await db_session.refresh(session)
    session.search_index_revision = None
    await db_session.commit()
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    class RacingFileStore:
        triggered = False

        async def get(self, key: str) -> bytes:
            if not self.triggered:
                self.triggered = True
                replacement_generation, replacement_head, _ = await _commit_generation(
                    client,
                    environment_id=environment_id,
                    local_session_id=local_id,
                    events=events,
                    base_generation=generation,
                    base_revision=1,
                    base_count=1,
                    base_head_hash=head,
                )
                assert replacement_generation != generation
                assert replacement_head == head
            return await event_routes.file_store.get(key)

    async with session_factory() as backfill_db:
        stale = await backfill_db.get(Session, session.id)
        assert stale is not None
        rebuilt = await rebuild_session_search_index(backfill_db, stale, RacingFileStore())
        await backfill_db.commit()
    assert rebuilt is False

    search = (await client.get("/v1/sessions", params={"q": "same head replacement"})).json()
    assert [item["local_session_id"] for item in search["items"]] == [local_id]
    assert search["items"][0]["search_match"]["anchor"]["revision"] == f"events:{head}"


@pytest.mark.asyncio
async def test_generation_commit_does_not_publish_an_incomplete_search_projection(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    from app.models.session import SessionEventChunk
    from app.routes import session_events as event_routes

    local_id = "pi.incomplete-search-projection"
    environment_id, session = await _register_session(client, db_session, local_session_id=local_id)
    events = [
        _event(
            0,
            "message",
            "visible",
            role="assistant",
            parts=[{"type": "text", "text": "cross version searchable event"}],
        )
    ]
    generation = str(uuid.uuid4())
    append_id = str(uuid.uuid4())
    final_head = advance_event_head(EMPTY_EVENT_HEAD, events)
    staged = await client.post(
        f"/v1/sessions/{local_id}/events/generations",
        json={
            "environment_id": environment_id,
            "generation": generation,
            "append_id": append_id,
            "base_generation": None,
            "base_revision": 0,
            "base_count": 0,
            "base_head_hash": EMPTY_EVENT_HEAD,
            "final_count": 1,
            "final_head_hash": final_head,
        },
    )
    assert staged.status_code == 200, staged.text
    data, content_hash = _chunk(events)
    uploaded = await client.put(
        f"/v1/sessions/{local_id}/events/generations/{generation}/chunks/0",
        data={"base_head_hash": EMPTY_EVENT_HEAD, "content_hash": content_hash},
        files={"file": ("0.ndjson", data, "application/x-ndjson")},
    )
    assert uploaded.status_code == 200, uploaded.text

    generation_id = uuid.UUID(generation)
    chunk = (
        await db_session.execute(
            select(SessionEventChunk).where(SessionEventChunk.generation_id == generation_id)
        )
    ).scalar_one()
    await db_session.execute(
        delete(SessionMessageSearch).where(SessionMessageSearch.generation_id == generation_id)
    )
    chunk.search_indexed_at = None
    await db_session.commit()

    committed = await client.post(
        f"/v1/sessions/{local_id}/events/generations/{generation}/commit",
        json={
            "append_id": append_id,
            "base_generation": None,
            "base_revision": 0,
            "base_count": 0,
            "base_head_hash": EMPTY_EVENT_HEAD,
            "final_count": 1,
            "final_head_hash": final_head,
        },
    )
    assert committed.status_code == 200, committed.text
    await db_session.refresh(session)
    assert session.search_index_revision is None
    before_rebuild = (
        await client.get("/v1/sessions", params={"q": "cross version searchable event"})
    ).json()
    assert all(item["search_match"] is None for item in before_rebuild["items"])

    rebuilt = await rebuild_session_search_index(
        db_session,
        session,
        event_routes.file_store,
    )
    await db_session.commit()
    assert rebuilt is True
    after_rebuild = (
        await client.get("/v1/sessions", params={"q": "cross version searchable event"})
    ).json()
    assert [item["local_session_id"] for item in after_rebuild["items"]] == [local_id]
    assert after_rebuild["items"][0]["search_match"]["anchor"]["revision"] == (
        f"events:{final_head}"
    )


@pytest.mark.asyncio
async def test_events_v1_rewrite_commit_is_cas_fenced(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    local_id = "pi.rewrite-session"
    environment_id, _ = await _register_session(client, db_session, local_session_id=local_id)
    original = [
        _event(
            0,
            "message",
            "user",
            role="user",
            parts=[{"type": "text", "text": "orchid junction 731"}],
        )
    ]
    generation, original_head, _ = await _commit_generation(
        client,
        environment_id=environment_id,
        local_session_id=local_id,
        events=original,
    )
    replacement = [
        _event(
            0,
            "message",
            "replacement",
            role="user",
            parts=[{"type": "text", "text": "velvet cosmos 942"}],
        )
    ]
    replacement_head = advance_event_head(EMPTY_EVENT_HEAD, replacement)
    staged_generation = str(uuid.uuid4())
    staged_append_id = str(uuid.uuid4())
    staged = await client.post(
        f"/v1/sessions/{local_id}/events/generations",
        json={
            "environment_id": environment_id,
            "generation": staged_generation,
            "append_id": staged_append_id,
            "base_generation": generation,
            "base_revision": 1,
            "base_count": 1,
            "base_head_hash": original_head,
            "final_count": 1,
            "final_head_hash": replacement_head,
        },
    )
    assert staged.status_code == 200, staged.text
    replacement_data, replacement_hash = _chunk(replacement)
    uploaded = await client.put(
        f"/v1/sessions/{local_id}/events/generations/{staged_generation}/chunks/0",
        data={"base_head_hash": EMPTY_EVENT_HEAD, "content_hash": replacement_hash},
        files={"file": ("0.ndjson", replacement_data, "application/x-ndjson")},
    )
    assert uploaded.status_code == 200, uploaded.text
    staged_search = (await client.get("/v1/sessions", params={"q": "velvet cosmos 942"})).json()
    assert all(item["search_match"] is None for item in staged_search["items"])

    concurrent = _event(
        1,
        "message",
        "concurrent",
        role="assistant",
        parts=[{"type": "text", "text": "cobalt river 583"}],
    )
    concurrent_data, concurrent_hash = _chunk([concurrent])
    concurrent_head = advance_event_head(original_head, [concurrent])
    advanced = await client.post(
        f"/v1/sessions/{local_id}/events/append",
        data={
            "environment_id": environment_id,
            "append_id": str(uuid.uuid4()),
            "generation": generation,
            "base_revision": "1",
            "base_count": "1",
            "base_head_hash": original_head,
            "final_count": "2",
            "final_head_hash": concurrent_head,
            "content_hash": concurrent_hash,
        },
        files={"file": ("1.ndjson", concurrent_data, "application/x-ndjson")},
    )
    assert advanced.status_code == 200, advanced.text

    stale_commit = await client.post(
        f"/v1/sessions/{local_id}/events/generations/{staged_generation}/commit",
        json={
            "append_id": staged_append_id,
            "base_generation": generation,
            "base_revision": 1,
            "base_count": 1,
            "base_head_hash": original_head,
            "final_count": 1,
            "final_head_hash": replacement_head,
        },
    )
    assert stale_commit.status_code == 409

    fresh_generation = str(uuid.uuid4())
    fresh_append_id = str(uuid.uuid4())
    fresh_stage = await client.post(
        f"/v1/sessions/{local_id}/events/generations",
        json={
            "environment_id": environment_id,
            "generation": fresh_generation,
            "append_id": fresh_append_id,
            "base_generation": generation,
            "base_revision": 2,
            "base_count": 2,
            "base_head_hash": concurrent_head,
            "final_count": 1,
            "final_head_hash": replacement_head,
        },
    )
    assert fresh_stage.status_code == 200, fresh_stage.text
    fresh_upload = await client.put(
        f"/v1/sessions/{local_id}/events/generations/{fresh_generation}/chunks/0",
        data={"base_head_hash": EMPTY_EVENT_HEAD, "content_hash": replacement_hash},
        files={"file": ("0.ndjson", replacement_data, "application/x-ndjson")},
    )
    assert fresh_upload.status_code == 200, fresh_upload.text
    fresh_commit = await client.post(
        f"/v1/sessions/{local_id}/events/generations/{fresh_generation}/commit",
        json={
            "append_id": fresh_append_id,
            "base_generation": generation,
            "base_revision": 2,
            "base_count": 2,
            "base_head_hash": concurrent_head,
            "final_count": 1,
            "final_head_hash": replacement_head,
        },
    )
    assert fresh_commit.status_code == 200, fresh_commit.text

    replacement_search = (
        await client.get("/v1/sessions", params={"q": "velvet cosmos 942"})
    ).json()
    assert [item["local_session_id"] for item in replacement_search["items"]] == [local_id]
    for retired_query in ("orchid junction 731", "cobalt river 583"):
        retired_search = (await client.get("/v1/sessions", params={"q": retired_query})).json()
        assert all(item["search_match"] is None for item in retired_search["items"])
