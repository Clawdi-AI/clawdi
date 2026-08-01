---
name: clawdi
description: "Use the user's account-wide long-term memory and past agent sessions; inspect the current Hosted Project and safe Vault metadata; use connected services such as Gmail, GitHub, Notion, Drive, and Calendar; and read Clawdi share URLs."
---

# Clawdi Cloud

Use Clawdi Cloud tools through the `clawdi` MCP server. Treat the live tool schemas as authoritative.

## Memory

Memory is shared across the user's Hosted agents, not isolated to the current agent.

- `memory_search` — Search durable memory by natural-language query.
- `memory_add` — Save a durable fact, preference, pattern, decision, or project context.
- `memory_extract` — Prepare memories from the current conversation. Follow its returned
  review-and-confirm instructions and wait for user approval before calling `memory_add`.

Search before answering questions about the user's preferences, projects, prior decisions,
recurring workflows, or earlier bugs. Save useful non-obvious outcomes and explicit
"remember this" requests as standalone statements with enough context for another agent.

Never store plaintext tokens, API keys, bearer credentials, or private keys in memory. Store
secrets in Vault and remember only an exact `clawdi://` reference when useful.

## Sessions

- Use `session_search` to find past agent conversations by keyword and obtain session UUIDs.
- Use `session_read` to read a session by UUID or Clawdi share URL.

Call `session_read` when the user provides a Clawdi share URL. When the user refers to a
past conversation without a UUID, call `session_search` first and then read the matching
session. Do not use a generic web fetcher for Clawdi share URLs.

## Projects

- `project_current` — Read the runtime-bound Project.
- `project_list` — List Projects visible to the caller.
- `project_get` — Read one visible Project by UUID.

A Hosted runtime is restricted to its bound Project. Treat not-found as an access boundary
as well as a possible unknown UUID; do not try to bypass it through another tool.

## Vault Metadata

- `vault_list` — List attached Vaults and key counts for visible Projects.
- `vault_get` — List key names, provenance, and exact references for an attached Vault.

These tools never return plaintext secret values. Preserve exact references when passing
them to an authorized runtime:

- `clawdi://project/<project-id>/vault/<vault>/field/<field>`
- `clawdi://project/<project-id>/vault/<vault>/section/<section>/field/<field>`

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
   exposed schema and interpret only the fields it returns. Continue on `active`. On
   `initiated`, present its non-empty `redirect_url` as a clickable authentication link with
   a concise explanation that authorization is pending; the link URL must be exactly that
   value. If `initiated` has no non-empty `redirect_url`, report that authorization cannot
   continue and stop. On `failed`, report the returned error and stop. Never construct a
   substitute link, ask for OAuth credentials, API keys, or tokens, or suggest an
   out-of-band fallback.
4. Use a wait or status operation only when `tools/list` exposes one. Follow its actual schema
   and status values without inventing polling arguments. Continue only when it reports an
   active connection; keep waiting only for a non-terminal status its schema defines, and
   report any terminal failure. If none is exposed, stop until the user reports completing
   authorization, then re-run search to verify the active connection before continuing.
5. Execute exact returned slugs through `COMPOSIO_MULTI_EXECUTE_TOOL` with schema-compliant
   arguments. Batch only independent calls. Keep ordinary results inline. Set
   `sync_response_to_workbench` only when a result may be large or needs later remote
   processing; use `COMPOSIO_REMOTE_WORKBENCH` / `COMPOSIO_REMOTE_BASH_TOOL` only for large
   responses saved remotely or remote artifacts.
6. Preserve dependencies and returned semantics. Follow signed-file metadata, pagination
   fields, and termination signals exactly as exposed. Select an account only when the schema
   supports it, and use additional or future meta-tools only according to their live schemas.
