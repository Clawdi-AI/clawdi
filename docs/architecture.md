# Architecture

This is the current system map for Clawdi Cloud. Verify changes against code
before editing this file. For user setup, start in [`README.md`](../README.md).
For contributor commands, start in [`AGENTS.md`](../AGENTS.md).

## System Map

```text
Self-managed machine
  Claude Code / Codex / Hermes / OpenClaw / Pi / OpenCode
        | local files + stdio MCP
        v
  clawdi CLI
    adapters: claude_code, codex, hermes, openclaw, pi, opencode
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
  object store: session snapshots/event chunks, skill tarballs, asset blobs
```

The hosted box is intentionally opaque. This repo defines API contracts,
dashboard surfaces, CLI behavior, local mock helpers, and runtime convergence
code. Hosted service internals live outside this repository.

Hosted subscription and power controls consume generated backend decisions:
subscription `actions`, `recovery_action`, `recovery_blocked_reason`, and
deployment `start_action`. The dashboard does not infer replacement purchases
from raw billing status or treat undoing a scheduled cancellation as paused
subscription resumption. Subscription cancellation retains saved data; explicit
agent deletion remains separate. Pending requests do not imply completed stop.
Deploy the additive Hosted contract before this dashboard; older stored
responses without start advice wait for a fresh read. This is our product
contract, not a claim that Stripe or Cashier cancellation defaults are identical.

Done: regenerate `packages/shared/src/api/deploy.generated.ts` from the paired
Hosted OpenAPI; run focused subscription consumer tests and
`e2e/hosted-subscription-power.pw.ts` in an isolated Docker browser runner.

Cross-platform client behavior and current decision owners are tracked in the
[client capability matrix](cross-platform-capability-matrix.md).

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

## Plugin Catalog And Desired State

Clawdi is the sole authority for user Agent Plugin selection. New and existing
Agents have no plugin desired state by default. Authenticated product APIs read
the last-known-good catalog and mutate one owned Agent's desired installation;
they do not proxy selection through a hosted control plane and do not claim
that native installation has converged.

The catalog worker resolves `Clawdi-AI/store` `main` externally, then fetches
`v2/catalog.json` at that exact 40-hex commit. The strict Store catalog v1 is a
small public metadata and component-name summary. It contains no commit,
source authority, credentials, MCP connection details, or secret bindings.
Clawdi maps each accepted entry to the canonical Agent Plugins 1.0.0 schema
and fixed trusted repository, retains last-known-good snapshots on upstream
failure, and never makes a product or runtime request wait on GitHub.
Catalog ingestion is deployment opt-in through
`PLUGIN_CATALOG_SYNC_ENABLED=true`; Cloud and preview deployments enable it,
while local and self-hosted deployments do not contact GitHub by default.

Catalog snapshots and per-Agent desired installations are separate relational
state. Each desired row pins catalog revision, exact version, normalized
repository path, `sha256-tree-v1` digest, schema URI, and a stable opaque
backend UUID. Catalog refreshes do not upgrade existing rows. Mutations emit
the normal runtime-manifest invalidation; the changed manifest receives a new
`sourceRevision` without taking ownership of Hosted's Apply generation. This
release supports only Agents with the existing Hosted v2
runtime-state/bundle path; it does not install plugins for self-managed daemon
Agents.

Agent Plugins 1.0.0 itself defines package manifests and component loading. It
does not define a registry, marketplace, trust policy, installation source,
integrity scheme, or portable secret binding. Those Clawdi-specific controls
remain outside the official wire contract. Its `extensions` object permits
client policy namespaces; the Store's closed `ai.clawdi` extension contains
only schema version, display metadata, and optional runtime/executable
compatibility. It does not declare authentication.

The built-in Clawdi Skill and MCP server remain first-party runtime
infrastructure, not an Agent Plugin. The catalog name `clawdi` is reserved:
new desired-state writes fail closed, while historical rows remain readable
and explicitly removable but are inert during runtime projection. Third-party
public remote and stdio components keep using the generic Agent Plugins
lifecycle. Protected remote MCP authorization is separate owner-managed native
runtime state; a same-name native server override may opt into the runtime's
official OAuth flow without changing Store metadata, package bytes, or Clawdi
desired state.

## CLI And Adapters

The CLI owns local agent detection, data collection, sync, setup, MCP stdio,
vault/env injection, and runtime convergence commands.

Cloud capabilities exposed to Agents live behind the authenticated MCP API.
Narrow Vault create, field upsert, and exact field deletion use that authority;
template injection, bulk import, attachment changes, credential profiles, and
whole-Vault deletion remain foreground operator workflows rather than daemon
control RPC or alternate Agent APIs.

Adapter roots are verified in `packages/cli/src/adapters/*`:

| Agent | Sessions | Skills | Version |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/<encoded-cwd>/*.jsonl` | `~/.claude/skills/<key>/SKILL.md` | `claude --version` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | `~/.codex/skills/<key>/SKILL.md` except `.system/` | `codex --version` |
| Hermes | `$HERMES_HOME/state.db` or `~/.hermes/state.db` | `$HERMES_HOME/skills/<category>/<key>/SKILL.md` | `hermes --version` |
| OpenClaw | `$OPENCLAW_STATE_DIR/agents/<id>/sessions/` or `~/.openclaw/agents/<id>/sessions/` | `agents/<id>/skills/<key>/SKILL.md` | `openclaw --version` |
| Pi | `$PI_CODING_AGENT_DIR/sessions/**/*.jsonl` or `~/.pi/agent/sessions/**/*.jsonl` | — | `pi --version` |
| OpenCode | `$OPENCODE_DB` or `$XDG_DATA_HOME/opencode/opencode.db` | — | `opencode --version` |

`AgentAdapter` is core identity plus at least one complete `sessions` or
`skills` module. Methods inside a present module are mandatory. MCP lifecycle
belongs to the registry, not either data module. Pi is the first sessions-only
consumer; OpenCode is also sessions-only, while the other four adapters expose
both modules.

## Sync Engine

`clawdi push` uploads sessions and projects Agent filesystem Skills into their
Cloud rows. Agent Project Skill sync is one-way: the adapter's guarded local
Skills root is authoritative, and Cloud stores a read-only projection. Boot,
watcher, and periodic scans compare local inventory with an identity-fenced
claim ledger and durably queue the latest push or delete for each Skill key.
Cloud list failures and truncated results never authorize deletion. SSE only
wakes a local rescan; Cloud changes and deletes never write or remove Agent
Workspace Skill files. `clawdi pull` remains for explicitly Cloud-owned user
Project workflows, not Agent Workspace projections.

Target selection:

1. Explicit `--agent <type>`.
2. Registered local environments in `~/.clawdi/environments/*.json`.
3. Adapter detection.
4. Prompt when more than one candidate remains.

Sync state is client-side under `~/.clawdi/`, including Session state fenced by
API origin, stable Agent, adapter, and source key, plus a versioned Skill
projection ledger fenced by stable Agent and resolved Agent
Project identity. Only an exact successful Agent claim authorizes a later
projection delete. After Project reassignment, the durable queue deletes that
Agent's claimed row from the old Project before projecting current local state
to the new Project. Legacy hash-only entries may suppress redundant upload
work, but never prove delete authority.

The released Agent Skill projection hash is a compatibility protocol over the
safe dereferenced regular-file paths and bytes carried by the upload archive.
It intentionally does not include permission modes, and its historical
`path + content` stream has no length or domain framing. A chmod-only change is
therefore not guaranteed to reproject, and the hash must not be described as a
collision-unambiguous tree encoding. Fixing either limitation requires an
explicitly versioned wire, ledger, and persisted-hash migration in a later
protocol release; this change does not silently reinterpret old hashes or
claims.

## Sessions

The `sessions` table stores metadata, mutable stable-agent attribution in
`environment_id`, and immutable ingest identity in `origin_environment_id`.
Uniqueness and object keys include the immutable origin, so equal local IDs from
different Agents cannot collide.

Legacy `snapshot-v1` message arrays remain readable. `events-v1` stores strict
Message/ToolCall/ToolResult/Reasoning NDJSON in immutable generation chunks with
a DB chunk index, revision, count, and canonical chained head. Append writes only
new objects; truncation stages a generation and CAS-commits it. Owner-only
`/events` reads the complete rich stream, including model reasoning and the
reasoning-specific continuation state needed to preserve it. `/content`, public
sharing, exports, search, and memory inputs continue to project only useful
user/assistant text. Attachment parts identify either a safe external reference
or an explicit metadata-only record; this protocol does not store attachment
bodies, local paths, or duplicate provider message envelopes. A worker removes
abandoned staging generations after one day and superseded committed generations
after a seven-day read grace period; the current generation is never eligible.
Deleting an Agent nulls `environment_id` without deleting history; deletion
suppression remains fenced to immutable origin, with legacy origin-less
suppressions read as wildcards.

## Projects And Agent Use

The product domain has two deliberately distinct subjects:

- **Workspace** is the private system Project permanently owned and used by one
  Agent. It contains that Agent's filesystem-authored Skill projections and
  attached Vault access. It cannot be renamed, shared, archived, or unlinked.
- **Project** is a user-created, optionally shareable resource bundle. It owns
  Cloud-authored Skills and attaches account-owned Vaults. Memories,
  Connectors, Channels, and AI Providers are outside Projects.

The database retains compatibility kinds whose names predate this product
language: `environment` backs an Agent Workspace, `workspace` backs a user
Project, and `personal` is a hidden compatibility container. Routes and domain
adapters translate this inversion; browser surfaces must not display those
kind names or offer the compatibility container as a Project.

Every Agent has one fixed Workspace through `default_project_id` and a
`primary` `agent_project_bindings` row. User Projects are ordered `context`
bindings. Sharing grants existing read access only; Link Project is an explicit
whole-bundle action. A linked Agent uses every Skill in the Project and resolves
its attached Vaults. Link, unlink, Project Skill changes, and Project archival
invalidate the affected managed Agent desired state.

Skill keys have no precedence across the Agent Workspace and linked Projects.
The link or write transaction rejects a duplicate key before changing the
binding, Skill row, or object-store content and tells the user to remove or
rename one copy. Link, unlink, and Project Skill writes change control-plane
desired state regardless of CLI package version, runtime availability,
observation freshness, or reconcile lease. Runtime convergence and health are
reported separately and never gate those changes. An empty Project can still
be linked for Vault access.

Project owners may rename, edit the description, and archive their Projects.
Archival removes all Agent links immediately while retaining historical
resource rows. Agent Workspaces and hidden compatibility containers are
protected from these lifecycle mutations.

Local folder links are CLI selection hints for `clawdi run`. They do not grant
membership, link Projects to Agents, or mutate cloud Project relationships.

## Skills

Persisted Skills are project-scoped metadata rows plus tar.gz bodies in the
object store. Active rows are unique by `(user_id, project_id, skill_key)` and
carry durable `authority` provenance:

| Inventory authority | Source of truth | Allowed mutation |
| --- | --- | --- |
| `cloud` | Cloud-owned user Project | Normal authenticated Cloud UI/API and explicit `--project` CLI operations |
| `agent_sync` | One Agent Workspace's guarded filesystem target | Agent-authenticated claim/upload and absence/delete only; dashboard is read-only |

Historical rows are backfilled as `cloud`; Project kind, source strings, and
old environment metadata are not ownership evidence. A live authenticated
Agent upload may atomically claim the matching row as `agent_sync`, including
when its bytes are unchanged. Current CLIs use only the dedicated Agent sync
boundary; a missing dedicated route or an unproven Agent identity fails closed
without issuing a generic Project mutation. Compatibility writes still require
a proven CLI Agent and Agent Project; browser writes and orphan Agent Projects
fail closed. Slug-only delete is accepted only for an environment-bound API key,
whose bound Agent resolves exactly one current Agent Project.

Mixed-version behavior is selected by `X-Clawdi-Skill-Sync-Protocol`, never a
User-Agent guess. A missing header or explicit `agent-authoritative-v0` selects
the released legacy listing, SSE, upload, delete, and download behavior;
`agent-authoritative-v1` selects the current one-way behavior. Malformed and
unknown values return 400. Current CLIs use the dedicated Agent routes and do
not download Agent Project projections; an explicit v1 download remains
blocked. A current CLI reaching an old backend receives a dedicated-route 404,
retains its local operation, and does not create a generic Project mutation.
Additive
`agent_skill_changed`/`agent_skill_deleted` invalidations protect mutations
created by current backend workers from already-connected released parsers;
current daemons treat both event families as rescan hints. Cloud-owned Project
events retain their released names.

The bundled `clawdi` Skill is private platform infrastructure, not a third
inventory authority and not a user Skill. Its private runtime entry reserves
the local key before managed installation, so the daemon never uploads the
managed target as an `agent_sync` row. A previously claimed user file may yield
that key by deleting only its old Cloud projection; reconciliation never uses
Cloud state to delete the managed target. Internal enable/disable still
reconciles the bundle lifecycle, but neither state appears in the Skills UI or
a public deployment mutation contract.

## Vault

Vaults are account-owned secret bundles. Projects attach to vaults through
`vault_project_attachments`; keys remain on the vault. `vault_items` stores
sectioned fields encrypted with AES-256-GCM using `VAULT_ENCRYPTION_KEY`.

The dashboard can list and mutate metadata but never receives plaintext values.
Plaintext resolution is restricted to API-key auth through `/v1/vault/resolve`
and `/v1/vault/resolve/bulk`. Agent-scoped resolution reads the Agent Workspace
first, then linked Projects in order; conflicts block unless explicitly
allowed.

Credential profile payloads live in `vault_credential_profiles` and are used by
CLI credential import/materialization flows.

## Memory

The built-in memory provider stores account-owned `memories` with text,
category, source, tags, optional source Session or direct source Agent id,
access counters, JSONB metadata, and a 768-dimensional embedding. A write from
an environment-bound principal records `source_environment_id` directly; it
does not invent a Session. Provenance explains where a memory came from; it is
not an authorization boundary. Memory is account-shared so preferences and
durable decisions remain available across the user's agents.

Retrieval merges available signals:

- PostgreSQL full-text search through generated `content_tsv`.
- `pg_trgm` fuzzy matching.
- `pgvector` semantic search when local or API embeddings are enabled.

`Mem0Provider` is the alternate provider when the user's settings choose Mem0
and an API key is present. Environment provenance is stored in Mem0 metadata,
while reads use the account user id as their server-side boundary and deletes
verify that same owner before mutation. No session-to-memory automatic pipeline
exists; agents or users add memories explicitly.

## MCP And Connectors

The backend MCP endpoint is `POST /v1/mcp/clawdi`, a stateless JSON-RPC surface
authenticated with a Clawdi API key. It is the single runtime authority for
native tool schemas, scope gating, calls, and connector dispatch. Clawdi-owned
tool names use singular `<resource>[_<subresource>]_<action>` identifiers;
connector-provided names remain unchanged. Native tools cover Memory
search/list/create/exact update/delete, Session search/list/get,
read-only Project metadata, Vault metadata/references, explicit single-reference
Vault plaintext resolution, narrow Vault writes, and credential-free connector
account identity.
Tools requiring unavailable scopes are omitted from `tools/list`, while direct
calls still fail the scope check. Connector names can never shadow a declared
native tool, including one hidden by scope.

`memory_update` replaces only the selected memory's content and preserves its
metadata and provenance. Built-in memory updates clear a stale embedding when
re-embedding is unavailable; Mem0 updates verify account ownership before the
provider mutation. `session_list` uses the same account/legacy-environment fence
as Session search/get and supports bounded time, Agent, and visible Project
filters. `connector_account_list` exposes only connection IDs, toolkit names,
statuses, and allowlisted display labels; raw provider `data`, `state`, tokens,
and credentials never enter the MCP result.

For agents that only support stdio MCP, `clawdi mcp` is a protocol-transparent
stdio-to-HTTP wrapper: it forwards MCP messages and does not declare a second
copy of tool schemas or business logic. The backend keeps connector OAuth
tokens and bridge credentials out of the agent process.

`vault_list` and `vault_get` select only attachment metadata and field names;
they never select or decrypt `encrypted_value`, `nonce`, or credential payloads.
`vault_resolve` requires `vault:read`, accepts one exact Project-scoped
reference, and returns its decrypted value. Returned references use the exact canonical forms
`clawdi://project/<project-id>/vault/<vault>/field/<field>` and
`clawdi://project/<project-id>/vault/<vault>/section/<section>/field/<field>`.
Environment-bound callers see only attachments in their bound Agent Project.

`vault_create`, `vault_item_upsert`, and `vault_item_delete` require `vault:write`.
Every write takes an explicit owner Project; item writes also require an exact
Vault UUID and canonical slug attached to that Project. Environment-bound keys
may target only their bound Project. Responses contain identifiers and counts,
never plaintext values. Agent MCP deletion has no global-confirmation switch,
so a Vault attached to multiple Projects is rejected. Attachment changes,
credential profiles, bulk import, and whole-Vault deletion are not exposed.

The safe MCP inventory API may contain only explicit user declarations whose
provenance is supported by a user management contract. This release has no such
contract, so the dashboard does not expose an MCP page. A valid private
platform-only state is projected as empty and unknown server declarations fail
closed. The preinstalled `clawdi` aggregate and its dynamic Composio tools stay
behind `POST /v1/mcp/clawdi`; neither is a user-manageable MCP inventory row.

## Channels

Native Channels are owned by the FastAPI backend and PostgreSQL. They support
Telegram, Discord, and WhatsApp provider families through
channel accounts, bot-agent links, pair codes, bindings, message rows,
delivery outbox rows, credentials, and provider-specific adapters.

Channels bind external bots to Agents, not Projects. A conversation session
routes to exactly one active bot-agent link. Public bots are shared provider
infrastructure, but each user's links, pair codes, bindings, messages,
deliveries, and agent SDK tokens remain user-owned.

The product model is in
[`designs/native-channels-product-model.md`](designs/native-channels-product-model.md).
The package named WhatsApp Baileys sidecar is the single physical-provider
transport per real account, not an Agent runtime connector. Real linked-device
auth stays there; Link authorization, synthetic Noise/Signal state, routing,
and durable inbox/outbox persistence stay in FastAPI/PostgreSQL.

## AI Providers

AI Providers are account-global model-provider definitions with auth references
and target-specific projection support. Metadata lives in `ai_providers`; stored
auth payloads live in `ai_provider_auth_payloads`. Catalog CRUD remains
multi-record, while a Core Hosted manifest binds at most one provider to its
selected Hermes or OpenClaw runtime. BYOK model traffic goes directly from the
runtime to the provider; Clawdi does not proxy those calls.

Current behavior and the Hosted manifest/controller boundary are documented in
[`ai-providers.md`](ai-providers.md).

## Managed Runtime

Managed runtime mode is a public CLI/dashboard contract for controlled runtime
environments. The CLI validates desired state, writes non-secret local
projections, creates short-lived secret files under the runtime run directory,
renders support/runtime service plans, and exposes the managed operator ABI:
`runtime init`, `watch`, `verify`, `sidecar`, `status`, `doctor`, and hidden
`clawdi run --runtime-service ...` dispatch alongside explicit
`clawdi run -- <command>`.

Cloud API is the single desired-state composer for Skills. It merges Hosted V2
Agent Workspace Skill intent with Cloud-owned Skills from linked Projects. The
Project rows remain the only content writer; runtime observations never become
another catalog. Each Project Skill entry uses the runtime-neutral `project`
source discriminator and carries immutable content identity plus an authenticated
archive endpoint. The CLI verifies
the canonical archive tree hash before cache or activation. Historical Skills that
were stored as one `.md` file retain their file-content SHA compatibility only
when the delivered archive contains exactly one `SKILL.md`. It then preserves
native runtime contracts: Hermes receives the verified staged directory through
its profile-local `~/.hermes/skills` discovery surface, while OpenClaw receives it
through `openclaw skills install`. Unlink, archive, access loss, deletion, or hash
change invalidates the signed archive lookup.

Native Skill delivery fingerprints the activated Skill tree and writes that
fingerprint to a private receipt bound to the immutable source identity. Later
convergence compares the current tree only with that receipt. An identity change
or fingerprint mismatch requires the reservation ledger to prove ownership
before replacement records a new fingerprint.

OpenClaw directory delivery also checks the configured Workspace against the
official `openclaw agents list --json` roster before and after installation.
A Workspace mismatch fails closed instead of creating a second writer.

Hosted manifests render linked Project Skills for every `HostedRuntimeState`;
Connected inventory returns them after Connected identity and authorization
validation. Capability reports remain a deployed-client-compatible observation
only. Runtime reconciliation handles convergence without changing desired-state
eligibility.

The detailed contract is [`managed-runtime.md`](managed-runtime.md). This
architecture page should not duplicate that runtime specification.

## Data Model

Core tables verified under `backend/app/models/`:

| Tables | Purpose |
| --- | --- |
| `users`, `user_settings` | Clerk user mirror, profile fields, skill revision counter, user settings such as memory provider. |
| `app_settings` | Strictly registered global JSON settings. Values are replaced atomically and have no per-user overrides. |
| `api_keys` | SHA-256-hashed CLI/API tokens, optionally scoped to an Agent. |
| `agent_environments` | Stable Agent identities plus refreshable machine metadata, labels, daemon observability, and fixed Agent Project id. |
| `hosted_runtime_states` | Runtime desired CONFIG state keyed to an Agent identity for hosted surfaces and local mock flows. |
| `hosted_runtime_config_observations` | Daemon-reported CONFIG convergence with `observed_at`, observed config generation, observed manifest ETag, and validated diagnostics JSONB; distinct from hosted provider COMPUTE observations. |
| `v2_runtime_environment_fences`, `v2_runtime_observation_inbox`, `v2_runtime_observation_heads`, `v2_runtime_observation_consumer_cursors` | Additive declarative-v2 runtime evidence under direct `/v2/runtime/*` routes, permanent retirement fencing, boot-session high-waters/tombstones, and Hosted workload-bound replay cursors. Inbox rows record semantic changes; unchanged heartbeats refresh the compact head. Retention compacts eligible private payloads while permanent change-evidence identities preserve replay boundaries. The compatible v1 heartbeat applies the same append-on-change rule to its observation projection. |
| `projects`, `project_memberships`, `project_share_links`, `project_invitations`, `share_redeem_attempts` | Project ownership, viewer access, share links, directed invites, and redeem throttling/idempotency. |
| `agent_project_bindings` | One fixed `primary` Agent Project plus ordered `context` linked Projects. |
| `sessions`, `session_permissions` | Conversation metadata, object-store body pointer, public/user/email sharing permissions. |
| `skills` | Project-scoped skill metadata and object-store tarball pointer. |
| `vaults`, `vault_project_attachments`, `vault_project_slug_aliases`, `vault_items`, `vault_credential_profiles` | Account-owned vaults, Project access attachments, compatibility slug aliases, encrypted secret fields, encrypted local auth profiles. |
| `memories` | Built-in memory text, tags, direct Agent or legacy Session provenance, metadata, access counters, and optional embedding vector. |
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
- `ENCRYPTION_KEY` derives channel credentials and acts as the runtime cursor
  encryption fallback; it must remain separate.

## CLI Distribution Ownership

- The native macOS/Linux distribution uses immutable version directories and a
  stable launcher symlink; its checksum-verified executable owns native updates.
  Bun's macOS executables are linker ad-hoc signed, not Developer ID signed or
  notarized; the curl installer does not claim browser-download Gatekeeper
  behavior.
- npm/Bun global installs remain package-manager-owned and update by exact npm
  version.
- Hosted transactions remain a separate exact-version npm authority and never
  invoke native self-update.

## Known Absences

- No Redis dependency.
- No Celery or async job table.
- No automatic session-to-memory extraction pipeline.
- No Cognee provider; memory providers are built-in PostgreSQL search and Mem0.

Add an ADR or focused design note before turning a known absence into a new
module.
