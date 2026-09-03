---
name: clawdi
description: "Use Clawdi Cloud for missing user memory, past sessions, Project or Vault context, Clawdi share URLs, and connected-service fallback such as Gmail, GitHub, Notion, Drive, or Calendar. Prefer an authenticated official service CLI, then the official API or SDK; use the Clawdi connector last. Do not invoke solely because a project, person, repo, or tool is named."
---

# Clawdi Cloud

Use Clawdi Cloud tools through the `clawdi` MCP server when they provide context or
capabilities unavailable more directly.

## Context Routing

Use the current conversation and user-provided artifacts first. For project facts, inspect
the workspace, repository documentation, and local history. Use `memory_search` only for
missing user-specific preferences, decisions, or prior context. Use `session_search` and
`session_read` only when the user asks for a past conversation or transcript-level detail is
necessary. Do not call Memory and Session speculatively or in parallel. A named entity alone
does not justify a Cloud lookup, and an empty Memory result does not justify a Session search.

## Memory

Memory is durable user-specific context shared across agents.

- `memory_search` — Search durable memory by natural-language query.
- `memory_add` — Save a durable fact, preference, pattern, decision, or project context.
- `memory_extract` — Prepare memories from the current conversation. Follow its returned
  review-and-confirm instructions and wait for user approval before calling `memory_add`.

Use `memory_add` for explicit "remember this" requests or durable user-specific preferences
and decisions not discoverable from the repository. Ask when persistence is unclear. Do not
save routine task completion, code facts, speculation, or plaintext secrets; use Vault and
remember only the exact `clawdi://` reference.

## Sessions

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

Two read-only MCP tools expose safe Vault metadata without secret values:

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

The current MCP tool set does not expose Vault mutation. If a live schema exposes one,
use it only for the exact Project, Vault, key, and change the user specified; never infer
an overwrite or deletion. Otherwise, do not use raw HTTP, daemon control RPC, or execute
foreground Vault CLI commands on the user's behalf. Explain that a human operator must
perform the change and provide the safest exact foreground command. Prefer `clawdi vault
set KEY --prompt` for one value and `clawdi vault import ...` for migrations; never place
a plaintext secret in command arguments or your response.

## Wallet Funding

Use `clawdi wallet status --json` to inspect the authenticated Wallet balance, verified
binding, and x402 readiness. Binding and Base USDC top-up are available only through the
browser wallet surface; Clawdi does not store the payment private key. Ask the user to fund
there. Command-line spending requires a future owner-only or hardware signer authority and is not
available.

## Connector Routing

Respect an explicit user choice. Otherwise prefer:

1. **Official service CLI**. Use an installed and authenticated CLI directly, such as `gh`,
   `aws`, `gcloud`, or `kubectl`. If it is missing, install the official CLI only when the
   runtime permits package installation, the source can be verified as official, and no
   elevation or persistent host change is required.
2. **Official API or SDK** with a known contract and authorized credentials already available
   to the runtime, including through an exact Vault reference. Use this path when CLI
   installation is inappropriate or unavailable, or CLI authentication cannot complete
   non-interactively.
3. **Clawdi connector** only when neither direct path can perform the operation.

Check CLI availability and authentication non-destructively and prefer structured output. Use
only credentials already authorized for the runtime; if CLI authentication cannot complete
non-interactively, continue to the API path. Do not scan for credentials, start an interactive
login, invent API details, or expose secrets. Choose the path before a side effect. Advance only
after a definite preflight failure. If a mutation's result is ambiguous, inspect it through the
same path; never repeat it through another path.

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
   responses saved remotely or remote artifacts.
6. Preserve dependencies and returned semantics. Follow signed-file metadata, pagination
   fields, and termination signals exactly as exposed. Select an account only when the schema
   supports it, and use additional or future meta-tools only according to their live schemas.

## AI Provider Management

Provider configuration is also a human operator workflow, not an Agent MCP capability. Do
not execute provider CLI commands or handle provider credentials on the user's behalf. When
asked, provide an exact `clawdi ai-provider` command for the operator to run and explain its
effect; suggest `validate` or a non-live `test` before any explicitly requested live probe.

- Treat the local Provider Catalog as multi-record metadata. Do not activate it into local agent config; Core Hosted activation is supplied by the runtime manifest/controller, whose configured runtime binds exactly one provider and whose unmanaged runtime binds none.
- Keep Codex OAuth ownership singular across Hosted runtimes. Hermes/OpenClaw native refresh, revoke, and ownership state belongs to Hosted convergence, not a local CLI materialization command.
- Default export/import is metadata-only; `--include-secrets` requires passphrase-encrypted secret export.
- BYOK model requests go directly from the agent runtime to the configured provider. Clawdi stores metadata and secret references but is not a model proxy.
