"""Markdown + JSON serializers for shared sessions.

Same output regardless of whether the caller is the OWNER fetching
their own session via `GET /v1/sessions/{id}/export.md` or a PUBLIC
visitor hitting `GET /v1/public/sessions/{token}/export.md`.
Sharing the serializer keeps the agent-facing `.md` body byte-for-byte
identical across both paths, which is what `session_read` MCP tool
relies on to give the same agent context regardless of access mode.

The Markdown body opens with a YAML front-matter block. That's the
signal to an LLM (or an MCP wrapper) that this isn't a random web
page — it's a structured session log it can ingest as conversation
context.
"""

from __future__ import annotations

import json
from typing import Any

from app.core.config import settings
from app.models.session import Session
from app.models.user import User


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


def _build_share_url(session: Session) -> str:
    return f"{settings.web_origin}/s/{session.id}"


def public_session_base_fields(
    session: Session,
    agent_type: str | None,
    owner: User | None = None,
) -> dict[str, Any]:
    """Session-derived fields that are SAFE for a public/share viewer.

    Single source of truth for "what does a non-owner see about a
    session". `_public_session_payload` (the public detail route) and
    `session_to_json(include_owner_metadata=False)` both consume this
    so a new Session column added without updating BOTH callsites
    can't silently leak — they share one allow-list.

    Excluded (owner-internal): `user_id`, `environment_id`, `file_key`,
    `machine_name`, `local_session_id`, `content_hash`,
    `content_uploaded_at`, `summary_embedding`, `updated_at`,
    `created_at`. Each callsite layers route-specific decorations on
    top (the public-detail payload wraps a `share: {...}` object; the
    JSON export adds `messages` and a flat `share_url`).

    `owner` (optional) — when supplied, owner display name + avatar URL
    are included so the share page can render the same identity-bar UX
    the dashboard does. We deliberately expose only `name` + `avatar_url`
    (not email / clerk_id) — the public identity is what's already on
    the user's profile, never the contact channel.
    """
    return {
        "id": str(session.id),
        "summary": session.summary,
        "project_path": session.project_path,
        "agent_type": agent_type,
        "model": session.model,
        "models_used": session.models_used,
        "started_at": session.started_at.isoformat(),
        "ended_at": session.ended_at.isoformat() if session.ended_at else None,
        "last_activity_at": session.last_activity_at.isoformat()
        if session.last_activity_at
        else None,
        "duration_seconds": session.duration_seconds,
        "message_count": session.message_count,
        "input_tokens": session.input_tokens,
        "output_tokens": session.output_tokens,
        "cache_read_tokens": session.cache_read_tokens,
        "tags": session.tags,
        "status": session.status,
        # Extracted external refs (PRs / repos / branches) — visible to
        # share viewers (the dashboard sidebar renders these for owners;
        # sharing the same signal is consistent with the share page's
        # intent).
        "related_refs": session.related_refs,
        # Public identity of the session owner — used by the share page
        # to render the user avatar / name in the message stream.
        "owner_name": owner.name if owner else None,
        "owner_avatar_url": owner.avatar_url if owner else None,
    }


def session_to_markdown(
    session: Session,
    messages: list[dict[str, Any]],
    *,
    agent_type: str | None = None,
    public: bool = False,
) -> str:
    """Serialize one session to Markdown with a YAML front-matter header.

    The header carries provenance + summary fields an agent can use to
    decide whether to ingest the body (agent type, model, project, turn
    counts). The body renders each message as `## <Role> · <timestamp>`
    followed by the message content as-is.

    Plain Markdown — no HTML, no shadcn wrappers — so `WebFetch` returns
    clean readable text and an MCP `session_read` call yields tokens an
    LLM can directly attend to.

    `public=True` switches to the share-page variant: source tag flips
    to `clawdi-shared-session`, the `local_session_id` title fallback is
    replaced with a generic "Session {short-id}" (don't leak the
    adapter-supplied identifier), and a `url:` front-matter entry
    pointing at `/s/{session.id}` is added.
    """
    if session.summary:
        title = session.summary
    elif public:
        title = f"Session {str(session.id)[:8]}"
    else:
        title = session.local_session_id

    front_matter_lines = [
        "---",
        f"source: {_yaml_escape('clawdi-shared-session' if public else 'clawdi-session')}",
    ]
    if public:
        front_matter_lines.append(f"url: {_yaml_escape(_build_share_url(session))}")
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

    for m in messages:
        role = m.get("role") or "unknown"
        model = m.get("model")
        ts = m.get("timestamp")

        # Heading: capitalized role, optional model badge, optional timestamp.
        # Format is stable so an LLM consuming the body can parse turn
        # boundaries by looking for `^## `.
        heading_parts: list[str] = [f"## {role.capitalize()}"]
        if role == "assistant" and model:
            heading_parts.append(f"({model})")
        if ts:
            heading_parts.append(f"· {ts}")
        body_lines.append(" ".join(heading_parts))
        body_lines.append("")

        content = m.get("content") or ""
        # Content is raw — adapter has already normalized to a string.
        # NOT wrapped in a fence; many messages are already Markdown
        # (or contain fences themselves), and double-fencing produces
        # the agent-confusing nested-fence rendering issue.
        body_lines.append(content)
        body_lines.append("")

    return "\n".join(front_matter_lines + body_lines)


def session_to_json(
    session: Session,
    messages: list[dict[str, Any]],
    *,
    agent_type: str | None = None,
    machine_name: str | None = None,
    public: bool = False,
    include_owner_metadata: bool = False,
) -> dict[str, Any]:
    """Structured serialization — fed to `.json` export route + the MCP tool.

    By default (`include_owner_metadata=False`) drops fields a public
    visitor must not see — `user_id`, `environment_id`, `file_key`,
    `machine_name`. Owner-side exports flip the flag to pass through
    the full set so the CLI's mirror flow has parity.

    `public=True` adds a `share_url` field pointing at `/s/{session.id}`.
    """
    body = public_session_base_fields(session, agent_type)
    body["messages"] = messages
    if public:
        body["share_url"] = _build_share_url(session)
    if include_owner_metadata:
        # Owner-side fields layered on top of the public base. Keep
        # this branch in `session_to_json` (not in `public_session_base_fields`)
        # so the base function stays a strict allow-list of public-safe
        # keys — owner additions are the explicit exception.
        body["local_session_id"] = session.local_session_id
        body["machine_name"] = machine_name
    return body
