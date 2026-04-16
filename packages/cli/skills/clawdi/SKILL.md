---
name: clawdi
description: "Clawdi Cloud integration — cross-agent memory and connected service tools. Use memory tools proactively and connector tools when the user needs external services."
---

# Clawdi Cloud

You have access to Clawdi Cloud tools via the `clawdi` MCP server. Use them proactively.

## Memory

Two tools for cross-agent memory:

- `memory_search` — Search memories by query. Use this **proactively** at the start of a task if prior context might help. For example, if the user asks about a bug, search for related past fixes.
- `memory_add` — Save a memory for cross-agent recall. Use this **after** solving a non-trivial problem: what was fixed, root cause, key decisions, or technical details learned. Choose the right category:
  - `fact` — Technical facts, API details, config values
  - `preference` — User preferences, coding style, workflow choices
  - `pattern` — Recurring patterns, common pitfalls, team conventions
  - `decision` — Architecture decisions and their reasoning
  - `context` — Project context, deadlines, ongoing work

### When to search

- User mentions a past issue or "we did this before"
- User asks about a recurring topic (database, deployment, auth)
- Starting work on a subsystem where prior decisions may exist

### When to save

- After fixing a non-obvious bug (save root cause + fix)
- After making an architecture decision (save reasoning)
- After discovering a useful pattern or workaround
- When the user explicitly says "remember this"

Do NOT save trivial facts that are obvious from the code itself.

## Connectors

Connected service tools (Gmail, GitHub, Notion, etc.) are dynamically registered from the user's Clawdi Cloud dashboard. They appear as individual tools like `gmail_fetch_emails`, `github_list_issues`, etc.

- These tools are already authenticated — no OAuth needed at runtime
- If a tool call fails with "No connected account", tell the user to connect the service in the Clawdi Cloud dashboard
- File downloads from connectors return signed URLs — download them with `curl` or `fetch` before processing
- Confirm with the user before side-effecting operations (sending email, creating issues, etc.)
