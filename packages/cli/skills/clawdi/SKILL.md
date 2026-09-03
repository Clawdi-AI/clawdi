---
name: clawdi
description: "Use Clawdi Cloud for missing user memory, past sessions, Project or Vault context, Clawdi share URLs, and connected-service fallback such as Gmail, GitHub, Notion, Drive, or Calendar. Prefer an authenticated official service CLI; otherwise choose a trusted direct MCP, safely installable official CLI, official API or SDK, or the Clawdi connector as fallback. Do not invoke solely because a project, person, repo, or tool is named."
---

# Clawdi Cloud

Use Clawdi Cloud tools through the `clawdi` MCP server when they provide context or
capabilities unavailable more directly.

## Context Routing

Use the current conversation and user-provided artifacts first. For project facts, inspect
the workspace, repository documentation, and local history. Use `memory_search` only for
missing user-specific preferences, decisions, or prior context. Use `session_list`,
`session_search`, and `session_read` only when the user asks for past conversations or
transcript-level detail is necessary. Do not call Memory and Session speculatively or in parallel.
A named entity alone does not justify a Cloud lookup, and an empty Memory result does not justify
a Session search.

## Memory

Memory is durable user-specific context shared across agents.

- `memory_search` — Search durable memory by natural-language query.
- `memory_list` — Review stored memories and their stable IDs.
- `memory_add` — Save a durable fact, preference, pattern, decision, or project context.
- `memory_update` — Replace one exact memory's content without changing its metadata.
- `memory_delete` — Delete one exact memory by ID.
- `memory_extract` — Prepare memories from the current conversation. Follow its returned
  review-and-confirm instructions and wait for user approval before calling `memory_add`.

Use `memory_add` for explicit "remember this" requests or durable user-specific preferences
and decisions not discoverable from the repository. Ask when persistence is unclear. Do not
save routine task completion, code facts, speculation, or plaintext secrets; use Vault and
remember only the exact `clawdi://` reference. List before updating or deleting unless the user
already supplied the exact memory ID; never infer which stored item to mutate.

## Sessions

- Use `session_list` to browse recent sessions or filter by time, Agent, or Project.
- Use `session_search` to find past agent conversations by keyword and obtain session UUIDs.
- Use `session_read` to read a session by UUID or Clawdi share URL.

Call `session_read` when the user provides a Clawdi share URL or session UUID and wants its
contents. For a request to open a specific unnamed past conversation, use `session_search`
to find the UUID and then read the selected match.

Do NOT call WebFetch on `cloud.clawdi.ai/s/...` URLs — `session_read` is the right tool and avoids the WebFetch permission prompt.

## Projects

Three read-only tools expose the caller's visible Project context:

- `project_current` — Read the current or runtime-bound Project.
- `project_list` — List visible Projects.
- `project_get` — Read one visible Project by UUID.

Hosted runtimes see only their bound Project. Treat a not-found response as an
access boundary as well as a possible unknown UUID; do not try to bypass it
through another tool.

## Vault

Vault read tools expose metadata and exact references:

- `vault_list` — List Vault attachments and key counts for visible Projects.
- `vault_get` — List key names, provenance, and exact `clawdi://` references for one attached Vault.

Use `vault_resolve` only when the current task requires one referenced plaintext value. Pass
the exact Project-scoped reference. Treat the result as sensitive: never echo it, save it to
Memory, or include it in logs.

The metadata tools never resolve or return plaintext. Never imply that a returned key name
is a secret value. Preserve their exact references for `vault_resolve` or when passing them
to an authorized runtime:

- `clawdi://project/<project-id>/vault/<vault>/field/<field>`
- `clawdi://project/<project-id>/vault/<vault>/section/<section>/field/<field>`

Use the live schemas from the `clawdi` MCP server as authoritative; the local
stdio command only transports the protocol.

Vault write tools are available for explicit user requests:

- `vault_create` — Create a Vault attached to one exact owner Project.
- `vault_item_upsert` — Create or replace exact fields in an attached Vault.
- `vault_item_delete` — Delete exact fields from a single-Project Vault.

Follow the live schema and supply every required Project, Vault, section, and field identity;
never infer an overwrite or deletion. Treat field values as sensitive inputs and never echo
them, save them to Memory, or include them in logs. Environment-bound callers may write only
their bound Project, and field deletion is rejected when a Vault is attached to multiple
Projects. Whole-Vault deletion, attach/detach, bulk import, and credential profiles remain
foreground operator workflows; never bypass that boundary through raw HTTP or daemon RPC.

## Wallet Funding

Use `clawdi wallet status --json` to inspect the authenticated Wallet balance, verified
binding, and x402 readiness. Binding and Base USDC top-up are available only through the
browser wallet surface; Clawdi does not store the payment private key. Ask the user to fund
there. Command-line spending requires a future owner-only or hardware signer authority and is not
available.

## Connector Routing

Respect an explicit user choice. Otherwise inspect installed service CLIs, direct MCP tools
already exposed by the runtime, and authorized API or SDK credentials. If an installed and
authenticated official CLI can perform the task, use it directly. Check availability and
authentication non-destructively and prefer structured output.

Otherwise choose the lowest-setup reliable option for the task. Consult the service's official
documentation when installation, authentication, commands, or schemas are uncertain or likely
to have changed:

- Use a trusted direct MCP already configured and exposed by the runtime. Do not automatically
  download, install, or start an unfamiliar MCP server.
- Safely install the official CLI when the runtime permits it, the source is verified as
  official, and no elevation or persistent host change is required.
- Use the official API or SDK with a verified contract and credentials already authorized for
  the runtime, including through an exact Vault reference.
- Use the Clawdi connector when no direct option can perform the operation.

Before a side effect, establish the exact service account and organization, Project, or tenant.
Use `connector_account_list` when the connector is a candidate and its identity is not already clear.
Fallback must not silently change that identity. Do not scan for credentials, start an interactive
login, invent API details, or expose secrets. Choose the path before a side effect and advance
only after a definite preflight failure. If a mutation's result is ambiguous, inspect it through
the same path; never repeat it through another path.

## Connector Workflow

When the Clawdi connector path is selected, use the Composio Tool Router meta-tools returned
by `tools/list` on the `clawdi` MCP server. Treat their live names and schemas as
authoritative; never assume a fixed meta-tool set.

1. Start the connector workflow with `COMPOSIO_SEARCH_TOOLS`. Follow its exposed
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
   responses saved remotely or remote artifacts. Preserve dependencies and returned semantics;
   follow signed-file metadata, pagination fields, and termination signals exactly as exposed.
   Select an account only when the schema supports it, and use additional or future meta-tools
   only according to their live schemas.

## AI Provider Management

Provider configuration is also a human operator workflow, not an Agent MCP capability. Do
not execute provider CLI commands or handle provider credentials on the user's behalf. When
asked, provide an exact `clawdi ai-provider` command for the operator to run and explain its
effect; suggest `validate` or a non-live `test` before any explicitly requested live probe.

- Treat the local Provider Catalog as multi-record metadata. Do not activate it into local agent config; Core Hosted activation is supplied by the runtime manifest/controller, whose configured runtime binds exactly one provider and whose unmanaged runtime binds none.
- Keep Codex OAuth ownership singular across Hosted runtimes. Hermes/OpenClaw native refresh, revoke, and ownership state belongs to Hosted convergence, not a local CLI materialization command.
- Default export/import is metadata-only; `--include-secrets` requires passphrase-encrypted secret export.
- BYOK model requests go directly from the agent runtime to the configured provider. Clawdi stores metadata and secret references but is not a model proxy.
