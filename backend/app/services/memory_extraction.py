"""LLM-driven extraction of memory entries from a session's messages.

The prompt does the heavy lifting — we lean on concrete ✅/❌ examples per
category (borrowed from `/Users/paco/workspace/claude-mem`'s playbook) so
the model self-filters trivial signal at generation time. No post-LLM
dedup or similarity gating; if the model returns junk the bar in the
prompt is too low, fix the prompt rather than add a filter pass.

OpenAI's structured-output `response_format=json_schema` enforces the
`ExtractionResult` shape so we don't defensively parse — bad output
raises and the caller (`POST /api/sessions/{id}/extract`) bubbles it as
5xx.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Literal

from openai import AsyncOpenAI
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)


# Tail-truncate to this many messages per session. Most useful signal
# (decisions, conclusions, settled preferences) lands at the end of a
# conversation — head context is usually scaffolding. 80 keeps a typical
# session under ~30k tokens for the LLM call.
MAX_MESSAGES = 80

Category = Literal["fact", "preference", "pattern", "decision", "context"]


class ExtractedMemory(BaseModel):
    content: str = Field(..., min_length=1, max_length=2000)
    category: Category
    tags: list[str] = Field(default_factory=list, max_length=10)


class ExtractionResult(BaseModel):
    # Loose ceiling, not meant to bind in normal use — the prompt asks
    # for selectivity ("most sessions yield 0-5"). 20 only catches a
    # model that's gone off the rails (one memory per message, etc.).
    memories: list[ExtractedMemory] = Field(default_factory=list, max_length=20)


# json_schema for OpenAI structured output. Mirrored from `ExtractionResult`
# but written by hand because Pydantic-generated schemas use `$ref`/`$defs`
# which OpenAI's strict mode rejects (must be fully inlined).
_RESPONSE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["memories"],
    "properties": {
        "memories": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["content", "category", "tags"],
                "properties": {
                    "content": {"type": "string"},
                    "category": {
                        "type": "string",
                        "enum": ["fact", "preference", "pattern", "decision", "context"],
                    },
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
            },
        }
    },
}


_SYSTEM_PROMPT = """You extract durable memories from a developer's past Claude Code conversation. The memories you produce will be available in *future* sessions across any agent the developer uses, so optimize for things that will actually help future-them — not for summarizing what just happened.

# What to record

Focus on durable signal that survives this session:

- What the system NOW DOES differently after this conversation (new behavior, new capabilities, configurations that changed)
- Decisions the developer settled on, with rationale, that are expected to stick
- Repeated preferences that govern how they work (tooling, code style, process)
- Conventions and patterns established or confirmed during this conversation
- Concrete debugging findings — things they learned about how a system actually behaves under failure or edge cases (queue stalls, race conditions, surprising defaults, missing env wiring). These count as durable signal even when no code changed.

Use verbs like: implemented, fixed, deployed, configured, migrated, optimized, added, refactored, discovered, confirmed, traced, established, ruled out, settled on.

# Categories

Each memory belongs to exactly one of these. ✅ shows the bar; ❌ shows what NOT to record:

- **fact** — A stable piece of truth about the developer's stack, environment, or world. Includes "the system now does X" findings.
  ✅ "Production deploys live at app.example.com; staging at staging.example.com"
  ✅ "Hermes adapter under Node uses better-sqlite3 because node:sqlite isn't available pre-22.5"
  ❌ "User asked about deployment URLs"

- **preference** — A repeated, durable choice the developer makes when given options.
  ✅ "Prefers `bun` over `npm` for monorepo dependency management"
  ✅ "Wants commit messages to focus on the WHY, never on the WHAT"
  ❌ "Used npm in this session"

- **pattern** — A reusable code, architectural, or workflow convention they follow.
  ✅ "Error responses follow `{error: {code, message, hint}}` shape across all routes"
  ✅ "Backend tests hit a real Postgres (not mocks) because mocks diverged from prod last time"
  ❌ "Wrote an API endpoint"

- **decision** — A choice made with explicit rationale that's expected to stick.
  ✅ "Adopted Drizzle over Prisma for type inference quality on partial selects"
  ✅ "Stopped using --no-verify in commits after a hook regression slipped to prod"
  ❌ "Added a database query"

- **context** — High-level fact about what the developer is working on or who they are.
  ✅ "Working on internal billing portal — payments via Stripe Connect, multi-tenant by org_id"
  ✅ "Senior engineer; treats explanations as peer-to-peer, not tutorial"
  ❌ "Opened billing.ts"

# What NOT to record

- The model's own actions ("analyzed the codebase", "wrote a function then revised it"). Record what the developer did or learned, not what you (the assistant) did.
- Questions the user asked that didn't reach a settled answer in this conversation
- Topics that came up but were left in mid-exploration
- Trivial single-session events with no future relevance ("ran `npm install`", "fixed a typo", "renamed a local variable")
- Anything you'd have to invent or guess at — only record things actually established by the conversation

# How to write a memory

- Single self-contained sentence written from the developer's perspective ("User prefers X" / "X happens because Y" / "The auth middleware now does Z")
- Specific over abstract — "user cares about types" is useless; "user reviews each function for type-narrowing opportunities before merging" is useful
- Self-contained — no "as discussed earlier" or "the X we just changed". Future-them won't have this conversation in front of them.

# Worked example

Input excerpt:
[user] switch this from prisma to drizzle?
[assistant] sure. why drizzle over prisma?
[user] better partial-select inference, and the team's more familiar with it
[assistant] migrating now...

Output:
{"memories": [{
  "content": "Adopted Drizzle over Prisma for type inference quality on partial selects and team familiarity",
  "category": "decision",
  "tags": ["orm", "database"]
}]}

# Selectivity

Most sessions yield 0-5 durable memories; many yield 0. An empty `memories` array is often the right answer — the conversation might be mostly scaffolding, exploration without conclusions, or one-off trivia. Returning many low-quality memories is strictly worse than returning none.

Return JSON only. Do not explain why the array is empty. Do not narrate your reasoning. Just the JSON object.
"""


def _format_messages_for_prompt(
    messages: list[dict[str, Any]],
    project_path: str | None,
    total: int,
) -> str:
    lines: list[str] = []
    header = f"project: {project_path or 'unknown'}\nmessages: {len(messages)} of {total} (tail-truncated, oldest dropped)"
    lines.append(header)
    lines.append("")
    for m in messages:
        role = str(m.get("role", "?"))
        content = m.get("content", "")
        # Some messages may have non-string content (tool_use blocks etc).
        # Stringify defensively — the LLM is fine with JSON snippets in-line.
        if not isinstance(content, str):
            try:
                content = json.dumps(content, ensure_ascii=False)
            except (TypeError, ValueError):
                content = str(content)
        lines.append(f"[{role}] {content}")
    return "\n".join(lines)


async def extract_memories_from_session(
    messages: list[dict[str, Any]],
    *,
    project_path: str | None,
    client: AsyncOpenAI,
    model: str,
) -> list[ExtractedMemory]:
    """Run extraction over a session's messages.

    Tail-truncates to `MAX_MESSAGES` and asks the LLM for a JSON-schema
    constrained `ExtractionResult`. Returns the parsed list, possibly
    empty. Any LLM/network/parsing error propagates to the caller.
    """
    if not messages:
        return []

    total = len(messages)
    truncated = messages[-MAX_MESSAGES:] if total > MAX_MESSAGES else messages

    user_content = _format_messages_for_prompt(truncated, project_path, total)

    response = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "ExtractionResult",
                "strict": True,
                "schema": _RESPONSE_SCHEMA,
            },
        },
        temperature=0.2,
    )

    raw = response.choices[0].message.content or "{}"
    parsed = ExtractionResult.model_validate_json(raw)
    return parsed.memories
