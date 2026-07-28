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

Use the Composio Tool Router meta-tools returned by `tools/list` on the `clawdi` MCP server.
Treat their live names and schemas as authoritative; never assume a fixed meta-tool set.

1. Start each external-app workflow with `COMPOSIO_SEARCH_TOOLS`. Follow its exposed
   `queries` and `session` schema, reuse the returned session ID throughout that workflow,
   and use only the exact toolkit and tool slugs it returns. If a required schema is absent
   or incomplete, call `COMPOSIO_GET_TOOL_SCHEMAS`; never invent fields or inputs.
2. Before a side effect, require a complete target identity and all schema-required inputs.
   Explicit intent authorizes the exact requested action and target, but never authorizes
   guessing a missing recipient, account, resource, or other target. Ask only for what is
   missing, and do not request redundant confirmation once the exact action is authorized.
3. When search reports no active connection, call `COMPOSIO_MANAGE_CONNECTIONS` with its
   exposed schema and interpret only the fields it returns. For an initiated connection,
   present the returned `redirect_url` as a clickable authentication link with a concise
   explanation that authorization is pending. The link URL must be exactly that value; never
   construct a substitute or ask for OAuth credentials, API keys, or tokens. If initiation
   returns no `redirect_url`, report that terminal failure instead of suggesting an
   out-of-band fallback.
4. Use a wait or status operation only when `tools/list` exposes one. Follow its actual schema
   and status values without inventing polling arguments. Continue only when it reports an
   active connection; keep waiting only for a non-terminal status its schema defines, and
   report any terminal failure. If none is exposed, stop until the user reports completing
   authorization, then re-run search to verify the active connection before continuing.
5. Execute exact returned slugs through `COMPOSIO_MULTI_EXECUTE_TOOL` with schema-compliant
   arguments. Batch only independent calls. Keep ordinary results inline; set
   `sync_response_to_workbench` or use `COMPOSIO_REMOTE_WORKBENCH` /
   `COMPOSIO_REMOTE_BASH_TOOL` only for large, bulk, or remote-file results.
6. Preserve dependencies and returned semantics. Follow signed-file metadata, pagination
   fields, and termination signals exactly as exposed. Select an account only when the schema
   supports it, and use additional or future meta-tools only according to their live schemas.
