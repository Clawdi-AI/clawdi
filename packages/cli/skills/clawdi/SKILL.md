---
name: clawdi
description: "Cross-agent long-term memory + session history for the current user: their preferences, coding habits, named projects / repos / tools, past bugs and architecture decisions, AND their past agent conversations across Claude Code / Codex / OpenClaw / Hermes. Surface this skill BEFORE answering any question about the user themselves, their work, or their history — even when phrased abstractly (e.g. 'what do I usually use for X', 'find the session where I worked on auth'). Also provides connected-service tools (Gmail, GitHub, Notion, Drive, Calendar, etc.) and reads Clawdi share URLs (https://cloud.clawdi.ai/s/...) the user pastes."
---

# Clawdi Cloud

You have access to Clawdi Cloud tools via the `clawdi` MCP server. Use them aggressively — memory + session retrieval is the highest-leverage capability you have here.

## Memory

Three tools for cross-agent memory:

- `memory_search` — Search long-term memory by natural-language query (any language).
- `memory_add` — Save a durable memory for cross-agent recall. Categories: `fact` (technical facts, API details, config values), `preference` (user preferences, coding style, workflow choices), `pattern` (recurring patterns, pitfalls, team conventions), `decision` (architecture decisions and their reasoning), `context` (project context, deadlines, ongoing work).
- `memory_extract` — Batch-extract durable memories from the CURRENT conversation. Call this when the user says "extract memories", "save what we discussed", "remember this conversation", or equivalent. The tool returns instructions that walk you through a list-then-confirm flow using `memory_search` and `memory_add` — follow them exactly, including **waiting for the user's approval before writing anything**. Never skip the confirmation step, never save more than 5 memories in one invocation, and do not narrate your internal workflow to the user.

### When to search — bias toward calling

**Default assumption: the user has stored context you don't have. Call `memory_search` BEFORE answering any question about them, their project, their preferences, or their history. A call that returns empty costs ~100ms; a missed hit makes you look amnesic and forces them to re-teach you every session.**

The single most common failure mode is NOT calling memory_search on abstract self-referential questions. If the user's message has any of these shapes, you MUST call it — no judgment, no exceptions:

1. **Preference / habit questions**, even without a specific entity named.
   Examples: "what do I usually use for X", "how do I normally do Y", "what's my preferred tool for Z", "what's my coding style". Pass a short paraphrase as the query.
2. **Callbacks to prior context.** "as I mentioned", "like last time", "you know the one", "we discussed before", "what was that X we set up".
3. **Named entities specific to this user.** Their project / repo / service / team / tool name. A person by name.
4. **Past bugs, decisions, investigations, design choices.**
5. **Start of a new session where they reference anything about themselves or their work.**

Do NOT search for:
- Purely textbook programming questions with no user-specific signal ("how does `useEffect` work", "what is the time complexity of quicksort").
- Questions the current code already answers directly.

**When unsure, search.** Empty results cost you nothing. Missing the user's context costs you their trust.

### When to save

- After fixing a non-obvious bug (save root cause + fix)
- After making an architecture decision (save reasoning)
- After discovering a useful pattern or workaround
- When the user explicitly says "remember this" / "save this"
- After learning a user preference you'd otherwise have to re-ask ("I prefer rg", "I always use pnpm")

Write memories as standalone sentences with full context — include names, not pronouns. A future session will read this without knowing today's conversation.

Do NOT save trivial facts that are obvious from the code itself, or generic programming knowledge.

## Sessions

Two tools for reading and finding past agent conversations stored in Clawdi Cloud:

- `session_read` — Fetch a single session by reference and return its full conversation as Markdown. Accepts a Clawdi share URL (`https://cloud.clawdi.ai/s/{uuid}`) OR a session UUID for one of the user's own sessions. Handles owned and shared sessions transparently — you don't need to know which one.
- `session_search` — Find sessions in the user's history by keyword. Trigram-ranked substring search with typo tolerance. Returns matching sessions with summary, project, timestamps, and **session UUIDs you can pass back to `session_read`**.

### When to read — call `session_read` whenever the user references a specific session

MUST call when the user's message includes:
- A Clawdi share URL (e.g. `https://cloud.clawdi.ai/s/11111111-2222-3333-4444-555555555555`) — pass the full URL
- A direct reference like "open the session where I did X" or "the one from yesterday about auth" — first call `session_search` to find the UUID, then `session_read` to load it

Do NOT call WebFetch on `cloud.clawdi.ai/s/...` URLs — `session_read` is the right tool and avoids the WebFetch permission prompt.

### When to search — bias toward calling, similar to `memory_search`

MUST call `session_search` when:
- The user asks about prior work: "what did I do about the focus bug", "find the session where I migrated auth", "show me last week's debugging session"
- They reference a past investigation by topic but don't name a specific session
- They want to continue / reuse approach from a prior conversation

### Difference from `memory_search`

- `memory_search` finds **stored facts / preferences / decisions** the user (or a previous agent run) explicitly extracted. Short rows; high signal.
- `session_search` finds **full conversations** in the corpus. Long rows; useful when the user wants the original context, not just the takeaway.

When the user's request is **conceptual** ("how do I usually do X"), prefer `memory_search`. When they want to **revisit a specific past conversation** ("the session where..."), use `session_search`. When unsure, try `memory_search` first (cheaper, faster), fall back to `session_search` if empty.

## Connectors

Connected service tools (Gmail, GitHub, Notion, etc.) are dynamically registered from the user's Clawdi Cloud dashboard. They appear as individual tools like `gmail_fetch_emails`, `github_list_issues`, etc.

- These tools are already authenticated — no OAuth needed at runtime
- If a tool call fails with "No connected account", tell the user to connect the service in the Clawdi Cloud dashboard
- File downloads from connectors return signed URLs — download them with `curl` or `fetch` before processing
- Confirm with the user before side-effecting operations (sending email, creating issues, etc.)
