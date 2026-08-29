from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from pydantic import JsonValue, TypeAdapter, ValidationError

from app.schemas.session_events import (
    SessionEvent,
    SessionMessageEvent,
    SessionTextPart,
    SessionToolCallEvent,
    SessionToolResultEvent,
)

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


@dataclass(frozen=True, slots=True)
class ProjectedSessionTimelineItem:
    position: int
    kind: Literal["message", "tool_call", "tool_result"]
    value: dict[str, JsonValue]


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


def _safe_message_value(message: ProjectedSessionMessage) -> dict[str, JsonValue]:
    value: dict[str, JsonValue] = {
        "role": message.role,
        "content": message.content,
    }
    if message.model is not None:
        value["model"] = message.model
    if message.timestamp is not None:
        value["timestamp"] = message.timestamp.isoformat()
    return value


def project_safe_messages(events: Sequence[SessionEvent]) -> list[dict[str, JsonValue]]:
    return [_safe_message_value(message) for message in project_visible_messages(events)]


def project_safe_timeline(events: Sequence[SessionEvent]) -> list[ProjectedSessionTimelineItem]:
    """Project owner-visible messages and tool activity from canonical events.

    Reasoning, system/developer messages, hidden events, raw provider envelopes,
    and attachment bodies are deliberately absent. Public session routes do not
    consume this projection.
    """
    items: list[ProjectedSessionTimelineItem] = []
    for event in events:
        if event.semantics is not None and event.semantics.display == "hidden":
            continue
        if isinstance(event, SessionMessageEvent):
            if event.role not in ("user", "assistant"):
                continue
            text = "\n".join(
                part.text for part in event.parts if isinstance(part, SessionTextPart) and part.text
            )
            if not text:
                continue
            message = ProjectedSessionMessage(
                position=event.seq,
                role=event.role,
                content=text,
                model=event.model,
                timestamp=event.timestamp,
            )
            message_value: dict[str, JsonValue] = {
                "kind": "message",
                "position": event.seq,
                **_safe_message_value(message),
            }
            items.append(ProjectedSessionTimelineItem(event.seq, "message", message_value))
            continue
        if isinstance(event, SessionToolCallEvent):
            tool_call_value: dict[str, JsonValue] = {
                "kind": "tool_call",
                "position": event.seq,
                "call_id": event.call_id,
                "name": event.name,
            }
            if event.arguments_json is not None:
                tool_call_value["arguments_json"] = event.arguments_json
            if event.model is not None:
                tool_call_value["model"] = event.model
            if event.timestamp is not None:
                tool_call_value["timestamp"] = event.timestamp.isoformat()
            items.append(ProjectedSessionTimelineItem(event.seq, "tool_call", tool_call_value))
            continue
        if isinstance(event, SessionToolResultEvent):
            text = "\n".join(
                part.text for part in event.parts if isinstance(part, SessionTextPart) and part.text
            )
            tool_result_value: dict[str, JsonValue] = {
                "kind": "tool_result",
                "position": event.seq,
                "call_id": event.call_id,
                "status": event.status,
            }
            if event.name is not None:
                tool_result_value["name"] = event.name
            if text:
                tool_result_value["content"] = text
            if event.result_json is not None:
                tool_result_value["result_json"] = event.result_json
            if event.timestamp is not None:
                tool_result_value["timestamp"] = event.timestamp.isoformat()
            items.append(ProjectedSessionTimelineItem(event.seq, "tool_result", tool_result_value))
    return items
