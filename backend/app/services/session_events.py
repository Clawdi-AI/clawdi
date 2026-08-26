from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

from pydantic import TypeAdapter, ValidationError

from app.schemas.session_events import SessionEvent

EMPTY_EVENT_HEAD = hashlib.sha256(b"clawdi-events-v1\n").hexdigest()
EVENT_ADAPTER: TypeAdapter[SessionEvent] = TypeAdapter(SessionEvent)


class SessionEventChunkInvalid(ValueError):
    pass


@dataclass(frozen=True)
class ValidatedEventChunk:
    events: list[SessionEvent]
    raw_events: list[dict[str, object]]
    content_hash: str
    result_head_hash: str


def canonical_event_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")


def advance_event_head(base_head_hash: str, raw_events: list[dict[str, object]]) -> str:
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
    raw_events: list[dict[str, object]] = []
    events: list[SessionEvent] = []
    for index, line in enumerate(data.splitlines()):
        if not line:
            raise SessionEventChunkInvalid("event chunks cannot contain blank lines")
        try:
            raw = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SessionEventChunkInvalid("event chunk contains invalid JSON") from exc
        if not isinstance(raw, dict):
            raise SessionEventChunkInvalid("each event must be a JSON object")
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


def project_safe_messages(raw_events: list[dict[str, object]]) -> list[dict[str, object]]:
    messages: list[dict[str, object]] = []
    for event in raw_events:
        if event.get("type") != "message" or event.get("role") not in ("user", "assistant"):
            continue
        parts = event.get("parts")
        if not isinstance(parts, list):
            continue
        text = "\n".join(
            part["text"]
            for part in parts
            if isinstance(part, dict)
            and part.get("type") == "text"
            and isinstance(part.get("text"), str)
            and part["text"]
        )
        if not text:
            continue
        message: dict[str, object] = {"role": event["role"], "content": text}
        if isinstance(event.get("model"), str):
            message["model"] = event["model"]
        if isinstance(event.get("timestamp"), str):
            message["timestamp"] = event["timestamp"]
        messages.append(message)
    return messages
