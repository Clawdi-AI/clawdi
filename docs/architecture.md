# Architecture

This is the current system map for Clawdi Cloud. Verify changes against code
before editing this file. For user setup, start in [`README.md`](../README.md).
For contributor commands, start in [`AGENTS.md`](../AGENTS.md).

## System Map

```text
Self-managed machine
  Claude Code / Codex / Hermes / OpenClaw
        | local files + stdio MCP
        v
  clawdi CLI
    adapters: claude_code, codex, hermes, openclaw
    commands: setup, push, pull, run, daemon, mcp
        |
        | HTTPS /v1, bearer API key
        v
+-------------------------+        +-----------------------------+
| cloud-api               |<-------| TanStack web dashboard      |
| FastAPI                 | Clerk  | Clerk auth, generated types |
| routes + services       | JWT    +-----------------------------+
+-----------+-------------+
            ^
            |
            | public API contracts
            |
First-party hosted control planes
  opaque outside this OSS repo

cloud-api stores:
  PostgreSQL: metadata, pgvector memories, pg_trgm/FTS indexes
  object store: session JSONL bodies, skill tarballs, asset blobs
```

The hosted box is intentionally opaque. This repo defines API contracts,
dashboard surfaces, CLI behavior, local mock helpers, and runtime convergence
code. Hosted service internals live outside this repository.

## Overview

Clawdi Cloud is a cross-agent sync and recall layer. The CLI reads supported
agent state from local homes, syncs sessions and skills to the backend, installs
a local MCP bridge, resolves vault references for runtime commands, and exposes
shared memory to agents. The web dashboard uses the same backend for sessions,
agents, projects, skills, vaults, memories, connectors, channels, AI Providers,
and hosted surfaces.

## API And Identity

`/v1/agents` is the canonical first-party API for Agent identity. New dashboard
and CLI code use `agent_id` path parameters.

`/v1/environments` remains a deprecated compatibility alias, and hidden
`/api/*` mounts remain for released clients. Session payloads still use
`environment_id` as the legacy wire name for the stable agent id. Admin has
both `/v1/admin/agents` and `/v1/admin/environments`; admin routes are hidden
from public OpenAPI.

The first-class object is **Agent**. `AgentEnvironment` and the
`agent_environments` table are legacy persistence names. `AgentEnvironment.id`
is the stable agent id. `registration_key` is only setup idempotency for
self-managed agents; explicit identities have `registration_key = NULL`.

Agent naming follows the one-name model from
[`ADR-0001`](adr/0001-agent-identity-is-the-stable-domain-object.md): the
primary label resolves from `display_name`, then `default_name`, then
`machine_name`, then `agent_type`. Ownership changes badges and actions, not
the name fallback.

API compatibility policy lives in [`api-compatibility.md`](api-compatibility.md).

## CLI And Adapters

The CLI owns local agent detection, data collection, sync, setup, MCP stdio,
vault/env injection, and runtime convergence commands.

Adapter roots are verified in `packages/cli/src/adapters/*`:

| Agent | Sessions | Skills | Version |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/<encoded-cwd>/*.jsonl` | `~/.claude/skills/<key>/SKILL.md` | `claude --version` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | `~/.codex/skills/<key>/SKILL.md` except `.system/` | `codex --version` |
| Hermes | `$HERMES_HOME/state.db` or `~/.hermes/state.db` | `$HERMES_HOME/skills/<category>/<key>/SKILL.md` | `hermes --version` |
| OpenClaw | `$OPENCLAW_STATE_DIR/agents/<id>/sessions/` or `~/.openclaw/agents/<id>/sessions/` | `agents/<id>/skills/<key>/SKILL.md` | `openclaw --version` |

`AgentAdapter` also exposes skill-key listing, session watch paths, shared-skill
paths, local skill removal, and `buildRunCommand`; do not document a smaller
interface than `packages/cli/src/adapters/base.ts`.

## Sync Engine

`clawdi push` uploads sessions and skills. `clawdi pull` downloads skills.
`clawdi daemon run` keeps skill state live through local watchers, SSE, and
heartbeat updates.

Target selection:

1. Explicit `--agent <type>`.
2. Registered local environments in `~/.clawdi/environments/*.json`.
3. Adapter detection.
4. Prompt when more than one candidate remains.

Sync state is client-side under `~/.clawdi/`, including session/skill lock
files. The backend stores metadata and file bodies, but it does not own each
machine's upload watermark.

## Sessions

The `sessions` table stores metadata: user, stable agent id as
`environment_id`, local session id, project path, timestamps, model/token
counts, status, content hash, and `file_key`.

Raw transcript bodies are stored in the object store. Public session sharing is
controlled by `session_permissions`; public reads use `/v1/public/sessions/*`.
Deleting an Agent sets `sessions.environment_id` to NULL instead of deleting
history.

## Projects And Agent Use

Projects are resource and collaboration boundaries. Kinds are `personal`,
`environment`, and `workspace`.

Every Agent has one fixed Agent Project through `default_project_id` and a
`primary` `agent_project_bindings` row. Extra Projects are ordered `context`
bindings. Sharing grants Project membership only; using a shared Project at
runtime requires an explicit Agent attachment.

Local folder links are CLI selection hints for `clawdi run`. They do not grant
membership, attach Projects, or mutate cloud Project relationships.

## Skills

Skills are project-scoped metadata rows plus tar.gz bodies in the object store.
Active skills are unique by `(user_id, project_id, skill_key)`. The CLI uploads
local skills with `clawdi push`, downloads cloud skills with `clawdi pull`, and
can add or install skills through `clawdi skill ...`.

## Vault

Vaults are account-owned secret bundles. Projects attach to vaults through
`vault_project_attachments`; keys remain on the vault. `vault_items` stores
sectioned fields encrypted with AES-256-GCM using `VAULT_ENCRYPTION_KEY`.

The dashboard can list and mutate metadata but never receives plaintext values.
Plaintext resolution is restricted to API-key auth through `/v1/vault/resolve`
and `/v1/vault/resolve/bulk`. Agent-scoped resolution reads the Agent Project
first, then attached Projects in order; conflicts block unless explicitly
allowed.

Credential profile payloads live in `vault_credential_profiles` and are used by
CLI credential import/materialization flows.

## Memory

The built-in memory provider stores account-scoped `memories` with text,
category, source, tags, optional source session id, access counters, JSONB
metadata, and a 768-dimensional embedding.

Retrieval merges available signals:

- PostgreSQL full-text search through generated `content_tsv`.
- `pg_trgm` fuzzy matching.
- `pgvector` semantic search when local or API embeddings are enabled.

`Mem0Provider` is the alternate provider when the user's settings choose Mem0
and an API key is present. No session-to-memory automatic pipeline exists;
agents or users add memories explicitly.

## MCP And Connectors

The backend MCP endpoint is `POST /v1/mcp/clawdi`, a stateless JSON-RPC surface
authenticated with a Clawdi API key. It exposes native tools such as memory and
session tools, then dynamically lists connector tools and forwards those calls
through the connector bridge.

For agents that only support stdio MCP, `clawdi mcp` registers local tool
schemas and forwards calls to the backend. The backend keeps connector OAuth
tokens and bridge credentials out of the agent process.

## Channels

Native Channels are owned by the FastAPI backend and PostgreSQL. They support
Telegram, Discord, WhatsApp, and iMessage/BlueBubbles provider families through
channel accounts, bot-agent links, pair codes, bindings, message rows,
delivery outbox rows, credentials, and provider-specific adapters.

Channels bind external bots to Agents, not Projects. A conversation session
routes to exactly one active bot-agent link. Public bots are shared provider
infrastructure, but each user's links, pair codes, bindings, messages,
deliveries, and agent SDK tokens remain user-owned.

The product model is in
[`designs/native-channels-product-model.md`](designs/native-channels-product-model.md).
The WhatsApp Baileys sidecar is a protocol adapter only; routing and persistence
stay in FastAPI/PostgreSQL.

## AI Providers

AI Providers are account-global model-provider definitions with auth references
and target-specific projection support. Metadata lives in `ai_providers`; stored
auth payloads live in `ai_provider_auth_payloads`.

The current apply targets are Codex, Hermes, and OpenClaw. Claude Code OAuth is
not supported in AI Provider v1. BYOK model traffic goes directly from the
agent/runtime to the configured provider; Clawdi does not proxy those calls.

User docs live in [`ai-providers.md`](ai-providers.md); pinned target contracts
live in [`ai-provider-agent-contract-audit.md`](ai-provider-agent-contract-audit.md).

## Managed Runtime

Managed runtime mode is a public CLI/dashboard contract for controlled runtime
environments. The CLI validates desired state, writes non-secret local
projections, creates short-lived secret files under the runtime run directory,
renders support/runtime service plans, and exposes `runtime init`, `watch`,
`sidecar`, `status`, `doctor`, and explicit `clawdi run -- <command>`.

The detailed contract is [`managed-runtime.md`](managed-runtime.md). This
architecture page should not duplicate that runtime specification.

## Data Model

Core tables verified under `backend/app/models/`:

| Tables | Purpose |
| --- | --- |
| `users`, `user_settings` | Clerk user mirror, profile fields, skill revision counter, user settings such as memory provider. |
| `api_keys` | SHA-256-hashed CLI/API tokens, optionally scoped to an Agent. |
| `agent_environments` | Stable Agent identities plus refreshable machine metadata, labels, daemon observability, and fixed Agent Project id. |
| `hosted_runtime_states` | Runtime desired CONFIG state keyed to an Agent identity for hosted surfaces and local mock flows. |
| `hosted_runtime_config_observations` | Daemon-reported CONFIG convergence with `observed_at`, observed config generation, observed manifest ETag, and validated diagnostics JSONB; distinct from hosted provider COMPUTE observations. |
| `projects`, `project_memberships`, `project_share_links`, `project_invitations`, `share_redeem_attempts` | Project ownership, viewer access, share links, directed invites, and redeem throttling/idempotency. |
| `agent_project_bindings` | One fixed `primary` Agent Project plus ordered `context` attached Projects. |
| `sessions`, `session_permissions` | Conversation metadata, object-store body pointer, public/user/email sharing permissions. |
| `skills` | Project-scoped skill metadata and object-store tarball pointer. |
| `vaults`, `vault_project_attachments`, `vault_project_slug_aliases`, `vault_items`, `vault_credential_profiles` | Account-owned vaults, Project access attachments, compatibility slug aliases, encrypted secret fields, encrypted local auth profiles. |
| `memories` | Built-in memory text, tags, source, metadata, access counters, and optional embedding vector. |
| `ai_providers`, `ai_provider_auth_payloads` | Account-global provider metadata and encrypted provider auth payloads. |
| `channel_accounts`, `channel_bot_agent_links`, `channel_secrets`, `channel_bindings`, `channel_binding_aliases`, `channel_pair_codes`, `channel_messages`, `channel_deliveries`, `channel_agent_credentials`, `channel_whatsapp_auth_certs`, `channel_debug_events`, `channel_attachment_uploads`, `channel_scheduled_messages`, `channel_agent_references` | Native channel control state, routing, inbox/outbox, credentials, debug and provider-specific state. |
| `control_plane_audit_events` | Audit events for control-plane-facing operations exposed by this backend. |
| `device_authorizations` | CLI device authorization flow state. |

## Storage And Auth

- PostgreSQL stores structured metadata and search indexes.
- Object store stores session bodies, skill archives, and assets.
- Clerk JWT auth powers the dashboard.
- API-key auth powers CLI, local MCP, vault plaintext resolution, daemon sync,
  and agent-local operations.
- `VAULT_ENCRYPTION_KEY` encrypts vault and credential payloads at rest.
- `ENCRYPTION_KEY` signs MCP bridge JWTs and must remain separate.

## Known Absences

- No Redis dependency.
- No Celery or async job table.
- No automatic session-to-memory extraction pipeline.
- No Cognee provider; memory providers are built-in PostgreSQL search and Mem0.
- No single-file Bun compiled CLI distribution.

Add an ADR or focused design note before turning a known absence into a new
module.
