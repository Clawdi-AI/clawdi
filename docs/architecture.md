# Architecture

High-level map of what's actually in Clawdi Cloud today — updated as the code changes. For end-user docs, see the top-level [`README.md`](../README.md) and [`using-clawdi-with-claude-code.md`](using-clawdi-with-claude-code.md).

---

## One-paragraph overview

Clawdi Cloud is a cross-agent sync + recall layer. A local CLI (`clawdi`) reads per-agent data (Claude Code, Codex, Hermes, OpenClaw) from well-known directories, pushes sessions and skills to a FastAPI backend, pulls shared skills back down, and exposes a long-term memory store to each agent via the Model Context Protocol. Projects are the collaboration and data ownership boundary; each Agent has one fixed Agent Project plus optional attached Projects for read-time composition. The web app is a read-mostly dashboard on the same backend. The memory store is the differentiator: it gives every connected agent the same cross-session, cross-machine context without the agents having to know about each other.

---

## Topology

```
┌──────────────────────┐  HTTP (Bearer API key)   ┌──────────────────────┐
│ clawdi CLI (local)   │─────────────────────────▶│ FastAPI backend      │
│  - adapters/         │                          │  - routes/           │
│  - mcp/server.ts     │                          │  - services/         │
│  - commands/         │                          │  - models/ (SQLA)    │
└──────────────────────┘                          └──────────┬───────────┘
        │                                                    │
        │ stdio MCP                                          │
        ▼                                                    ▼
┌──────────────────────┐                        ┌────────────────────────┐
│ Claude Code / Codex /│                        │ PostgreSQL             │
│ Hermes / OpenClaw    │                        │  - pgvector + pg_trgm  │
│ (reads local state   │                        │  - tsvector GIN idx    │
│  dirs, invokes MCP)  │                        └──────────┬─────────────┘
└──────────────────────┘                                   │
                                                           │
┌──────────────────────┐  HTTP (Clerk JWT)         ┌───────┴────────┐
│ Next.js web dashboard│─────────────────────────▶│ File store     │
│ (read-mostly)        │                          │ (local / S3)   │
└──────────────────────┘                          └────────────────┘
```

Two auth paths hit the same backend:

- **Clerk JWT** — from the web dashboard. Gets most endpoints. Cannot resolve vault secret values.
- **Bearer API key** (`clawdi_...`) — from the CLI and the MCP server it spawns. Required for `/api/vault/resolve` and for any agent-local operation that needs to read secrets.

---

## Data model

All keyed off Clerk `user_id`:

| Table | What it holds | Written by |
|---|---|---|
| `users` | Clerk user mirror + email | Sign-in |
| `api_keys` | SHA-256-hashed CLI bearer tokens | Dashboard |
| `agent_environments` | One row per (machine × agent). `agent_type ∈ {claude_code, codex, hermes, openclaw}` | `clawdi setup` |
| `projects` | Resource availability boundaries for skills, vault attachments, and future memory/session grouping. Kinds are `personal`, `environment`, and `workspace`; `environment` is the internal Agent Project kind | Provisioning, `clawdi setup`, `clawdi project create` |
| `project_memberships` | Viewer-only shared Project access granted by invite or share link | Share accept / invite accept |
| `project_share_links` | Hashed bearer links for read-only Project access. Raw tokens are only returned once | `clawdi project share` |
| `project_invitations` | Pending directed invites to existing Clawdi users | `clawdi project invite` |
| `agent_project_bindings` | Runtime Agent composition: one fixed `primary` Agent Project row plus ordered `context` attachments | `clawdi setup`, `clawdi agent projects ...` |
| `sessions` | Per-conversation metadata: `environment_id`, `local_session_id`, `project_path`, token counts, model, summary, status. **Raw transcript body is in the file store**, keyed by `file_key` | `clawdi push` |
| `skills` | Per-skill metadata + tar.gz body in file store | CLI `skill add / install`, dashboard upload |
| `vaults` + `vault_project_attachments` + `vault_items` | Three-level secrets: vault → section → field. Vaults own their keys; Projects only attach to a vault to make those keys available. Values are AES-256-GCM encrypted. `/vault/resolve` decrypts readable Project values for CLI/API-key callers | `clawdi vault set` |
| `memories` | Long-term recall. `content` (text), `category`, `tags`, plus three search columns (`content_tsv` generated tsvector, `embedding vector(768)`) | CLI and MCP `memory_add` |
| `user_settings` | Opaque JSONB per-user prefs: `memory_provider` (`builtin` / `mem0`), `mem0_api_key` | `PATCH /api/settings` |

There is no `cron_job` / `channel` / `celery` / `background_task` table — those were in the original plan but never built. See [What's not implemented](#whats-not-implemented) below.

---

## Storage split

- **PostgreSQL** — structured metadata + memory search. Alembic manages the schema. Extensions enabled: `pg_trgm` (trigram fuzzy match), `vector` (pgvector for embeddings).
- **File store** — session transcripts (JSONL) and skill bodies (tar.gz). Abstracted via `app/services/file_store.py`; dev uses local filesystem (`./data/files/`), prod can be S3 / R2.
- **No Redis yet** — originally planned for task queue + cache; currently unused.

The separation is intentional: sessions can be multi-MB of JSONL; storing them in PG would bloat the DB and make dashboard queries slow. Metadata in PG, blobs in file store, metadata rows carry `file_key` pointers.

---

## Memory retrieval

The highest-signal path in the system. Four layers, hybrid-merged:

1. **`tsvector` full-text search** (always on). `content_tsv` is a generated column with `to_tsvector('simple', content)`. Ranks with `ts_rank_cd` against `websearch_to_tsquery`. The `simple` dictionary is language-agnostic — mixed EN/CN memories just work, no per-language config.
2. **`pg_trgm` trigram similarity** (always on). Handles typos, out-of-order words, partial terms. GIN index on `content` with `gin_trgm_ops`.
3. **`pgvector` semantic search** (active when `MEMORY_EMBEDDING_MODE=local` or `=api`). HNSW index on a 768-dim column. Default embedder is `sentence-transformers/paraphrase-multilingual-mpnet-base-v2` via [fastembed](https://github.com/qdrant/fastembed) — CPU ONNX, no API key, first use downloads ~1GB. API mode swaps in OpenAI / OpenRouter.
4. **Merge + rerank** — vector and FTS results are normalized, weighted (0.7 / 0.3), a 30-day-half-life temporal decay is applied, and a Jaccard-token MMR pass diversifies the top-N so near-duplicates don't crowd out distinct memories.

Both vector and FTS have **strict / relaxed** score floors — strict first, relaxed fallback if empty — so abstract queries against narrowly-phrased memories still surface something instead of returning empty.

The `BuiltinProvider` (`backend/app/services/memory_provider.py`) owns this. `Mem0Provider` is the alternative — thin wrapper around [Mem0's](https://mem0.ai) cloud API, selected per-user via `user_settings.memory_provider = "mem0"` + a `mem0_api_key`. Selection precedence:

```
user's memory_provider = "mem0" + mem0_api_key present     → Mem0Provider
otherwise                                                   → BuiltinProvider
  with embedder determined by deployment env:
    MEMORY_EMBEDDING_MODE=local → fastembed              (default)
    MEMORY_EMBEDDING_MODE=api   → OpenAI-compatible
    anything else / missing key → FTS + trigram only
```

The embedder choice is **deployment-level**, not per-user — it's an operator concern (which GPU / API bill / privacy posture you want), not something users should pick.

---

## Agent adapters

All four agents implement the same interface (`packages/cli/src/adapters/base.ts`):

```ts
interface AgentAdapter {
  agentType: AgentType;
  detect(): Promise<boolean>;
  getVersion(): Promise<string | null>;
  collectSessions(since?, projectFilter?): Promise<RawSession[]>;
  collectSkills(): Promise<RawSkill[]>;
  getSkillPath(key: string): string;
  writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void>;
  buildRunCommand(args: string[], env: Record<string, string>): string[];
}
```

Per-agent specifics:

| Agent | Sessions at | Skills at | Version command |
|---|---|---|---|
| **Claude Code** | `~/.claude/projects/<hash>/*.jsonl` (one JSONL per session) | `~/.claude/skills/<key>/SKILL.md` (flat) | `claude --version` |
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | `~/.codex/skills/<key>/SKILL.md` (skips `.system/`) | `codex --version` |
| **Hermes** | `~/.hermes/state.db` (SQLite) | `~/.hermes/skills/<category>/<key>/SKILL.md` (recursive) | `hermes --version` |
| **OpenClaw** | `~/.openclaw/agents/<agentId>/sessions/sessions.json` index + per-session JSONL | `~/.openclaw/agents/<agentId>/skills/<key>/SKILL.md` (flat) | `openclaw --version` |

The MCP server registration path also differs per agent — see `commands/setup.ts`:

- Claude Code → `claude mcp add-json clawdi ...`
- Codex → `codex mcp add clawdi ...`
- Hermes → direct YAML edit of `~/.hermes/config.yaml`
- OpenClaw → prints a manual-config hint (its ACP bridge rejects per-session MCP declarations)

---

## Sync engine

`clawdi push` and `clawdi pull` share a selector that picks the target agent:

1. Explicit `--agent <type>` flag wins.
2. Else look at `~/.clawdi/environments/*.json` — if exactly one registered, pick it.
3. Else fall back to `adapter.detect()` on all four; if exactly one matches, pick it.
4. Else prompt (arrow-key picker).

Sync state (`sessions.lastSyncedAt`, `skills.lastSyncedAt`) lives in `~/.clawdi/sync.json` — **the server is stateless about sync**. The CLI sends `?since=` filters on upload. This keeps the server simple and lets multiple machines sync independently.

Per-project filter: `clawdi push` defaults to the current working directory as a local path filter for sessions. `--all` disables it, `--project <path>` overrides. This is not the cloud Project alias used by Project sharing commands. Hermes ignores the filter (its sessions have no `cwd`); it prints a yellow warning and syncs everything instead of silently dropping the filter.

---

## Vault

Three-level layout: vault → section → field. A vault owns the key rows once; one or more Projects can attach to that vault to make the same keys available to agents. Example paths:

```
clawdi://project/<project-id>/vault/default/field/OPENAI_API_KEY
clawdi://project/<project-id>/vault/api-service/section/openai/field/api_key
clawdi://default/OPENAI_API_KEY
clawdi://api-service/openai/api_key
clawdi://payments/stripe/secret_key
clawdi://api-service/database/url
```

`.env` imports and `clawdi vault set OPENAI_API_KEY` store fields without a section by default, so that key resolves as `clawdi://default/OPENAI_API_KEY`. Use `clawdi vault import --section openai ...` or `clawdi vault set default/openai/api_key` for sectioned fields.
Exact references include the Project ID and are the default Web/CLI copy UX. In project-relative references, `default` is the vault slug, not the Project; Project selection happens outside the URI through `--project`, `--agent`, local folder links, or the caller's default Project.

Project access and key mutation are separate operations. `clawdi vault attach` and `clawdi vault detach` add or remove a Project's access to the whole Vault without changing stored values. `clawdi vault rm` deletes a key from the shared Vault itself; for Vaults attached to multiple Projects, the CLI and API require explicit global confirmation.

Values encrypted with AES-256-GCM (`vault_encryption_key` env var is the master key). The backend has two vault surfaces:

- `/api/vault/*` — CRUD, accessible from the web dashboard, but **never returns plain values**
- `/api/vault/resolve` — returns `{ KEY: plain_value, ... }` or one resolved key, **only accepts CLI API keys**, rejects Clerk JWTs at the auth layer. User-level CLI/API keys can resolve plaintext from Projects the caller can read, including shared viewer Projects; env-bound Agent keys can read attached shared Projects only through the matching Agent boundary.

`clawdi run -- <cmd>` hits `/vault/resolve`, merges the returned env into the child process's environment, and `exec`s. `clawdi run --project <project> -- <cmd>` resolves from that explicit cloud Project. Without `--project`, a local `clawdi project folder link --project <project>` can select the Project for the current folder or a parent folder. Folder links are local CLI selection hints only: they do not grant Project access, attach Projects to Agents, or compose Projects.

Agent runtime resolution is separate from folder links. `clawdi vault resolve KEY --agent <agent-id>` reads the fixed Agent Project first, then attached Projects by explicit order. Conflicting keys across that order block by default and require `--allow-conflicts` for first-match wins.

---

## MCP server

`clawdi mcp` runs a stdio MCP server. Registered by `clawdi setup` with each agent, so the agent spawns it on startup. Two native tools:

- `memory_search(query, limit?)` — proxies to `GET /api/memories?q=...`
- `memory_add(content, category?)` — proxies to `POST /api/memories`

Plus **dynamically-registered connector tools** — at MCP init, the server fetches `/api/connectors/mcp-config` and `tools/list` from the user's Composio Tool Router bridge (`/api/mcp/composio`), then registers each remote tool locally with a zod schema built from the MCP `inputSchema` or older `parameters` metadata. When the agent calls one, the local MCP server forwards the original upstream tool name and structured arguments through the backend bridge. The bridge mediates auth so the connector's real OAuth token and the Composio project API key never leave the backend.

Tool descriptions on `memory_search` / `memory_add` are intentionally verbose and list concrete trigger patterns — the failure mode for a new agent is "didn't call memory when it obviously should have", and short descriptions leave too much to the agent's judgment. The `clawdi` skill installed to `~/.claude/skills/clawdi/` (and the equivalent paths on other agents) reinforces the same triggers in long-form.

---

## What's not implemented

Several items were considered but not built. Named for discoverability if someone picks them up:

- **Celery / background tasks** — no async task queue. Memory is embedded synchronously on `memory_add`.
- **Session → Memory LLM pipeline** — sessions are just stored; nothing auto-extracts memories from transcripts. Users / agents add memories explicitly.
- **CronJobs** — no `cron_job` table, no scheduler. `scripts/embed_memories.py` exists as a manual operator-level tool.
- **Channels (Telegram / Discord / Slack bots)** — no code, no table.
- **Cognee memory provider** — only `Builtin` and `Mem0`.
- **Browser-based `clawdi auth login`** — the implemented flow is "paste your API key", same UX but no OAuth dance.
- **`bun build --compile` single-binary distribution** — currently `bun link` over the workspace.

If you pick any of these up, add an ADR or module plan under `docs/plans/` before implementing — this top-level doc is descriptive of what exists, not speculative.
