---
name: clawdi
description: "Cross-agent long-term memory for the current user: their preferences, coding habits, named projects / repos / tools, past bugs and architecture decisions, and anything they reference with 'my', 'I usually', 'like last time', 'the one we set up', etc. Surface this skill BEFORE answering any question about the user themselves, their work, or their history — even when phrased abstractly (e.g. 'what do I usually use for X'). Also provides connected-service tools (Gmail, GitHub, Notion, Drive, Calendar, etc.)."
---

# Clawdi Cloud

You have access to Clawdi Cloud tools via the `clawdi` MCP server. Use them aggressively — memory retrieval is the highest-leverage tool you have here.

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

## Connectors

Connected service tools (Gmail, GitHub, Notion, etc.) are dynamically registered from the user's Clawdi Cloud dashboard. They appear as individual tools like `gmail_fetch_emails`, `github_list_issues`, etc.

- These tools are already authenticated — no OAuth needed at runtime
- If a tool call fails with "No connected account", tell the user to connect the service in the Clawdi Cloud dashboard
- File downloads from connectors return signed URLs — download them with `curl` or `fetch` before processing
- Confirm with the user before side-effecting operations (sending email, creating issues, etc.)
