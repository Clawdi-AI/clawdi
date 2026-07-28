---
name: clawdi
description: "Find and read the user's past agent sessions across Claude Code, Codex, OpenClaw, and Hermes; use connected-service tools such as Gmail, GitHub, Notion, Drive, and Calendar; and read Clawdi share URLs (https://cloud.clawdi.ai/s/...) the user pastes."
---

# Clawdi Cloud

Use Clawdi Cloud tools through the `clawdi` MCP server.

## Sessions

- Use `session_search` to find past agent conversations by keyword and obtain session UUIDs.
- Use `session_read` to read a session by UUID or Clawdi share URL.

Call `session_read` when the user provides a Clawdi share URL. When the user refers to a
past conversation without a UUID, call `session_search` first and then read the matching
session. Do not use a generic web fetcher for Clawdi share URLs.

## Connectors

Connected-service tools are registered dynamically from the user's Clawdi Cloud account.
They can include Gmail, GitHub, Notion, Drive, Calendar, and other services.

- Treat the tools as already authenticated for this runtime.
- If a call reports that no account is connected, ask the user to connect that service in
  the Clawdi Cloud dashboard.
- Download files returned as signed URLs before processing them.
- Confirm with the user before side-effecting actions such as sending mail or creating an
  issue.
