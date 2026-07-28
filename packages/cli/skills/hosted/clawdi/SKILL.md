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

Use the Composio Tool Router meta-tools exposed through the `clawdi` MCP server.

1. Start every external-app task with `COMPOSIO_SEARCH_TOOLS`. Describe each intended app
   action using the tool's exposed input schema, and split cross-app workflows into atomic
   searches when useful.
2. Use the tool schemas returned by search. If a complete schema is missing, call
   `COMPOSIO_GET_TOOL_SCHEMAS`. Never invent tool slugs, field names, or inputs.
3. If search reports no active connection, call `COMPOSIO_MANAGE_CONNECTIONS` exactly as its
   exposed schema requires. Present its returned `redirect_url` as a clickable Markdown
   authentication link. Say that authentication is pending, ask the user to complete it,
   and do not claim it is complete. Never request or expose OAuth credentials, API keys, or
   tokens.
4. After the user reports completing authentication, re-run `COMPOSIO_SEARCH_TOOLS` or use a
   connection-status operation only when the exposed schema provides one. Verify that the
   connection is active, then retry the interrupted workflow.
5. Execute discovered app tools through `COMPOSIO_MULTI_EXECUTE_TOOL` with schema-compliant
   inputs. Batch only independent actions; preserve dependencies between steps.
6. Use `COMPOSIO_REMOTE_BASH_TOOL` or `COMPOSIO_REMOTE_WORKBENCH` only for justified large,
   bulk, or remote-file results. Process ordinary inline results directly.
7. Follow returned file metadata when downloading signed file URLs. Follow only exposed
   pagination fields and termination signals, and select among multiple accounts only when
   the schema exposes account selection; do not invent fields or assume an account.
8. Before an externally visible or destructive action, get user confirmation unless the
   user's exact instruction already authorizes that exact action. Do not ask for redundant
   confirmation.
