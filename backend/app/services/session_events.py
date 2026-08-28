from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from pydantic import JsonValue, TypeAdapter, ValidationError

from app.schemas.session_events import SessionEvent, SessionMessageEvent, SessionTextPart

EMPTY_EVENT_HEAD = hashlib.sha256(b"clawdi-events-v1\n").hexdigest()
EVENT_ADAPTER: TypeAdapter[SessionEvent] = TypeAdapter(SessionEvent)
type RawSessionEvent = dict[str, JsonValue]
RAW_EVENT_ADAPTER: TypeAdapter[RawSessionEvent] = TypeAdapter(RawSessionEvent)


class SessionEventChunkInvalid(ValueError):
    pass


@dataclass(frozen=True)
class ValidatedEventChunk:
    events: list[SessionEvent]
    raw_events: list[RawSessionEvent]
    content_hash: str
    result_head_hash: str


@dataclass(frozen=True, slots=True)
class ProjectedSessionMessage:
    position: int
    role: Literal["user", "assistant"]
    content: str
    model: str | None
    timestamp: datetime | None


def canonical_event_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")


def advance_event_head(base_head_hash: str, raw_events: Sequence[RawSessionEvent]) -> str:
    try:
        head = bytes.fromhex(base_head_hash)
    except ValueError as exc:
        raise SessionEventChunkInvalid("invalid base event head") from exc
    if len(head) != 32:
        raise SessionEventChunkInvalid("invalid base event head")
    for event in raw_events:
        event_hash = hashlib.sha256(canonical_event_json(event)).digest()
        head = hashlib.sha256(head + event_hash).digest()
    return head.hex()


def validate_event_chunk(
    data: bytes, *, start_seq: int, base_head_hash: str
) -> ValidatedEventChunk:
    if not data or not data.endswith(b"\n"):
        raise SessionEventChunkInvalid("event chunks must be non-empty newline-terminated NDJSON")
    raw_events: list[RawSessionEvent] = []
    events: list[SessionEvent] = []
    for index, line in enumerate(data.splitlines()):
        if not line:
            raise SessionEventChunkInvalid("event chunks cannot contain blank lines")
        try:
            raw = RAW_EVENT_ADAPTER.validate_json(line, strict=True)
        except ValidationError as exc:
            raise SessionEventChunkInvalid("each event must be a valid JSON object") from exc
        try:
            # JSON strict mode still accepts JSON-native datetime strings,
            # while rejecting Python-side coercions and unknown fields.
            event = EVENT_ADAPTER.validate_json(line, strict=True)
        except ValidationError as exc:
            raise SessionEventChunkInvalid("event does not match events-v1") from exc
        if event.seq != start_seq + index:
            raise SessionEventChunkInvalid("event seq must be continuous")
        expected_id = hashlib.sha256(
            canonical_event_json({"source": raw["source"], "type": raw["type"]})
        ).hexdigest()
        if event.event_id != expected_id:
            raise SessionEventChunkInvalid("event_id does not match source identity")
        raw_events.append(raw)
        events.append(event)
    return ValidatedEventChunk(
        events=events,
        raw_events=raw_events,
        content_hash=hashlib.sha256(data).hexdigest(),
        result_head_hash=advance_event_head(base_head_hash, raw_events),
    )


async def validate_event_chunk_async(
    data: bytes, *, start_seq: int, base_head_hash: str
) -> ValidatedEventChunk:
    return await asyncio.to_thread(
        validate_event_chunk,
        data,
        start_seq=start_seq,
        base_head_hash=base_head_hash,
    )


def project_visible_messages(events: Sequence[SessionEvent]) -> list[ProjectedSessionMessage]:
    messages: list[ProjectedSessionMessage] = []
    for event in events:
        if not isinstance(event, SessionMessageEvent) or event.role not in ("user", "assistant"):
            continue
        if event.semantics is not None and event.semantics.display == "hidden":
            continue
        text = "\n".join(
            part.text for part in event.parts if isinstance(part, SessionTextPart) and part.text
        )
        if not text:
            continue
        messages.append(
            ProjectedSessionMessage(
                position=event.seq,
                role=event.role,
                content=text,
                model=event.model,
                timestamp=event.timestamp,
            )
        )
    return messages


def project_safe_messages(events: Sequence[SessionEvent]) -> list[dict[str, object]]:
    messages: list[dict[str, object]] = []
    for projected in project_visible_messages(events):
        message: dict[str, object] = {
            "role": projected.role,
            "content": projected.content,
        }
        if projected.model is not None:
            message["model"] = projected.model
        if projected.timestamp is not None:
            message["timestamp"] = projected.timestamp.isoformat()
        messages.append(message)
    return messages
