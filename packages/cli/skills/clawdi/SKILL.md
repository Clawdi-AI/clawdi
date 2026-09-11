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
`session_search`, and `session_get` only when the user asks for past conversations or
transcript-level detail is necessary. Do not call Memory and Session speculatively or in parallel.
A named entity alone does not justify a Cloud lookup, and an empty Memory result does not justify
a Session search.

## Memory

Memory is durable user-specific context shared across agents.

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

CLI fallback for exact updates: `clawdi memory update <full-memory-id> "new content" --json`.
It preserves metadata; find the exact ID before changing it.

## Sessions

- Use `session_list` to browse recent sessions or filter by time, Agent, or Project.
- Use `session_search` to find past agent conversations by keyword and obtain session UUIDs.
- Use `session_get` to read a session by UUID or Clawdi share URL.

Call `session_get` when the user provides a Clawdi share URL or session UUID and wants its
contents. For a request to open a specific unnamed past conversation, use `session_search`
to find the UUID and then read the selected match.

Do NOT call WebFetch on `cloud.clawdi.ai/s/...` URLs — `session_get` is the right tool and avoids the WebFetch permission prompt.

CLI fallback: `clawdi session search "query" --json`, then `clawdi session read <cloud-session-id> --json`.
`session list` is local; `session export <cloud-session-id>` exports owner Markdown without
publishing. Publish only with user authorization: `session share <cloud-session-id> --yes`.
For `--through` or `--response`, use the returned canonical message `position`, never a
filtered array index. `session shares --json` lists active links; revoke the exact link
ID with `session unshare <share-id> --yes` (add `--legacy` for `kind=live`).

Remote Skill operations use `clawdi agent skills list/read/install/rm <agent-id>`; local
`skill --agent <type>` remains separate. Use `install --github owner/repo --path skills/name`
or `install --library <skill-id>`. Accepted intent is not applied state: check `list` for
convergence and failures. GitHub exact replay needs both original `--request-id` and
`--resource-version` from the result/error.

## Projects

Three read-only tools expose the caller's visible Project context:

- `project_current_get` — Read the current or runtime-bound Project.
- `project_list` — List visible Projects.
- `project_get` — Read one visible Project by UUID.

Strict-v2 Hosted runtimes can read their own Workspace and explicitly linked Projects
that remain readable by the owner. `project_current_get` returns that Workspace;
writes, new Vaults, and credential requests are limited to that Workspace. Legacy
Agent-bound keys retain their narrower bound-Project read scope. Treat not-found as
an access boundary as well as a possible unknown UUID; never bypass it with another tool.

## Vault

Vault read tools expose metadata and exact references:

- `vault_list` — List Vault attachments and key counts for visible Projects.
- `vault_get` — List key names, provenance, and exact `clawdi://` references for one attached Vault.

Honor an explicit Vault/source or known local mapping first. Otherwise use `vault_list` /
`vault_get` metadata to reuse a Vault suited to the task's purpose and access. Create in
your own Workspace only when none is appropriate and the task authorizes creation.
Clarify ambiguous sources; never create duplicates or write to linked Projects to bypass access.

Use `vault_resolve` only when the authorized task requires plaintext. The metadata tools return
key names and exact references, never secret values. Preserve those references when
passing them to an authorized runtime:

- `clawdi://project/<project-id>/vault/<vault>/field/<field>`
- `clawdi://project/<project-id>/vault/<vault>/section/<section>/field/<field>`

Use the live schemas from the `clawdi` MCP server as authoritative.

Vault write tools are available for explicit user requests:

- `vault_create` — Create a Vault attached to one exact owner Project.
- `vault_item_upsert` — Create or replace exact fields in an attached Vault.
- `vault_item_delete` — Delete exact fields from a single-Project Vault.

Follow the live schema and supply every required Project, Vault, section, and field identity;
never infer an overwrite or deletion. Treat field values as sensitive inputs and never echo
them, save them to Memory, or include them in logs. Environment-bound callers may write only
their bound Project, and field deletion is rejected when a Vault is attached to multiple
Projects. Whole-Vault deletion, attach/detach, and credential profiles remain
foreground operator workflows; never bypass that boundary through raw HTTP or daemon RPC.

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

### Save and refresh credentials locally

Hosted runtime supplies `.clawdi/vaults/` under the native workspace automatically.
Connected macOS/Linux/WSL Agents receive the same layout only in the workspace explicitly
confirmed by setup. Use that configured path, which may differ from the current repository;
do not guess from HOME, daemon CWD, or scanned sessions. Existing registrations without a
Vault workspace do not download values. Native Windows daemon/file delivery is unsupported.

Inspect only the configured `.clawdi/vaults/index.json` to select the intended Vault/section.
Load its JSON file inside the authorized process or SDK without printing values or returning
them to model/tool-result context merely to save them. These are generated files: do not
edit, move or commit them. Hosted agents must not invoke/install the tenant Clawdi CLI.
Connected operators configure delivery with `clawdi setup --agent <type> --vault-workspace <path>`;
that changes only the Vault destination, never every repository scanned by the daemon.

After a credential request is supplied, wait for the expected fields in index metadata before
claiming delivery. If delivery is unavailable, report that state and any missing workspace
binding instead of inventing a destination. Preserve unrelated local configuration.

### Optional CLI environment files

For an explicit operator-run compatibility workflow outside Hosted, use the available CLI.
Choose a target outside the generated `.clawdi/vaults` directory:

```bash
clawdi vault materialize --vault <vault-uuid> --project <project-uuid> --out /absolute/project/.env
clawdi vault pull --out /absolute/project/.env
```

The first command binds the exact source; later pulls reuse it and preserve unrelated
assignments. Optional `--section <name>` selects one section. Files must be untracked,
Git-ignored, and not symlinks. Source changes and local edits fail without overwriting.
Report only the path, status, and counts. This does not upload local edits, run in the
background, or reload a running process's environment.

For explicit import/write, pass fields to `vault_item_upsert`; use
`vault_item_delete` for exact batch deletions. Never upload local edits automatically.

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

## AI Provider Management

Provider configuration is also a human operator workflow, not an Agent MCP capability. Do
not execute provider CLI commands or handle provider credentials on the user's behalf. When
asked, provide an exact `clawdi ai-provider` command for the operator to run and explain its
effect; suggest `validate` or a non-live `test` before any explicitly requested live probe.

- Treat the local Provider Catalog as multi-record metadata. Do not activate it into local agent config; Core Hosted activation is supplied by the runtime manifest/controller, whose configured runtime binds exactly one provider and whose unmanaged runtime binds none.
- Keep Codex OAuth ownership singular across Hosted runtimes. Hermes/OpenClaw native refresh, revoke, and ownership state belongs to Hosted convergence, not a local CLI materialization command.
- Default export/import is metadata-only; `--include-secrets` requires passphrase-encrypted secret export.
- BYOK model requests go directly from the agent runtime to the configured provider. Clawdi stores metadata and secret references but is not a model proxy.
