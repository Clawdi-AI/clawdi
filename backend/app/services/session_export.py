"""Markdown serializers for owned sessions and immutable snapshot shares.

Immutable snapshots and owner exports use their respective Markdown serializers.
The `session_get` MCP tool may additionally annotate owner-only message
headings with stable source positions for scoped sharing.

The Markdown body opens with a YAML front-matter block. That's the
signal to an LLM (or an MCP wrapper) that this isn't a random web
page — it's a structured session log it can ingest as conversation
context.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from uuid import UUID

from pydantic import JsonValue

from app.core.config import settings
from app.models.session import Session


def _yaml_escape(value: object) -> str:
    """Render a value safely for a YAML scalar.

    We're emitting only a handful of simple types (str / int / datetime
    ISO / None), all of which round-trip cleanly through `json.dumps`
    which is a strict subset of YAML for these scalars. Using JSON here
    avoids hand-rolling YAML escaping for embedded quotes / colons /
    Unicode — the agent reading the front-matter is more than capable
    of consuming JSON-encoded scalars.
    """
    if value is None:
        return "null"
    return json.dumps(value, ensure_ascii=False)


def _build_session_share_url(share_id: UUID) -> str:
    return f"{settings.web_origin}/s/{share_id}"


def _message_body_lines(
    messages: Sequence[JsonValue],
    *,
    source_positions: Sequence[int] | None = None,
) -> list[str]:
    if source_positions is not None and len(source_positions) != len(messages):
        raise ValueError("message positions must align with messages")

    body_lines: list[str] = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            continue
        role_value = message.get("role")
        role = role_value if isinstance(role_value, str) and role_value else "unknown"
        model_value = message.get("model")
        model = model_value if isinstance(model_value, str) and model_value else None
        timestamp_value = message.get("timestamp")
        timestamp = (
            timestamp_value if isinstance(timestamp_value, str) and timestamp_value else None
        )

        heading_parts: list[str] = [f"## {role.capitalize()}"]
        if role == "assistant" and model:
            heading_parts.append(f"({model})")
        if source_positions is not None:
            heading_parts.append(f"· position {source_positions[index]}")
        if timestamp:
            heading_parts.append(f"· {timestamp}")
        body_lines.extend((" ".join(heading_parts), ""))

        content_value = message.get("content")
        body_lines.extend((content_value if isinstance(content_value, str) else "", ""))
    return body_lines


def session_share_to_markdown(
    *,
    share_id: UUID,
    title: str,
    agent_type: str | None,
    model: str | None,
    started_at: str,
    message_count: int,
    messages: Sequence[JsonValue],
) -> str:
    """Serialize a frozen Session share without owner-only metadata."""
    front_matter_lines = [
        "---",
        f"source: {_yaml_escape('clawdi-shared-session')}",
        f"url: {_yaml_escape(_build_session_share_url(share_id))}",
    ]
    if agent_type:
        front_matter_lines.append(f"agent: {_yaml_escape(agent_type)}")
    if model:
        front_matter_lines.append(f"model: {_yaml_escape(model)}")
    front_matter_lines.extend(
        (
            f"started_at: {_yaml_escape(str(started_at))}",
            f"messages: {message_count}",
            "---",
            "",
            f"# {title}",
            "",
        )
    )
    return "\n".join(front_matter_lines + _message_body_lines(messages))


def session_to_markdown(
    session: Session,
    messages: Sequence[JsonValue],
    *,
    agent_type: str | None = None,
    source_positions: Sequence[int] | None = None,
) -> str:
    """Serialize one session to Markdown with a YAML front-matter header.

    The header carries provenance + summary fields an agent can use to
    decide whether to ingest the body (agent type, model, project, turn
    counts). The body renders each message as a role heading followed by
    the message content as-is. Callers may include stable source positions
    in those headings when the reader needs to address an exact message.

    Plain Markdown — no HTML, no shadcn wrappers — so `WebFetch` returns
    clean readable text and an MCP `session_get` call yields tokens an
    LLM can directly attend to.

    """
    title = session.summary or session.local_session_id

    front_matter_lines = [
        "---",
        f"source: {_yaml_escape('clawdi-session')}",
    ]
    if agent_type:
        front_matter_lines.append(f"agent: {_yaml_escape(agent_type)}")
    if session.model:
        front_matter_lines.append(f"model: {_yaml_escape(session.model)}")
    if session.project_path:
        front_matter_lines.append(f"project: {_yaml_escape(session.project_path)}")
    front_matter_lines.append(f"started_at: {_yaml_escape(session.started_at.isoformat())}")
    if session.ended_at:
        front_matter_lines.append(f"ended_at: {_yaml_escape(session.ended_at.isoformat())}")
    front_matter_lines.append(f"messages: {session.message_count}")
    if session.duration_seconds is not None:
        front_matter_lines.append(f"duration_seconds: {session.duration_seconds}")
    # External refs in the front-matter so an agent ingesting the
    # body has the same context signal a human visitor sees (what
    # repos/PRs this session touched).
    if session.related_refs:
        if session.related_refs.get("prs"):
            front_matter_lines.append(f"pull_requests: {_yaml_escape(session.related_refs['prs'])}")
        if session.related_refs.get("repos"):
            front_matter_lines.append(f"repos: {_yaml_escape(session.related_refs['repos'])}")
    front_matter_lines.append("---")

    body_lines: list[str] = ["", f"# {title}", ""]

    # Content stays raw: adapters already normalized it and many messages
    # contain Markdown fences that must not be nested inside another fence.
    return "\n".join(
        front_matter_lines
        + body_lines
        + _message_body_lines(messages, source_positions=source_positions)
    )
