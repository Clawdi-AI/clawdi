---
name: clawdi
description: "Use Clawdi Cloud for API keys, tokens, passwords, or safely storing/providing credentials needed by a task; missing user memory, past sessions, Project or Vault context, Clawdi share URLs, and connected-service fallback such as Gmail, GitHub, Notion, Drive, or Calendar. Prefer an authenticated official service CLI; otherwise choose a trusted direct MCP, safely installable official CLI, official API or SDK, or the Clawdi connector as fallback. Do not invoke solely because a project, person, repo, or tool is named."
---

# Clawdi Cloud

Use Clawdi Cloud tools through the `clawdi` MCP server. Treat the live tool schemas as authoritative.

## Hosted Boundary

Third-party tool routing below applies unchanged in Hosted. Do not inspect, run, or suggest
Clawdi host-management commands such as `clawdi setup`, `clawdi wallet`, `clawdi vault`, or
`clawdi ai-provider`.

## Context Routing

Use the current conversation and user-provided artifacts first. For project facts, inspect
the workspace, repository documentation, and local history. Use `memory_search` only for
missing user-specific preferences, decisions, or prior context. Use `session_list`,
`session_search`, and `session_get` only when the user asks for past conversations or
transcript-level detail is necessary. Do not call Memory and Session speculatively or in parallel.
A named entity alone does not justify a Cloud lookup, and an empty Memory result does not justify
a Session search.

## Memory

Memory is shared across the user's Hosted agents, not isolated to the current agent.

- `memory_search` — Search durable memory by natural-language query.
- `memory_list` — Review stored memories and their stable IDs.
- `memory_create` — Save a durable fact, preference, pattern, decision, or project context.
- `memory_update` — Replace one exact memory's content without changing its metadata.
- `memory_delete` — Delete one exact memory by ID.
- `memory_extract` — Prepare memories from the current conversation. Follow its returned
  review-and-confirm instructions and wait for user approval before calling `memory_create`.

Use `memory_create` for explicit "remember this" requests or durable user-specific preferences
and decisions not discoverable from the repository. Ask when persistence is unclear. Do not
save routine task completion, code facts, speculation, or plaintext secrets; use Vault and
remember only the exact `clawdi://` reference. List before updating or deleting unless the user
already supplied the exact memory ID; never infer which stored item to mutate.

## Sessions

- Use `session_list` to browse recent sessions or filter by time, Agent, or Project.
- Use `session_search` to find past agent conversations by keyword and obtain session UUIDs.
- Use `session_get` to read a session by UUID or Clawdi share URL.

Call `session_get` when the user provides a Clawdi share URL or session UUID and wants its
contents. Use `session_search` to locate a requested unnamed conversation. Do not use a
generic web fetcher for Clawdi share URLs.

## Projects

- `project_current_get` — Read the runtime-bound Project.
- `project_list` — List Projects visible to the caller.
- `project_get` — Read one visible Project by UUID.

Strict-v2 Hosted runtimes can read their own Workspace and explicitly linked Projects
that remain readable by the owner. `project_current_get` returns that Workspace; writes,
new Vaults, and credential requests are limited to it. Legacy Agent-bound keys retain
their narrower bound-Project read scope. Treat not-found as an access boundary as well
as a possible unknown UUID; do not bypass it through another tool.

## Vault

Vault stores credentials for authorized tools and services; it is not a universal service
alternative. Reuse ready, authorized mechanisms before requesting missing credentials. An
already-connected, capable Composio integration does not require duplicate credentials in Vault
or account migration. Request credentials only when the chosen task path actually needs them.

- `vault_list` — List attached Vaults and key counts for visible Projects.
- `vault_get` — List key names, provenance, and exact references for an attached Vault.

Honor an explicit Vault/source or known local mapping first. Otherwise use `vault_list` /
`vault_get` metadata to reuse a Vault suited to the task's purpose and access. Create in
your own Workspace only when none is appropriate and the task authorizes creation.
Clarify ambiguous sources; never create duplicates or write to linked Projects to bypass access.

Use `vault_resolve` only for authorized credential use, with exact Project-scoped
reference(s) following its live schema. Never echo values, save them to Memory, or log them.

The metadata tools never return plaintext secret values. Preserve exact references for
`vault_resolve` or when passing them to an authorized runtime:

- `clawdi://project/<project-id>/vault/<vault>/field/<field>`
- `clawdi://project/<project-id>/vault/<vault>/section/<section>/field/<field>`

Vault write tools are available for explicit user requests:

- `vault_create` — Create a Vault attached to your own Workspace.
- `vault_item_upsert` — Create or replace exact fields in an attached Vault.
- `vault_item_delete` — Delete exact fields from a single-Project Vault.

Follow the live schema and supply every required Project, Vault, section, and field identity;
never infer an overwrite or deletion. Treat field values as sensitive inputs and never echo
them, save them to Memory, or include them in logs. Hosted writes are restricted to their
own Workspace (the runtime-bound Project). Field deletion is rejected when a Vault is
attached to multiple Projects. Whole-Vault deletion, attach/detach, and credential profiles remain
unavailable through Agent MCP; do not bypass that boundary through raw HTTP.

### Request missing credentials

Use `vault_request_create` with exact `project_id`, `vault_id`, canonical `slug`, optional
`section`, and a batch of environment field names in `fields`. A Vault is a key bundle:
request related keys together under one link. Supplied or already-pending fields are rejected.
Show the returned `url` unchanged to the user; do not ask them to paste secrets into chat.
Opening the link does not consume it. Saving all requested fields consumes it once.

Check `vault_request_status` with its `request_id` after the user finishes. `pending` is not
a secret value; `supplied` means the exact references are ready. On `expired` or `conflict`,
inspect the Vault and request only still-missing fields; never replace an existing value to
retry. If creation times out, use `vault_get` to find recent request IDs before retrying.
If submission times out, inspect status before repeating a mutation.

### Use runtime-supplied credentials

Clawdi runtime synchronizes readable Vaults from your own Workspace and explicitly linked,
still-readable Projects into `.clawdi/vaults/` beneath your native workspace. Inspect only
`.clawdi/vaults/index.json` for Vault IDs, section names, exact references, field names and files.
Each section has a separate JSON file; equal field names in different sections stay separate.
Select by the user's intended Vault and section, never by an ambiguous field name alone.

Load the selected JSON file inside the authorized process or SDK without printing values.
For example, Python can use `json.load(open(path))` and pass the selected key directly to
its SDK. Do not read plaintext into model/tool-result context merely to save or copy it.
Do not invoke or install the Clawdi CLI from the tenant. Runtime owns these generated files:
do not edit, chmod, move, commit, or create your own files in `.clawdi/vaults/`. Preserve
unrelated configuration in its `.clawdi` parent. Connected installations use this same
layout on macOS/Linux only after an explicit workspace binding; do not assume an arbitrary
repo is bound. Files remain readable by authorized programs running as the same user.

After a credential request is supplied, inspect index metadata for the requested fields.
Pending requests are metadata only, never empty pseudo-secrets. If delivery is delayed,
report that state without claiming the credentials are saved. Runtime refreshes files;
already-running processes must explicitly reload them. Offline delivery retains last good
files; confirmed access removal removes generated files. Authorized code can read these
files, so do not claim that subsequent plaintext exposure is impossible.

## Connector Routing

Respect an explicit user choice. Otherwise inspect installed service CLIs, direct MCP tools
already exposed by the runtime, and authorized API or SDK credentials. If an installed and
authenticated official CLI can perform the task, use it directly. Check availability and
authentication non-destructively and prefer structured output.

Otherwise reuse a ready, authorized direct integration when it can perform the task. If none
is usable and Composio is already connected and capable, use it without demanding a new key,
login, installation, or account migration merely to avoid the connector. For remaining setup
choices, choose the lowest-setup reliable option for the task. Consult the service's official
documentation when installation, authentication, commands, or schemas are uncertain or likely
to have changed:

- Use a trusted direct MCP already configured and exposed by the runtime. Do not automatically
  download, install, or start an unfamiliar MCP server.
- Safely install the official CLI when the runtime permits it, the source is verified as
  official, and no elevation or persistent host change is required.
- Use the official API or SDK with a verified contract and credentials already authorized for
  the runtime, including through an exact Vault reference.
- Use the Clawdi connector when no direct option is usable for the operation.

Before a side effect, establish the exact service account and organization, Project, or tenant.
Use connection details from Composio discovery, or explicitly list accounts with
`COMPOSIO_MANAGE_CONNECTIONS`, when the connector identity is not already clear.
Fallback must not silently change that identity. Do not scan for credentials, start an interactive
login, invent API details, or expose secrets. Choose the path before a side effect and advance
only after a definite preflight failure. If a mutation's result is ambiguous, inspect it through
the same path; never repeat it through another path.

## Connector Account Management

Use `COMPOSIO_MANAGE_CONNECTIONS` for account management, following its live schema.
For the multi-account schema, each `toolkits` item has `name` and `action`:

- `list`: Read account IDs, aliases, and statuses. Always specify this action for a
  lookup: omitting `action` defaults to `add` and creates an authorization link.
- `add`: Create a new authorization link when the user wants another connection.
- `rename`: Set `alias` on the exact `account_id` returned by discovery.
- `remove`: Delete the exact `account_id` selected by the user.

Reuse the returned `session_id` when available. Never guess account IDs, use a
mutation to discover accounts, or automatically retry an ambiguous mutation.
Do not assume an empty alias clears it unless the live contract confirms that behavior.

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
3. When search reports no active connection and the user wants to connect, call
   `COMPOSIO_MANAGE_CONNECTIONS` with explicit `action: "add"` in the multi-account schema.
   Follow its exposed schema and interpret only the fields it returns. Continue on `active`. On
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
