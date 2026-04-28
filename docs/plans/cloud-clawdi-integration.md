# Plan: clawdi-cloud as a unified agent dashboard

**Status:** v0.24 (round-9: connector flow unified through cloud-api; dropped IS_HOSTED proxy)
**Updated:** 2026-04-28

> **v0.24 addendum.** Earlier drafts split the connector flow: OSS
> mode hit cloud-api at `/api/connectors/*`, hosted mode hit
> clawdi.ai's existing backend at `/connections/*` cross-origin.
> That bypass was a bridge so cloud.clawdi.ai could ship before
> running its own cloud-api deployment. It's gone now. Both modes
> talk to cloud-api; cloud-api uses the user's Clerk id (not the
> local PG UUID) as the Composio `entity_id`, so a cloud.clawdi.ai
> deployment configured with clawdi.ai's existing Composio API key
> reads the same connection namespace clawdi.ai's old backend wrote.
> The frontend hosted/ directory now contains only what's genuinely
> hosted-exclusive: the agent-deploy listing and the sidebar Deploy
> CTA. See commits `26492f4` (backend entity_id switch) and
> `ff6ea65` (frontend single-source refactor).

## TL;DR

clawdi-cloud is a unified dashboard for managing AI agents wherever
they live: on our infrastructure, on a user's server, or on their
laptop. The core abstraction is the `clawdi` CLI as a universal
**middle layer** with adapters for each agent runtime (OpenClaw,
Hermes, Claude Code, Codex). Dashboard never directly speaks the
agent runtime's protocol — it always goes through CLI.

clawdi-cloud is OSS (MIT). We host one enhanced instance at
cloud.clawdi.ai. The hosted-exclusive features narrow to four:

1. We provision and run agent runtime on our k8s
2. Lifecycle UI (Restart/Stop/Start/Delete) for those agents
3. Pre-installed starter skills seeded on signup
4. Billing

Everything else — skills sync, sessions, memories, vault, MCP proxy,
direct-connect (chat/logs/native UI) — is universal across all
transports. Self-managed users get an indistinguishable experience
except they run the agent runtime themselves.

## Source-grounding status (verified 2026-04-24)

Every architectural assertion in this doc was cross-referenced
against actual source in `~/Programs/clawdi` (private clawdi.ai)
and `~/Programs/clawdi-cloud` (this repo) during round-8 codex
review. Summary:

**GROUNDED (exists in source today):**
- agent-image controller routes (health/files/logs/WS/Hermes/HTTP catch-all): `agent-image/controller/src/index.ts`
- Dashboard reaches pods via `Deployment.endpoints` + `gateway_token`: `apps/web/src/hooks/use-gateway-target.ts`
- 7 deploy endpoints (POST/GET/DELETE + restart/stop/start/onboard-agent + pairing-token): `backend/app/routes/deployments.py`
- `derive_gateway_token` HKDF-SHA256: `backend/app/services/crypto.py`
- CLI device-authorization flow: `clawdi-cloud/backend/app/routes/cli_auth.py`
- MCP proxy: `clawdi-cloud/backend/app/routes/mcp_proxy.py`
- agent_environments table (NB: model in `models/session.py`, not its own file): UUID id, columns user_id/machine_id/machine_name/agent_type/agent_version/os/last_seen_at
- api_keys table: id/user_id/key_hash/key_prefix/label/last_used_at/expires_at/**revoked_at already exists**
- Pairing-token endpoint serves messaging integrations (telegram/discord/whatsapp/imessage), NOT obsolete

**TO BUILD (proposed in this plan):**
- Cloud-api broker endpoints (`POST /api/agents/{env_id}/chat`, etc.)
- Tunnel session token + library_token + lease + heartbeat
- Connect-token endpoints (`POST /api/agent-connect-tokens`)
- redeem-deploy-token + ed25519 + jti single-use
- Migration epoch fencing
- Vault allowlist column + endpoint
- Clerk webhook `/api/webhooks/clerk` with svix verification (NEW — does not exist today)
- Gateway library extraction from existing controller (refactor)
- Schema additions: api_keys.{scopes, deployment_id, allowed_vault_uris}; agent_environments.{deployment_id, migration_epoch}; new tables tunnel_sessions / connect_tokens / redeemed_tokens / agent_environments_history

**TO PORT (existing UI in clawdi.ai, not rewrite):**
- Console UI (`apps/web/src/components/console/` — files/logs/terminal/public-ports)
- `agent-offline-state.tsx`, `use-hermes-target`, `use-hermes-client`, etc.

If you find an architectural claim in this doc that is NOT marked
above, treat it as un-verified and ground it before coding.

## Why this doc

To pin down the model and architecture before building. The design
went through eight iterations with codex pass reviews; this version
incorporates the final calls on naming, layer model, tunnel
architecture, and security primitives.

**On auth:** v1 uses Clerk for the dashboard and Clerk webhooks
for signup events (starter-skill seeding). Pluggable auth /
self-host SSO is intentionally deferred — *not* to v2 of this plan,
but to whenever a real customer asks for it. Treat "uses Clerk"
as a v1 implementation choice, not a long-term architectural
commitment.

**Auth setup for self-host:** OSS users running their own
clawdi-cloud must register their own Clerk application (free tier
covers up to 10k MAU). The exact steps:

1. Sign up at clerk.com → create new Application
2. In Clerk dashboard → API Keys → copy `Publishable Key` and
   `Secret Key`
3. In Clerk dashboard → Webhooks → create endpoint pointing at
   `https://<your-host>/api/webhooks/clerk` with event
   `user.created` enabled (this triggers starter-skill seeding if
   the self-hoster opts in via `ENABLE_STARTER_SKILLS=true`; off
   by default for OSS). **Note: this webhook receiver is new in
   Phase 4; clawdi-cloud today does NOT have `/api/webhooks/clerk`.
   We'll add svix signature verification + the `user.created`
   handler.** Until then, starter-skill seeding is lazy: the first
   time an authenticated user hits the dashboard with no skills,
   the seed handler runs synchronously.
4. In Clerk dashboard → Paths → set `Sign-in redirect URL` and
   `Sign-up redirect URL` to your host's `/`
5. In your clawdi-cloud `.env`:
   ```
   CLERK_PUBLISHABLE_KEY=pk_test_...
   CLERK_SECRET_KEY=sk_test_...
   CLERK_WEBHOOK_SECRET=whsec_...        # from step 3
   NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
   NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
   ```

We don't ship a default no-auth mode — running clawdi-cloud
without auth would expose an API that lets anyone create env_ids
and call the MCP proxy with another tenant's connectors. The
dashboard refuses to start without `CLERK_SECRET_KEY` set, with
an error pointing at the README's expanded version of these steps.

**Health check on first start.** Self-host's first `docker compose
up` runs an `/api/healthz` check that verifies in order:
`Database connected → Clerk keys valid → Clerk webhook reachable →
Migration up to date → Ready`. If any step fails, dashboard shows
which step is red and what to fix. Saves 30 minutes of debugging
for the typical self-hoster.

## The model: three control planes

clawdi-cloud is three independent control planes that compose:

| Plane | What it carries | Path | K8s analog |
|---|---|---|---|
| **State** | skills, memories, sessions, vault — the user's library | dashboard ↔ cloud-api ↔ CLI cron ↔ agent filesystem | desired state (kubectl apply) |
| **Direct-connect** | chat, tail logs, embedded native UI, future remote exec | dashboard ↔ cloud-api ↔ CLI tunnel ↔ agent runtime | exec / logs (kubectl exec/logs) |
| **MCP proxy** | Composio tool calls, OAuth, third-party API | agent ↔ MCP proxy ↔ cloud-api ↔ Composio | API proxy (kubectl proxy) |

Each plane has its own primary path, but they cross-cut in two
deliberate spots. State of those crosscuts:

- **`Sync now` button** (state plane convenience) signals the agent
  via the direct-connect tunnel to run `clawdi pull --sync`
  immediately. If the tunnel is down, the button is **disabled**
  with hover text *"Agent offline — will sync automatically on
  reconnect."* The cron pull resumes the moment the agent's CLI
  reconnects, so state always converges; users just lose the
  manual override during outages.
- **MCP proxy auth** rides on the agent's deploy api_key (state-plane
  credential). The tool-call traffic itself is its own plane.

Both crosscuts have a non-tunnel fallback so the state plane stays
functional under direct-connect outage.

```
                ┌────────────────────────────────────────────┐
                │            clawdi-cloud (dashboard)        │
                │   CRUD UI · Direct-connect surface · Grid  │
                └─────────────────────┬──────────────────────┘
                                      │ HTTPS (state) + WSS (tunnel)
                                      ▼
                                 cloud-api
                  ┌──────────────────────────────────────────┐
                  │  state authority (skills/etc)            │
                  │  tunnel registry (env_id → live WS)      │
                  │  MCP proxy (Composio runtime traffic)    │
                  └──────┬───────────────────┬───────────────┘
                         │                   │
                  ┌──────┴────┐       ┌──────┴────┐
                  │  CLI cron │       │ CLI WS    │
                  │  (state)  │       │ (tunnel)  │
                  └──────┬────┘       └──────┬────┘
                         │                   │
                         └─────────┬─────────┘
                                   ▼
                              clawdi CLI
                       (with adapter for runtime)
                                   │
                                   ▼
                            agent runtime
            (OpenClaw / Hermes / Claude Code / Codex / future)
```

## Transports & badges

The agent grid shows a binary badge for **operational
responsibility**, plus a separate Runtime field for the agent type.
Three values were considered (`Local`, `Self-hosted`, `On Clawdi`)
but conflated two orthogonal axes; collapsed to two:

| Badge | Who runs it | Direct-connect | Lifecycle UI |
|---|---|---|---|
| **On Clawdi** | We provision and run k8s pod | ✅ (CLI tunnel auto) | ✅ Restart/Stop/Start/Delete |
| **Self-managed** | User runs agent on their machine (server, VPS, laptop) | ✅ if user runs `clawdi serve` daemon | ❌ |

Runtime metadata (separate field, displayed inline):

```
• my-first-agent     [On Clawdi]      OpenClaw · Daemon    Synced 30s ago
• prod-openclaw      [Self-managed]   OpenClaw · Daemon    Synced 2m ago    vps.example.com
• macbook-codex      [Self-managed]   Codex · CLI          Last push 1h ago  macbook-pro
```

Three things compose to communicate state:

1. **Badge** = operational responsibility (us vs user)
2. **Runtime** = adapter type + mode (`OpenClaw · Daemon`, `Codex · CLI`)
3. **Hostname** (Self-managed only) = which physical machine

A daemon-mode agent (OpenClaw, Hermes) can run anywhere the user
has compute — laptop, VPS, home server. CLI-mode agents (Claude
Code, Codex) are inherently ad-hoc and have no daemon, no chat
endpoint. Direct-connect features apply only when the runtime
exposes the right endpoints, which the adapter declares.

## Hosted-only feature scope

Reduced to four items. Everything else is universal:

1. **Agent runtime provisioning.** We run the cluster. User clicks
   Deploy, gets a running agent. Self-managed users provision their
   own runtime (laptop install, VPS systemd unit, etc.).
2. **Lifecycle UI.** Restart / Stop / Start / Delete buttons that
   call clawdi-api (private deploy backend). Self-managed users
   restart their own daemon.
3. **Pre-installed starter skills.** New hosted users get 5–10
   useful skills seeded into their library on signup. Solves the
   cold-start "agent has no skills" problem on first deploy.
4. **Billing.** We charge for the compute we provide. clawdi.ai is
   the source of truth for plan/payment.

That's the full hosted-only list. Marketing copy: *"We run your
agent for you on Clawdi and seed it with starter skills. Everything
else works the same as if you ran it yourself."*

## State plane

### Skill sync contract (the v1 product commitment)

Skills changed in cloud-api land on every connected agent within
**60 seconds**. This is the user-facing SLA, surfaced in UI:

- Save toast: `"Saved. Will reach 3 agents within 60 seconds."`
- Per-agent sync indicator on the skill detail page:
  ```
  Used by 3 agents:
    • my-first-agent   Synced 12s ago
    • blog-writer      Synced 45s ago
    • debug-helper     Pending sync…    [Sync now]
  ```
- Manual `[Sync now]` button forces an immediate pull (sends a
  signal through the tunnel; CLI runs `clawdi pull --yes --sync`
  without waiting for cron).
- Failure: `Stalled · last synced 8m ago` badge with an inline
  retry button.

Mechanism: each connected CLI runs `clawdi pull --yes --sync` on a
60-second cron. The `--sync` flag puts pull in **sweep mode** — it
deletes local skills not present in cloud (cloud is authority for
the skills directory, pod is cache).

**Race / concurrency rules:**

- **Single-flight per agent.** CLI holds an in-process mutex; if a
  pull is already running, a triggered `Sync now` is a no-op (just
  logs "sync already in progress; current pull will reflect your
  edits"). Cron + manual + tunnel-signal all coalesce.
- **Server-side rate limit on `Sync now`.** cloud-api enforces
  3 manual syncs per minute per agent and 30 per minute per user.
  Excess returns `429 Too Many Requests` with `Retry-After`
  header; dashboard turns the button into "Synced recently" until
  the window passes. Single-flight on the CLI side coalesces;
  rate-limit on cloud-api prevents a buggy browser tab from
  amplifying that into thundering-herd CLI signals.
- **Last-applied revision tracking.** `GET /api/skills` returns each
  skill with `etag` and `updated_at`. CLI persists
  `(skill_key, last_applied_etag)` per agent. On pull, CLI
  re-downloads only when remote etag differs; sweep deletes only
  when remote list omits a key and local etag matches a known prior
  remote etag (we don't blow away unknown local additions —
  laptop's `clawdi push` is still authoritative for things created
  there).
- **Conflict resolution on save:** cloud-api's `POST /api/skills`
  is last-writer-wins on `(user_id, skill_key)`. We don't model
  branches; if two clients edit the same skill simultaneously, the
  later request wins. Document this in the editor UI: "Saved.
  Overrode previous version from 14:32." when an etag mismatch is
  detected on save.

Why 60s and not faster:
- `clawdi pull` makes one HTTP request per CLI; at 60s × N users ×
  M agents the load is bounded
- Users editing skills don't typically need <1s feedback (compare
  to chat where they do)
- `[Sync now]` covers the impatient case

Why not relying on agent restart: agent runtimes (OpenClaw, Hermes,
Claude Code, Codex) all read skill markdown from disk on each Skill
invocation, not at process startup. Writing a new file to the
skills dir is enough; no restart needed. Restart-to-pickup-skills
was an early misconception in this plan.

### Sessions plane

Pod-produced. `clawdi push --modules sessions` runs after each
session line is appended, batched up to N seconds. Push uses the
deployment's `api_key` with `sessions:write` scope.

**Persistence requirement:** the pod must mount a PVC at
`/var/lib/clawdi/sessions/` so that an OOM-killed or restarted pod
re-attaches its in-flight session log and resumes pushing. Without
this, an unfortunate restart drops the last session line.

Crash UI:

```
[⚠ Recovering] Agent restarted at 14:32:07. Resuming session sync.
```

After recovery banner clears, sessions list backfills with
pre-restart content.

### Memories plane

Same as sessions — pod-produced, pushed up. Read access works
through cloud-api for dashboard display.

### Vault plane

Two-direction:
- **Write/list/browse:** Clerk-JWT only (web dashboard). Never
  available to a deploy api_key.
- **Resolve at runtime:** `clawdi vault resolve clawdi://path` in
  the pod returns plaintext via the deploy api_key's
  `vault:resolve` scope.

**v1 scope: per-deployment allowlist (changed from earlier
"user-wide" framing after codex round-3 review).** A compromised
pod or malicious skill can enumerate likely `clawdi://` paths
immediately — this is not a hypothetical future risk; it's a
launch-day attack surface.

Schema:
- `api_keys.allowed_vault_uris: text[] NOT NULL DEFAULT '{}'` —
  **column ships in Phase 1** so the migration is in place before
  the rest. Today's `POST /api/vault/resolve` does not consult it.
- `vault:resolve` enforcement, the management endpoints
  (`GET/PUT /api/auth/keys/{id}/vault-allowlist`), and the
  dashboard UI all land **together in Phase 4** alongside the
  `scopes` column. Wiring enforcement before the management UI
  ships would silently break every existing CLI key (their
  allowlist defaults to `[]` = no access).

UX:
- Deploy dialog (Phase 4) gets a `Vault access` step: checkbox
  list of user's vault items; default none selected. Tooltip:
  *"This agent will only see items you check here."*
- `Connect a new agent` (self-managed) does the same in Phase 2.
- Agent detail page → Settings tab → `Vault access` section lets
  user grant/revoke items at any time. Revoke is immediate
  (api_key allowlist updated; pod's next `vault:resolve` for that
  URI returns 403).

Legacy CLI keys with `scopes IS NULL` continue to enjoy wide
access until their one-time scope migration (see "Legacy key
scope migration" below). New deploy keys + new self-managed keys
both get the allowlist treatment from day one.

### Protocol versioning (CLI ↔ cloud-api compatibility)

Every CLI request to cloud-api carries a header:

```
X-Clawdi-Protocol-Version: 1
X-Clawdi-CLI-Version: 0.4.0
```

cloud-api responds with `426 Upgrade Required + JSON body` if the
protocol version is unsupported (CLI too old AND no longer in the
N-1 window). Body includes `min_supported_version` and
`upgrade_url` pointing at the CLI install docs.

**N-1 compatibility commitment.** When we ship protocol v2,
cloud-api accepts both v1 AND v2 for at least 90 days. Within
that window, dashboard surfaces a banner per affected agent:
*"This agent's CLI is on protocol v1. Upgrade to v2 by [date]."*
After 90 days, v1 requests get rejected.

For hosted agents (we control the image), version skew is
self-resolving — the next image rebuild bumps everything. For
self-managed agents, the user runs `npm install -g clawdi@latest`.

This is in Phase 2 because it has to ship with the CLI tunnel:
v1.0 of the protocol is what we're locking in now.

### Other state-plane surfaces (existing today, unchanged)

This plan focuses on the **skill sync contract** because it's the
most visible state-plane addition (per-agent indicators, `[Sync now]`,
delete confirmation). The other state-plane surfaces already exist
in clawdi-cloud today and **stay unchanged** under this plan:

| Surface | Today's UX | Change in this plan |
|---|---|---|
| **Memories** page | List + search + create + delete | None |
| **Vault** page | Three-level (Vault → Section → Field) browse + edit | None |
| **Connectors** page (Composio) | OAuth connect flow, per-app tool listing, MCP config display | None |
| **Sessions** page | Per-agent transcript list + viewer | None — sessions backfill from PVC + push as before |

The CLI tunnel and three-plane model don't change these pages'
behavior. They keep working the same way for both `On Clawdi` and
`Self-managed` agents because they all run through cloud-api.

### State plane API surface (this repo)

```
GET  /api/skills                      list (paginated)
POST /api/skills                      upload tar
GET  /api/skills/{key}/download       download tar
DELETE /api/skills/{key}              delete

GET  /api/sessions                    list (paginated)
POST /api/sessions                    append line(s)
GET  /api/sessions/{id}               full transcript

GET  /api/memories                    list / search
POST /api/memories                    create
DELETE /api/memories/{id}             delete

GET  /api/vault/items                          list (Clerk only)
POST /api/vault/items                          create (Clerk only)
GET  /api/vault/items/{id}                     read plaintext (Clerk only)
POST /api/vault/resolve                        { uri } → { value }  (api_key with vault:resolve)

GET  /api/api-keys/{id}/vault-allowlist        list URIs this key can resolve (Clerk)
PUT  /api/api-keys/{id}/vault-allowlist        replace URI allowlist (Clerk)
                                               body: { uris: ["clawdi://path/...", ...] }
```

## Direct-connect plane

### Architecture (broker + extracted gateway library)

Earlier drafts framed direct-connect as "CLI tunnel as the
universal middle layer." Source-code review showed that today's
clawdi clawdi.ai agent-image already ships a **Hono-based controller
on port 18789** that handles chat / file-browse / tail-logs /
terminal / native UI proxying for hosted pods, with `gateway_token`
auth derived from `MASTER_KEY`. The dashboard at clawdi.ai/dashboard
calls it directly today. Replacing it wholesale with a CLI-tunnel
rewrite throws away tested compatibility logic.

The right architecture, validated against the controller source
(`~/Programs/clawdi/agent-image/controller/src/index.ts`):

1. **Extract the controller's reusable routes** (health / files /
   logs / WS proxy / Hermes proxy / native UI proxy) into a shared
   **agent-side gateway library** package.
2. **Run the library in three shells:**
   - Hosted agent-image: existing controller process, glue stays
   - Self-managed with agent-image: same controller process,
     optionally registered through tunnel
   - Bare self-managed (user installed OpenClaw on a VPS without
     our agent-image): `clawdi serve` embeds the library, exposes
     the same logical routes
3. **Cloud-api becomes a uniform broker.** Dashboard calls
   `POST /api/agents/{env_id}/chat`, `GET /api/agents/{env_id}/logs`,
   etc. Broker chooses transport per env: hosted pod's existing
   endpoint URL or the self-managed CLI tunnel. Dashboard is
   transport-blind; it always sees the same SSE stream / response.

```
                      Dashboard
                          │ HTTPS broker calls
                          ▼
                     cloud-api (broker)
              ┌───────────┴───────────────┐
              │ Hosted: reverse-proxy     │ Self-managed: tunnel
              │ to controller endpoint    │ over WSS
              ▼                           ▼
      controller (existing,           clawdi serve (CLI)
      18789, gateway_token)             │
              │                         ├── tunnel client → cloud-api
              │                         └── embeds gateway library
              └─→ shared library ←──────┤
                  (extracted from           library config injects:
                  controller — files,       file roots, log sources,
                  logs, WS, proxy)          local agent URLs
```

**Why this preserves the production controller:** the existing
controller's accumulated quirks (Hermes API/web routing, bearer
forwarding for `/v1/mux/inbound`, cookie auth, supervisor restart
on config write) stay in glue code. The library ships routes; the
controller process feeds it deployment-specific config.

**Multi-node posture stays the same as v0.21:** cloud-api runs
single-replica in v1; Redis-backed broker routing in v1.5.

### Library API surface

```ts
export interface ControllerLibraryConfig {
  stateRef: ControllerStateRef;
  cors?: { allowedOrigins: string[]; credentials?: boolean };
  files?: FileRouteConfig;       // injects FileRoot[] + auth
  logs?: LogRouteConfig;         // injects LogSource[] + auth
  httpProxies?: HttpProxyRoute[]; // each route → { target, stripAuth, ... }
  wsProxies?: WsProxyRoute[];    // terminal + gateway upgrade routing
  hermes?: HermesProxyConfig;    // optional second-port Hermes proxy
  nativeUi?: NativeUiProxyConfig; // mount path + base URL injection
}

export interface ControllerLibrary {
  handleHttpRequest(req, res): Promise<void>;
  handleUpgrade(req, socket, head): void;
}

export function createControllerLibrary(
  config: ControllerLibraryConfig
): ControllerLibrary;
```

Each route group accepts injected dependencies (auth verifier,
file roots, log sources, proxy targets) so neither container paths
nor `clawdi serve`'s local-machine paths are baked in.

### Library vs glue partition

| Concern | Library | Glue (controller / `clawdi serve`) |
|---|---|---|
| Health route | ✅ | State transitions on listen |
| File routes (read/write/tree/backup) | ✅ | `FileRoot[]` injection |
| Log routes (tail/list) | ✅ | `LogSource[]` registry |
| HTTP proxy primitives | ✅ | Route order + targets |
| WS upgrade primitives | ✅ | Terminal vs gateway classification |
| Hermes proxy primitives | ✅ | Port / supervisor restart hook |
| Native UI proxy primitives | ✅ | `baseUrl` from local agent discovery |
| CORS check | ✅ | `allowedOrigins` from env / config |
| Auth (token verify) | ✅ | Token issuance + expiry |
| Process lifecycle | ❌ | Each shell owns its server bind/exit |
| Supervisor / `/data/*` paths | ❌ | Hosted-only; glue injects |

### Transport: hosted vs self-managed

**Hosted:** broker reverse-proxies dashboard requests to the pod's
controller endpoint (read from `Deployment.endpoints[]` and
authed with `gateway_token`). Browser never sees the
container-internal address; CSP and cookies are scoped to the
broker origin.

**Self-managed:** broker routes through a WSS tunnel that
`clawdi serve` keeps open to cloud-api. The library inside
`clawdi serve` answers requests as if it were a local controller.

Per codex round-7 design call: broker **always** returns SSE for
chat/logs and proxied HTML/assets for native UI. We considered
the "mint a browser-direct descriptor" pattern for hosted to skip
the broker hot path, but rejected it — it would re-leak transport
specifics into dashboard code and re-introduce the
`gateway_token` exposure pattern we're moving away from.

### Stdio adapters (Claude Code / Codex)

These have no daemon, no library shell, no remote chat surface.
Dashboard hides Chat / Logs / Native UI tabs for them. They
remain part of the state plane (sessions / memories sync) only.

### Tunnel session token (self-managed only)

For hosted pods, the existing `gateway_token` (HKDF-derived from
`MASTER_KEY`) keeps working — the controller is reachable at
`{deployment.endpoint}:18789` via cloud-api's broker. No new
token primitive needed.

For **self-managed** users running `clawdi serve`:

```
1. CLI startup → POST /api/tunnel/session  (Authorization: Bearer api_key)
2. cloud-api validates api_key + checks tunnel:proxy scope
3. cloud-api mints (and returns once):
   - tunnel_session_token: env-bound, session_id-bound, 24h TTL,
     endpoint allowlist; persisted (hashed) in tunnel_sessions
   - library_token: HKDF-SHA256 derivation
       ikm = tunnel_session_token (raw)
       salt = session_id
       info = "clawdi-library-auth-v1"
       len = 32 bytes
     The CLI passes library_token to its embedded
     `createControllerLibrary({ auth: { expectedToken: library_token } })`
4. CLI uses tunnel_session_token for the WS handshake (not api_key)
5. Cloud-api sends nonce challenge; CLI signs with the session
   token to prove handshake freshness
6. Each broker request through the tunnel is checked against:
   tunnel_sessions.revoked_at IS NULL AND now() < expires_at AND
   endpoint in allowlist. Append audit log entry.
```

The `library_token` derivation lets the controller library
verify each request without cloud-api having to forward a separate
header — same primitive as the hosted `gateway_token`, just minted
per-session instead of HKDF'd from a long-lived master key.

**Honest scope of the nonce defense:** the nonce only defends
against handshake replay (capturing a successful handshake and
replaying it from another machine). It does NOT defend against
token theft — an attacker holding the actual `tunnel_session_token`
can answer fresh nonce challenges normally, the same way the
legitimate CLI does. Token-theft defense rests on:
1. TLS encryption (token never crosses the wire in cleartext)
2. 24h hard cap (limited blast radius)
3. Active revocation via `tunnel_sessions.revoked_at`
   (`POST /api/tunnel/sessions/{id}/revoke` — called when user
   clicks Disconnect in Settings, or when admin actions trigger)
4. Per-endpoint allowlist (token can be minted with only
   `chat`, only `logs`, only `native-ui`, etc.)

**Token expiry while WS is open.** When `expires_at` passes during
an active connection, cloud-api closes the WS with code 4001
(`Token expired`). CLI catches this, refreshes by re-calling
`POST /api/tunnel/session`, reconnects with the new token. Whole
cycle is invisible to the user as long as it completes within
~5 seconds.

**Disconnect button (Settings).** Calls
`POST /api/tunnel/sessions/{id}/revoke` → sets `revoked_at = now()`
→ cloud-api closes the WS immediately with code 4002 (`Revoked`).
CLI on that machine receives the close and exits with explicit
log message; does NOT auto-reconnect (operator must restart it).

Why not raw api_key over WS: api_key is the master credential
covering all state-plane scopes for the user. tunnel_session_token
is env-scoped, 24h-bound, revocable, endpoint-allowlisted — much
narrower blast radius if compromised.

New scope: `tunnel:proxy` on api_keys. Deploy keys minted via
redeem-deploy-token get it by default; legacy CLI keys with
`scopes IS NULL` keep wide access (backwards-compat).

### Connection lease

`tunnel registry` entries are stored as **leases**: `(env_id,
cli_instance_id, expires_at)`. Lease TTL = 90s, refreshed on each
heartbeat (30s).

Edge cases:

| Scenario | Behavior |
|---|---|
| CLI connects with fresh env_id | Mint lease, register tunnel |
| CLI reconnects (same env_id, same instance_id) | Refresh existing lease |
| CLI connects (same env_id, different instance_id) | **Last-writer-wins**: revoke old lease, send `Replaced by another instance` over old WS, register new |
| Heartbeat misses 90s | Lease expires, env marked offline, dashboard direct-connect buttons grey out |

### Resumable streams

Every dashboard direct-connect request carries a `request_id`. If
the WS drops mid-stream, dashboard reconnects and re-issues the
same `request_id`; CLI either:
- Returns `cancelled` if the upstream agent already finished
- Resumes streaming from the last known offset (chat) or from
  current tail position (logs)

Without this, every reconnect would lose mid-flight chat output —
ugly UX for a 30-second agent reasoning step.

### Failure modes catalog

| Scenario | Dashboard sees | CLI does | Recovery |
|---|---|---|---|
| WS drops mid-chat | "Reconnecting…" toast | Auto-reconnect (1s, 2s, 4s, … 60s cap) | Retry request with same `request_id` |
| cloud-api restart | "Agents reconnecting" briefly | All daemons reconnect in 30s | Automatic |
| Pod OOM | Agent badge flips offline | Pod dies; k8s restarts; new CLI re-establishes | Within ~30s |
| Laptop sleep | Agent goes offline | WS drops on sleep, reconnects on wake | Automatic |
| Same env_id from two CLIs | Old CLI gets `Replaced` message | First CLI exits with explicit error | Operator deals with it |

### Direct-connect API surface (this repo)

```
POST /api/agent-connect-tokens             mint single-use connect token (Clerk JWT)
  body: { agent_type, vault_allowlist?: string[] }
  → 201 { token, expires_at }

POST /api/auth/redeem-connect-token        consume token, return api_key (no auth)
  body: { token, machine_id, hostname }
  → 200 { api_key, env_id, scopes, vault_allowlist }
  → 410 if expired/already redeemed

POST /api/tunnel/session                   mint tunnel_session_token (Bearer api_key)
  body: { endpoint_allowlist?: string[] }    # default ["chat","logs","native-ui","exec"]
  → 200 { token, expires_at, session_id }

POST /api/tunnel/sessions/{id}/revoke      revoke active tunnel token (Clerk JWT)
  → 204

WS   /api/tunnel/connect                   CLI WebSocket handshake
  protocol header: Sec-WebSocket-Protocol: clawdi-tunnel.v1
  authorization: Bearer <tunnel_session_token>
  first server frame: { type: "challenge", nonce }
  client response:    { type: "challenge_ack", signature }
  then bidirectional JSON frames:
    server → client: { type: "request", request_id, endpoint, payload }
    client → server: { type: "response", request_id, status, payload }
                     | { type: "stream_chunk", request_id, payload }
                     | { type: "stream_end", request_id }
                     | { type: "heartbeat" }

POST /api/agents/{env_id}/chat             SSE stream
  body: { request_id, message, session_id?, agent_id? }
  → 200 text/event-stream
       event: start  data: { request_id, env_id, adapter, session_id }
       event: delta  data: { request_id, text }
       event: tool   data: { request_id, name, status, payload }
       event: error  data: { request_id, error, detail }
       event: done   data: { request_id, session_id, usage }
  → 404 env_not_found / 409 agent_offline / 422 chat_unsupported
  → 423 migration_in_progress / 502 tunnel_request_failed

GET  /api/agents/{env_id}/logs             SSE stream of tail logs
  query: ?source=<id>&lines=<n>&follow=true
  → 200 text/event-stream:
       event: line   data: { source, line, timestamp }
  → 404 / 409 / 422 logs_unsupported / 423 / 502

GET  /api/agents/{env_id}/files/tree       file tree from injected roots
  query: ?root=<key>&path=<rel>
  → 200 { tree }
  → 404 / 409 / 422 files_unsupported / 423 / 502

GET  /api/agents/{env_id}/files/read       file contents
  query: ?root=<key>&path=<rel>
  → 200 { content, etag }
  → 404 / 409 / 422 / 423 / 502

PUT  /api/agents/{env_id}/files/bytes      upload
  body: binary
  → 200 { path, size }
  → 404 / 409 / 422 / 423 / 502

GET  /api/agents/{env_id}/native-ui/{path*} same-origin iframe proxy
  Broker proxies HTML/assets/WS, overwrites CSP and X-Frame-Options
  to scope frame-ancestors to the dashboard origin. Browser never
  sees the underlying loopback or pod URL.
  → 200 proxied / 404 / 409 / 422 native_ui_unsupported / 423 / 502

WS   /api/agents/{env_id}/terminal          WS tunnel to ttyd or similar
  → ws if adapter exposes terminal / 422 terminal_unsupported

All endpoints require Clerk JWT for ownership check; broker
selects transport (hosted controller vs self-managed tunnel)
internally based on the env's current state. Dashboard never
chooses transport.
```

## MCP proxy plane

Already exists. Pod's agent runtime makes outbound MCP tool calls
to cloud-api's MCP proxy endpoint (`/api/mcp/proxy`) with its
deploy api_key + `mcp_token`; cloud-api proxies to Composio.

**One change in this plan: Composio token rotation handling.**
When Composio rotates an OAuth token mid-session (rare but real),
cloud-api's MCP proxy returns a structured error to the agent
rather than an opaque tool failure:

```json
{
  "error": "connector_reauth_required",
  "connector": "gmail",
  "reauth_url": "https://cloud.clawdi.ai/connectors/gmail/reauth"
}
```

The agent runtime surfaces this to the session transcript
("Gmail connector needs reauth — visit dashboard"), and the
Connectors page in dashboard shows a `[Reauth needed]` badge on
the affected connector. Without this, agents fail tool calls
silently and the user can't tell why.

For completeness, the existing flow:

```
agent runtime ──▶ MCP proxy URL ──▶ cloud-api /api/mcp/proxy ──▶ Composio
                                              │
                                              └─ resolves user's connected
                                                  account credentials,
                                                  routes by tool name
```

`mcp_token` is provisioned in the pod's environment by the redeem
flow alongside the `api_key`.

### Composio cross-origin proxy (hosted only)

Composio identity is keyed on `(api_key, entity_id)`. A user
connecting Gmail in clawdi.ai/dashboard stores tokens under
`(composio_api_key, clerk_id)`. For cloud.clawdi.ai to surface
those same connections, hosted users **proxy all `/connectors`
calls cross-origin to clawdi.ai's existing `/connections`
API** rather than running a parallel Composio client.

Cloud's own `backend/app/services/composio.py` and `routes/connectors.py`
keep working for OSS / self-host users — they call their own
Composio API key with `auth.user_id` (local UUID) as the entity.
Hosted users skip cloud-api entirely for connectors.

**Why proxy beats migrate:**

The naive "unify entity_id to clerk_id everywhere" plan fails for
OAuth callback portability. Composio's
`connected_accounts.initiate(integration_id, entity_id, redirect_url=...)`
SDK takes `redirect_url` as a per-request parameter
(`composio/client/collections.py:284` in the 0.7.21 release), so
*new* connections can callback wherever you want. But existing
tokens can't be transferred — Composio has no token-rename API.
Migrating means forcing every user to re-OAuth every connection.
Proxy avoids that entirely: clawdi.ai's existing
`clerk_id`-keyed connections stay where they are; cloud reads/
mutates the same store via cross-origin call.

**Per-request callback URL:**

clawdi.ai's `POST /connections/{app_name}/connect` already accepts
`body.redirect_url` (`backend/app/routes/connections.py:481-506`)
and validates against `_ALLOWED_REDIRECT_SCHEMES = {"https", "exp", "clawdi"}` —
any HTTPS host passes, so cloud passes
`redirect_url=https://cloud.clawdi.ai/connectors/<app>` (the connector's
own detail page) and the user lands back on cloud after OAuth, not
clawdi.ai. The token itself is still stored under the user's
`clerk_id` entity, so both products see the connection. No
intermediary callback route — react-query refetches on mount in the
new tab and on focus in the original. UX matches the product the
user clicked from.

**Architecture:**

```
       cloud.clawdi.ai (cloud-web)
              │
              ├─ IS_HOSTED=true
              │   └─ apps/web/src/hosted/clawdi-api.ts (shared client)
              │       └─ cross-origin → clawdi.ai/connections/*
              │           └─ entity_id = user.clerk_id
              │           └─ redirect_url = cloud.clawdi.ai/connectors/<app>
              │
              └─ IS_HOSTED=false
                  └─ /api/connectors (cloud-api)
                      └─ entity_id = user.id (local UUID)

       clawdi.ai — owns Composio data + OAuth callbacks
              ├─ /connections/* (already exists)
              └─ CORS: cloud.clawdi.ai included via PR #424
```

**Cross-origin auth:** same Clerk JWT pattern as the deploy listing.
clawdi.ai's `get_current_user` accepts the `cloud.clawdi.ai`-issued
Clerk token because both apps use the same Clerk project. No
service-to-service tokens, no audience juggling.

**OSS / self-host users:** unchanged. `IS_HOSTED=false` keeps
cloud's own `/api/connectors` endpoints active. Their entity_id
stays `user.id` (local UUID), their Composio API key is theirs,
their OAuth callbacks point to their own host. Two independent
worlds; the cross-origin proxy only swaps in for hosted.

## Onboarding & first-day UX

The opinionated first-90-seconds for a new hosted user.

### T+0s: signup completes

Land on Dashboard with a Welcome card:

```
┌──────────────────────────────────────────────────────────┐
│ Welcome to Clawdi.                                  [×]  │
│                                                          │
│ You have 7 starter skills ready to use:                  │
│   Code review · Debug Python · Web scraper · Refactor    │
│   Doc summary · SQL helper · Git assistant               │
│                                                          │
│ Deploy your first agent and try them →                   │
│                          [Deploy a new agent]            │
│                                                          │
│ Or browse your skill library, edit them, add your own.   │
│ Already have an agent on your own server or laptop?      │
│ Connect it →                                             │
└──────────────────────────────────────────────────────────┘
```

**Welcome card lifecycle (locked):**

- Shown on Dashboard when `user_settings.welcome_dismissed = false`
  AND user has zero agents
- `[×]` dismiss button sets `welcome_dismissed = true`; never shows
  again
- Auto-dismiss when first agent appears (deploy or connect)
- OSS users: same logic, but no starter-skills line (the line
  reads "Connect your first agent to get started")
- Returning users (existing accounts before this ships):
  `welcome_dismissed = true` migrated as default — they don't see
  the card

**Agent grid empty state (post-dismiss, still zero agents):**

When the user dismisses the Welcome card without deploying or
connecting, the agent grid replaces it with a quieter empty state:

```
┌──────────────────────────────────────────────────────────┐
│ No agents yet.                                           │
│                                                          │
│ [Deploy a new agent]   [Connect an existing one]         │
└──────────────────────────────────────────────────────────┘
```

This catches the user who dismissed Welcome by reflex but actually
wants to use the product. Disappears the moment any agent exists.

**Seeding states (hosted only):**

- **Seeding in flight** (Clerk webhook just fired, copy job
  running): card shows skill names but `[Deploy a new agent]`
  button is disabled with tooltip *"Setting up your starter
  skills…"* The window is short (sub-second to a few seconds).
- **Seeding failed** (rare; webhook retry exhausted): card shows
  *"We couldn't load your starter skills. [Retry]"* — manual retry
  re-runs the upsert. Deploy still works without starters.
- **Seeding succeeded**: normal card as shown above.

### T+15s: click Deploy a new agent

Dialog fields for v1 (locked, not "mirror existing"):

- **Runtime** — radio: OpenClaw / Hermes (the two daemon-mode
  agents we support on Clawdi v1)
- **Name** — text, max 40 chars, must be unique within user's
  agents
- **Resource size** — radio: Small / Medium (defer Large until
  pricing tiers exist). Translates to fixed CPU/memory in
  clawdi-api.

Other fields from clawdi.ai/dashboard's existing form (env vars,
custom commands, network policies) are NOT in the v1 dialog; users
who need them stay on clawdi.ai/dashboard until we promote them.

```
┌──────────────────────────────────────────────────────────┐
│ Deploy a new agent on Clawdi                             │
│                                                          │
│ We'll run this agent on Clawdi's infrastructure with     │
│ your starter skills pre-loaded.                          │
│                                                          │
│ Runtime: ● OpenClaw  ○ Hermes                            │
│ Name:    [my-first-agent              ]                  │
│ Size:    ● Small (1 vCPU, 2 GB)  ○ Medium (2 vCPU, 4 GB) │
│                                                          │
│ Vault access (defaults to none):                         │
│   ☐ clawdi://github/personal-token                       │
│   ☐ clawdi://openai/api-key                              │
│   ☐ clawdi://db/prod-password                            │
│   This agent can only resolve items you check.           │
│                                                          │
│ Will run in us-west-2 (multi-region coming later)        │
│                                                          │
│              [Cancel]    [Deploy →]                      │
└──────────────────────────────────────────────────────────┘
```

### T+30s: deploy in flight

Dialog closes; user lands on agents grid showing the new agent
with a multi-stage status:

```
• my-first-agent     [On Clawdi]   OpenClaw · Daemon   Provisioning…
                                                       ↓
                                                       Connecting tunnel…
                                                       ↓
                                                       Pulling skills…
                                                       ↓
                                                       Ready
```

Each transition is observable; if any step fails, the badge shows
a specific error (`Provision failed: out of capacity` /
`Skill sync failed`) with retry where applicable.

### T+90s: agent ready, first session

The moment the new agent reaches `Ready`, the dashboard
**auto-navigates** the user to the agent detail page (only on the
first deploy; subsequent deploys leave the user where they were).
The Chat tab is highlighted as the recommended first action with
a one-line tip: *"Say hi to your new agent."*

Sessions tab is empty. The empty state has a `Start a session →`
CTA that:

- For **daemon-mode** runtimes (OpenClaw / Hermes) — opens the
  Chat tab directly (Phase 3), so the user can talk to the agent
  in the dashboard. First message → first session row appears in
  the Sessions tab as soon as `clawdi push` lands the first line.
- For **CLI-mode** runtimes (Claude Code / Codex) — shows a
  terminal-command panel: *"Run `claude code` (or `codex`) on the
  machine where you ran `clawdi auth login`. Sessions will appear
  here as soon as you `clawdi push`."*

Sessions backfill within seconds of the first push (sub-batched).

### Connecting an existing self-managed agent

Settings → Agents → `Connect a new agent` opens a panel. **Step 1
of the panel asks the user which agent runtime they're connecting**
— the install commands differ between daemon-mode and CLI-mode.

```
┌──────────────────────────────────────────────────────────┐
│ What are you connecting?                                 │
│                                                          │
│ ● OpenClaw / Hermes      (always-on agent, full chat)    │
│ ○ Claude Code / Codex    (CLI tool, sync only)           │
│                                                          │
│                                       [Generate token →] │
└──────────────────────────────────────────────────────────┘
```

UI then mints a connect token:

```
POST /api/agent-connect-tokens   (Clerk JWT)
  body: {
    agent_type: "openclaw" | "hermes" | "claude-code" | "codex",
    vault_allowlist: ["clawdi://path/...", ...]   # default []
  }
  scopes: ["agent:register"]
  expires: now + 5min
  → returns: { token: "clk_kxfk31..." , expires_at }
```

The Connect dialog has the same vault checkbox UI as the Deploy
dialog. The chosen URIs become the new api_key's
`allowed_vault_uris` when the user redeems the token via
`clawdi auth login`.

Token is single-use; once `clawdi auth login` consumes it,
cloud-api swaps it for a long-lived api_key. Scope set depends on
the declared agent_type:

| agent_type | Daemon needed? | api_key scopes |
|---|---|---|
| openclaw, hermes | yes | sessions:write, skills:read, skills:write, memories:write, vault:resolve, mcp:proxy, tunnel:proxy |
| claude-code, codex | no | sessions:write, skills:read, skills:write, memories:write, vault:resolve, mcp:proxy (NO tunnel:proxy) |

**For daemon-mode (OpenClaw / Hermes):**

```bash
# On your server or laptop:
npm install -g clawdi
clawdi auth login --token clk_kxfk31...    # 5-min expiry
clawdi serve                                # start the daemon
```

Plus a "Run as a systemd service" tab with this unit file:

```ini
[Unit]
Description=Clawdi agent daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/clawdi serve
Restart=on-failure
User=clawdi

[Install]
WantedBy=multi-user.target
```

**For CLI-mode (Claude Code / Codex):**

```bash
# On your laptop:
npm install -g clawdi
clawdi auth login --token clk_kxfk31...    # 5-min expiry
# Use clawdi push/pull as needed; no daemon to run.
clawdi push                                 # upload existing sessions
clawdi pull                                 # fetch your skill library
```

No `clawdi serve`, no systemd. CLI-mode agents don't have a remote
chat surface, so the dashboard's Chat/Logs tabs auto-hide for them.

If 5 min lapses without redemption, panel shows `[Generate new
token]`. Once redeemed, panel shows the new agent in the
**Connected agents** list — under the *Daemons* subsection if it
ran `clawdi serve`, or under the *CLI-mode* subsection with a
`Last push X ago` indicator if it didn't.

## Skill edit sync UX (the polish that matters)

Three places the sync contract is surfaced:

### 1. On Save

```
✓ Saved. Will reach 3 agents within 60 seconds.        [View status]
```

`[View status]` deep-links to the per-agent sync indicator on the
skill detail page.

### 2. Skill detail page

```
─── Used by 3 agents ──────────────────────────────────────
   ● my-first-agent      Synced just now
   ● blog-writer         Synced 45s ago
   ◐ debug-helper        Pending sync…              [Sync now]
   ─ test-agent          Offline since 14:08         (no sync)
─────────────────────────────────────────────────────────────
```

States:
- `●` (green) — Synced within last 90s
- `◐` (amber) — Pending (cron has not run since save; tunnel up
  OR last-known-online within 60s)
- `─` (gray) — Offline (no tunnel for >5min; will sync on reconnect)
- `!` (red) — Stalled (tunnel up; pull attempted but errored 3+
  consecutive times — e.g. CLI permission error, disk full,
  malformed skill blob)

Note: `Sync now` is disabled when tunnel is gray (offline). Stalled
is a different state — tunnel is reachable but pull is failing for
some other reason; `[Sync now]` stays enabled and re-tries.

`[Sync now]` is per-agent; force-pushes a tunnel signal that runs
`clawdi pull --yes --sync` immediately.

### 3. Delete confirmation

```
┌──────────────────────────────────────────────────────────┐
│ Delete "Code review"?                                    │
│                                                          │
│ Used by 3 agents:                                        │
│   • my-first-agent  • blog-writer  • debug-helper        │
│                                                          │
│ After delete:                                            │
│   ✓ Skill removed from your library                      │
│   ✓ Skill removed from all 3 agents within 60s           │
│   ⚠ Running sessions that already loaded this skill may  │
│     finish using their cached copy                       │
│                                                          │
│              [Cancel]   [Delete from all]                │
└──────────────────────────────────────────────────────────┘
```

The "Used by N agents" preview is mandatory before delete — it's
the only protection against accidentally pulling a load-bearing
skill out from under a running fleet.

## Lifecycle UX (On Clawdi only)

Located on the agent detail page header:

```
my-first-agent   [On Clawdi]   OpenClaw · Daemon   Ready
                                       [Restart]  [Stop]  [⋯]
```

`[⋯]` menu: `Stop` / `Delete` / `Migrate this agent…`.

### Restart confirmation

```
Restart my-first-agent?

  • Current sessions will be interrupted
  • The agent will be unreachable for ~30 seconds
  • Use this if the agent is stuck, or after a CLI / image
    upgrade. Editing skills does NOT require a restart — those
    sync within 60 seconds automatically.

         [Cancel]   [Restart]
```

The "skills don't need this" line is in the modal because users
intuit "if I edit, I should restart" from other systems. Naming
the wrong intuition explicitly is cheaper than letting them form
the habit.

### Status transitions

Hosted pods are reachable from cloud-api via reverse-proxy
(`Deployment.endpoints[i]:18789` + `gateway_token`), NOT a tunnel —
see Phase 4 below. Statuses reflect k8s + state-sync, not WS health:

| Status | Meaning |
|---|---|
| `Provisioning…` | k8s scheduling pod |
| `Pulling skills…` | `clawdi pull --sync` foreground; gateway up |
| `Ready` | Agent runtime exec'd, gateway reachable, sync complete |
| `Restarting…` | User-initiated restart in flight |
| `Stopped` | k8s replica count = 0; user clicked Stop |
| `Disconnected` | Reverse-proxy probe failing >5min; investigate |
| `Failed: <reason>` | Provision/start failed; retry available |

(Self-managed agents have an additional `Connecting tunnel…` /
`Reconnecting…` pair driven by `tunnel_sessions.revoked_at` and
WS heartbeat — same data plane as the dashboard already reads
today, just surfaced more explicitly.)

### Entrypoint sequence (locked)

Pod's `entrypoint.sh` runs in this exact order. Skill pull happens
BEFORE the agent runtime exec so the agent sees a hydrated
`/skills/` mount on first request. Cloud-api watches the gateway's
`/health` over the reverse-proxy to flip status from
`Provisioning…` → `Pulling skills…` → `Ready`.

```bash
#!/bin/bash
set -euo pipefail

# 1. Authenticate (consume registration token if first boot)
clawdi auth bootstrap

# 2. Hydrate skills before agent runtime starts. Block.
clawdi pull --yes --sync --modules skills

# 3. Trap SIGTERM to gracefully flush pending session pushes
#    before agent runtime exits. Gives ~30s to drain queue.
trap 'kill -TERM $AGENT_PID; clawdi push --flush --timeout 30s' SIGTERM

# 4. Exec the actual agent runtime. PID 1 in container.
exec_agent_runtime &
AGENT_PID=$!
wait $AGENT_PID
```

K8s manifest must set `terminationGracePeriodSeconds: 35` (5s
buffer over the CLI's 30s flush deadline) so SIGKILL doesn't fire
before flush completes.

### Graceful shutdown

`clawdi serve` and `clawdi push` both handle SIGTERM:

- **`clawdi serve`** drains the tunnel — finishes any in-flight
  request, sends WS close (code 1001 `Going Away`), exits 0.
  Dashboard shows agent as `Disconnected` immediately.
- **`clawdi push --flush --timeout 30s`** drains the in-memory
  session-line queue with up to 30s budget. Lines that don't make
  it within budget remain on the PVC; on next start, push picks
  them up from disk.

Without this, an unfortunate restart drops the last batch of
session lines that were in memory but not yet POSTed. The PVC
persistence + flush combo guarantees no session data loss across
graceful restart.

## Agent migration (transport + runtime swap)

clawdi's middle-layer architecture decouples three things:
- **Agent identity** (`agent_environments.id`)
- **Where it runs** (transport: On Clawdi / Self-managed)
- **What runtime executes** (OpenClaw / Hermes / etc.)

Migration walks that decoupling: change one or both of the latter
two without disturbing the first. Sessions, memories, vault refs,
connector access, and skill library all stay attached to the
stable `env_id`.

This is also the OSS-first promise made concrete. Users can move
from `On Clawdi` to `Self-managed` and take their agent with them
— no export/import, no data lock-in, just a transport flip.

### Migration matrix

**v1 scope: transport-only migration (same runtime).** Cross-runtime
swap (e.g., OpenClaw → Hermes) is deferred to v1.5 because skill
format compatibility adds non-trivial complexity that doesn't earn
its weight in v1.

| From | To | Status | Mechanics |
|---|---|---|---|
| Hosted OpenClaw | Self-managed OpenClaw | **v1** | Tear down pod → user runs `clawdi serve` locally → tunnel lease takes over |
| Self-managed OpenClaw | Hosted OpenClaw | **v1** | Provision hosted pod → its `clawdi serve` claims lease → user's old daemon disconnected |
| Hosted Hermes | Self-managed Hermes | **v1** | Same mechanics as OpenClaw row |
| Self-managed Hermes | Hosted Hermes | **v1** | Same mechanics as OpenClaw row |
| Hosted OpenClaw | Hosted Hermes | **v1.5** (cross-runtime) | clawdi-api swaps pod image; needs skill compatibility check |
| Self-managed OpenClaw | Self-managed Hermes | **v1.5** (cross-runtime) | User stops daemon, installs Hermes, restarts `clawdi serve` |

What stays the same in every v1 case: `env_id`, sessions,
memories, skills (same format both sides), vault refs, connectors.

The strategic promise — *"your agent's data is yours; transport
is interchangeable"* — is fully delivered by v1's transport-only
migration. Cross-runtime swap is a quality-of-life improvement we
add once we see real demand.

### Migration dialog UX

Agent detail page → `[⋯]` menu → `Migrate this agent…`.

**Single-step dialog (v1 — transport-only, same runtime):**

```
┌──────────────────────────────────────────────────────────┐
│ Migrate "my-prod-agent"                                  │
│ Currently: On Clawdi · OpenClaw                          │
│                                                          │
│ Where should it run?                                     │
│   ○ On Clawdi (we run it for you)        ← current       │
│   ● Self-managed (you run it on your machine)            │
│                                                          │
│ Runtime stays the same: OpenClaw                         │
│ (Cross-runtime swap coming in a later release.)          │
│                                                          │
│ What carries over:                                       │
│   ✓ All sessions (1,247 lines)                           │
│   ✓ All memories (38 entries)                            │
│   ✓ All skills (5)                                       │
│   ✓ Vault references                                     │
│   ✓ Connector access (Gmail, Notion)                     │
│                                                          │
│ What does NOT carry over:                                │
│   ✗ In-flight session (will be flushed and ended)        │
│   ✗ Cached runtime state (resets to fresh start)         │
│                                                          │
│ ⚠ Skill push behavior changes:                           │
│   Hosted agents do NOT push skills back from the daemon. │
│   Edit skills in Clawdi Cloud — they sync down to your   │
│   agent. (For Self-managed → Hosted: your existing       │
│   `clawdi push` from the daemon will start returning     │
│   permission errors after migration.)                    │
│                                                          │
│ Estimated downtime: ~45 seconds                          │
│                                                          │
│              [Cancel]              [Migrate now]         │
└──────────────────────────────────────────────────────────┘
```

Same runtime means **no skill compatibility check**, **no
multi-step compatibility wizard** — the migration is a clean
transport swap. The skill library, exact same format, points at
the new transport via the same `env_id`.

When v1.5 ships cross-runtime swap, the dialog adds a second step
with a per-skill compatibility matrix using each adapter's
`validateSkillForRuntime(skill, runtime)` method (extension to
the adapter contract — see appendix).

### Preflight check (before any migration commits)

Before clawdi-api commits to teardown / provision, the migration
endpoint runs a **preflight** to catch foreseeable failures:

| Migration | Preflight checks |
|---|---|
| Hosted → Self-managed | None on cloud-api side (target machine is user's; they run preflight by actually starting their daemon and getting `Connected` status before dashboard offers `Confirm migration`). |
| Self-managed → Hosted | clawdi-api capacity available for chosen size; user's billing plan permits another hosted agent; deploy-token signing key reachable. |
| Either direction | env_id is in `Ready` state (no in-flight migration, no failed-state lock). User has `tunnel:proxy` scope on a recent api_key. |

Preflight failures show as a non-destructive `[Cancel]` /
`[Try again]` dialog with the specific blocker. Migration only
commits irreversible work after preflight passes.

### Status during migration

```
my-prod-agent  [Migrating]  Stopping On Clawdi runtime…
                            ↓
                            Waiting for Self-managed daemon…
                            ↓
                            Lease handover…
                            ↓
                            Ready
```

For Self-managed → Hosted, the sequence is:
`Provisioning → Connecting tunnel → Pulling skills → Lease handover
→ Ready`. The user's old daemon receives `Replaced by another
instance` between the last two steps.

The status copy stays runtime-agnostic — never says `OpenClaw →
Hermes` or any cross-runtime language in v1.

### Status: `Migrating…`

A new lifecycle state. While migration is in flight, agent grid
shows the runtime-agnostic copy from the "Status during migration"
section above. No copy ever names a different runtime in v1
(cross-runtime arrives in Phase 7).

If migration fails partway, env is left in `Migration failed:
<reason>` state with `[Retry]` and `[Roll back]` buttons. Roll
back relies on the old deployment manifest still being
recoverable: clawdi-api keeps the prior pod manifest for **7 days**
post-migration; rollback re-applies it.

**Why both preflight AND rollback?** They cover different failure
modes. Preflight catches *foreseeable* problems before any
destructive work (no capacity, billing blocked, target machine
not ready). Rollback catches *unforeseeable* problems mid-flight
(image pull failed, network partition, k8s scheduler error).
Removing either leaves a hole.

### Lease fencing (the critical correctness primitive)

Without fencing, migration is a race: the user's old daemon and
the new pod's CLI both claim the lease via last-writer-wins. If
k8s pulls the image slowly while the user's daemon comes back
online, the wrong runtime can briefly own the env_id during the
ambiguous window.

**Solution: `migration_epoch` on `agent_environments`.** Every
migration increments the epoch. Lease claims must:

1. Carry an `epoch` value (from the deploy registration token or
   from the connect token)
2. Match the env's current `migration_epoch` to be accepted
3. Be rejected with explicit `migration_in_progress` if epoch is
   stale

Pseudocode for cloud-api's lease claim handler:

```
def claim_tunnel_lease(env_id, cli_instance, claimed_epoch):
    env = SELECT FROM agent_environments WHERE id = env_id
    if claimed_epoch != env.migration_epoch:
        return reject(reason="migration_in_progress")
    if claimed_epoch == env.migration_epoch:
        last_writer_wins(cli_instance)
```

This guarantees only the runtime authorized for the *current*
migration epoch can hold the lease. Stale daemons (from before a
migration completed) get a deterministic rejection and exit
cleanly, never racing the new owner.

The epoch travels in:
- Hosted registration tokens (Phase 4): `epoch` claim added to
  the JWT
- Self-managed connect tokens (Phase 2): `epoch` field added
- Tunnel session tokens (Phase 2): `epoch` field added; rejected
  on handshake if stale

### Mechanics by path

**Hosted → Hosted (runtime swap):**
1. Dashboard `POST /api/agents/{env_id}/migrate` body:
   `{ target_transport: "clawdi", target_runtime: "hermes" }`
2. cloud-api validates user owns env_id, forwards intent to
   clawdi-api `POST /api/deployments/migrate`
3. clawdi-api: SIGTERM old pod (entrypoint flushes via
   `clawdi push --flush --timeout 30s`), creates new Deployment
   row, provisions new pod with Hermes image
4. New pod's entrypoint redeems with **same `env_id` reservation**
   (clawdi-api passes env_id in registration_token alongside
   deployment_id)
5. cloud-api updates `agent_environments.deployment_id` to new
   value, rotates the `api_key` (old key revoked)

**Hosted → Self-managed:**
1. Dashboard intent submitted; cloud-api increments
   `agent_environments.migration_epoch`
2. cloud-api mints a connect token bound to the new epoch + shows
   install instructions
3. User runs `clawdi auth login --token ...` locally → connect
   token redemption issues a fresh **self-managed-mode api_key**
   (scopes include `skills:write` and `tunnel:proxy`; old hosted
   api_key is marked `revoked_at = now()` in the same transaction)
4. User runs `clawdi serve` → CLI uses the NEW api_key to mint a
   NEW tunnel session token bound to the new epoch
5. New CLI's tunnel claim succeeds (matches current
   `migration_epoch`); the hosted pod's CLI gets `migration_epoch
   stale` rejection on next heartbeat and exits
6. cloud-api notifies clawdi-api the lease was claimed by the
   self-managed CLI → clawdi-api tears down the pod
7. cloud-api sets `agent_environments.deployment_id = NULL`

**Self-managed → Hosted:**
1. Dashboard intent submitted; cloud-api increments
   `agent_environments.migration_epoch`
2. cloud-api requests clawdi-api provision pod with the env_id
   reservation, passing the new epoch
3. clawdi-api's pod entrypoint redeems registration token →
   gets a fresh **hosted-mode api_key** (no `skills:write`,
   includes `tunnel:proxy`); cloud-api revokes the user's old
   self-managed api_key in the same transaction
4. New pod's CLI mints a tunnel session token bound to the new
   epoch and claims the lease
5. User's old daemon's tunnel claim fails on next heartbeat with
   `migration_epoch stale` → daemon exits with explicit message
6. UI shows: *"Your daemon on `vps.example.com` was disconnected.
   You can stop it with `systemctl stop clawdi`."*
7. cloud-api sets `agent_environments.deployment_id` to new value

**Self-managed → Self-managed runtime swap:**
1. Dashboard intent submitted; declares new agent_type
2. cloud-api updates `agent_environments.declared_agent_type` and
   shows the user instructions: stop old daemon, install new
   runtime, restart `clawdi serve --agent <new_type>`
3. New daemon registers with same env_id; old runtime stops being
   used

### What's explicitly NOT in v1

- **Cross-runtime swap** (OpenClaw ↔ Hermes) — v1.5 (Phase 7).
  Skill format compatibility check + matrix UI is non-trivial and
  doesn't earn its weight at launch.
- **Cross-tenancy migration** (move agent to another user's
  account) — never v1; user-account boundary stays sacred.
- **Bulk migration** (move 5 agents at once) — v1 is per-agent;
  bulk is an open question.
- **Daemon-mode ↔ CLI-mode swap** (e.g., OpenClaw → Codex) —
  these aren't really "migrations," they're new agents. User
  creates a fresh CLI agent instead.
- **Image version pinning across migration** — new pod always
  takes our latest published image for the chosen runtime. No
  "migrate but keep CLI 0.3.2" knob.

## Settings: connecting self-managed agents

The Settings → Agents panel handles the self-managed onboarding
(install command, systemd template, login token). Plus a status
indicator per connected daemon:

```
─── Connected agents ──────────────────────────────────────
   Daemons (with live tunnel)
   ● prod-openclaw      vps.example.com    Online · 4d 3h
   ● dev-hermes         home-server        Online · 12m

   CLI-mode (sync only, no tunnel)
   ─ macbook-codex      macbook-pro        Last push 1h ago
─────────────────────────────────────────────────────────────
                                          [+ Connect a new agent]
```

For each, expose:
- Last seen / uptime
- Current CLI version
- Tunnel endpoint allowlist (chat, logs, native-ui, exec)
- `[Disconnect]` button — revokes the tunnel session token

## Error states catalog

What users see when things fail, plus the recovery contract for
each. Designed up-front so we don't ad-hoc them later.

| Surface | Failure | Copy + Recovery |
|---|---|---|
| Deploy dialog | Out of capacity | `We're at capacity right now. Try again in a few minutes.` `[Cancel]` `[Retry]`. Dialog stays open with form values preserved. Retry re-POSTs `/api/deployments`. |
| Deploy dialog | Billing 402 | `You've reached your hosted-agent limit.` `[Upgrade plan]` (opens clawdi.ai/billing in new tab) `[Cancel]`. After upgrade, Retry button enables. Form values preserved across upgrade flow. |
| Agent grid | Provision failed | Badge `Failed`; tooltip carries the specific reason from `/api/deployments/{id}/status`. Actions: `[Retry provision]` (POSTs `/api/deployments/{id}/restart`) and `[Delete]` (DELETE `/api/deployments/{id}`). Failed status persists until user picks one. |
| Agent grid | Tunnel disconnected | `Disconnected` badge; tooltip: `Last seen Xm ago.` Inline `[View diagnostics]` opens panel showing: last successful heartbeat, last error from CLI, current tunnel session token expiry, AND for hosted agents: pod phase (Pending / Running / Failed), pod restart count, current image version, last clawdi-api deploy event, k8s scheduler reason if pending. Auto-clears when tunnel reconnects. |
| Skill save | Cloud-api unreachable | Toast: `Couldn't save. Saved as draft locally — will retry.` Editor stays in unsaved state with retry happening every 30s; manual `[Save now]` button visible. Draft persists in localStorage until success. |
| Skill detail | Sync stalled on agent | Per-agent row shows red `Stalled · last synced 8m ago` with `[Retry sync]`. Retry sends a tunnel signal (or, if tunnel down, falls back to next cron). After 3 failed retries, escalate to `Sync failed: <reason>` and stop auto-retry. |
| Sessions | Push failure (transient network) | Per-agent metadata shows `N session lines queued`. CLI auto-retries with exponential backoff. UI shows the queue depth; clears on success. No user action needed unless queue grows past 1000. |
| Vault resolve | Unauthorized URI / token expired | For daemon agents: CLI logs the error to its log stream (visible via Tail logs tab). For CLI-mode agents: error appears in the user's local terminal where they're running the CLI tool. No dashboard toast either way — vault resolves are runtime calls during agent execution, not user actions. |
| Direct chat | Tunnel unreachable | Chat panel shows centered: `Agent is offline. Last active Xm ago.` `[Try again]` re-attempts. If agent's lifecycle status is `Stopped`, additional `[Start agent]` button (hosted only). |
| Direct logs | Tunnel unreachable | Log panel shows `Logs unavailable — agent offline.` Auto-resume when tunnel reconnects. |
| Connect token | Expired before redemption | Settings panel shows `Token expired — generate a new one.` `[Generate new token]` button mints fresh one. |

## Implementation phases

Phases sequenced so each one delivers a usable product slice. The
critical insight: **direct-connect UI must ship before in-app
deploy / lifecycle in cloud**, otherwise users would land on a
deployed agent with no way to use it from this dashboard. Phase 1
sidesteps the constraint by external-linking to clawdi.ai/dashboard
for the actual chat / files / lifecycle controls — a read-only
listing with `Manage ↗` is safe to ship before direct-connect.
Self-managed users (who arrive in Phase 2) also benefit from
chat/logs being available the moment their daemon connects.

Each phase is sized in *relative scope*, not engineer-days. The
implementation runs primarily on AI-paired coding so absolute time
estimates are unhelpful planning fiction.

### Phase 1 — Flag + hosted listing + cross-product link + Composio proxy  (medium)

- `apps/web/src/lib/hosted.ts` exports `IS_HOSTED`
- `apps/web/src/hosted/` directory with README explaining the convention
- DeployTrigger sidebar entry external-links to `clawdi.ai/dashboard`
- Hosted listing in the unified Agents grid: `useHostedAgentTiles`
  fans `Deployment.config_info.onboarded_agents` out to one tile per
  runtime (OpenClaw / Hermes are separate dashboard surfaces in
  clawdi.ai)
- Per-tile `Manage ↗` deep-links to `clawdi.ai/dashboard?deployment=
  X&agent_type=openclaw|hermes` — paired with clawdi.ai PR #425 which
  hydrates the runtime selector from the URL param
- Convention: every hosted-only component sets `data-hosted="true"`
  on its root element
- `oss-clean.test.ts` invariants: data-hosted marker present in every
  hosted .tsx, every non-hosted file importing `@/hosted/*` references
  `IS_HOSTED`, DeployTrigger JSX usage gated
- Hosted-only components must be side-effect-free at module top
  level (no env reads, no client construction at import) — see
  Conventions section
- Composio cross-origin proxy for hosted: `apps/web/src/hosted/clawdi-api.ts`
  shared client + `apps/web/src/hosted/use-hosted-connectors.ts`
  adapter hooks. `/connectors/*` pages switch data source on
  `IS_HOSTED`. Hosted users see their `clerk_id`-keyed connections
  from clawdi.ai; OAuth `redirect_url` is the connector's own detail
  page (no intermediary callback route). See "Composio cross-origin
  proxy" section under MCP proxy plane for the full design.
- API-key connector flow at parity with OAuth, both paths:
  cloud-api adds `GET /api/connectors/{app}/auth-fields` and
  `POST /api/connectors/{app}/connect-credentials`; the
  available-apps catalog now surfaces `auth_type` so the detail
  page picks OAuth (`window.open(connect_url)`) vs in-page
  credentials dialog at click time. `apps/web/src/components/connectors/
  credentials-dialog.tsx` renders the dynamic form (password type
  for `is_secret` or name-pattern matches), source-aware via the
  same `IS_HOSTED` switch.

No new cloud-api dependencies.
Cross-origin auth piggybacks on the existing Clerk session (both
apps share the Clerk project), so clawdi.ai just adds
`cloud.clawdi.ai` to its CORS allowlist (PR #424). clawdi.ai's
`POST /connections/{app}/connect` already takes `body.redirect_url`,
so no clawdi.ai change is required for callbacks either.

**Local dev gotcha — CORS_ORIGINS for the conductor host pattern.**
When cloud-web runs at `http://clawdi-cloud.localhost:3000` (the
Conductor worktree pattern with subdomain hosts), monorepo's
`CORS_ORIGINS` must include that exact origin. The default `.env`
ships with `localhost:3000` and `https://cloud.clawdi.ai` — neither
matches the subdomain host. Symptom: every cross-origin call to
`/deployments` or `/connections/*` fails the OPTIONS preflight with
"No 'Access-Control-Allow-Origin' header"; the dashboard shows
"Hosted agents unavailable" and the connectors page never loads.
Fix: append `http://clawdi-cloud.localhost:3000` to the JSON list in
`backend/.env`'s `CORS_ORIGINS=[...]` and restart the backend so it
re-reads the env (not just `--reload`-driven).

### Phase 2 — Gateway library extraction + cloud-api broker + state plane sync UX  (keystone — biggest phase)

This phase has three intertwined work items, sequenced to land
together because they validate each other:

**Phase 2a: Extract gateway library** (in clawdi clawdi.ai,
new package `packages/agent-gateway/`):
- Move route registration code from controller into the library
  with injected config (`FileRouteConfig`, `LogRouteConfig`, etc.)
- Controller becomes thin glue: read env vars, build config,
  instantiate library, bind ports
- No behavior change for hosted users — controller's existing
  endpoints answer the same way

**Phase 2b: Cloud-api broker API** (this repo):
- `POST /api/tunnel/session` (mints tunnel_session_token + library_token)
- `WS /api/tunnel/connect` (handshake + nonce + lease + heartbeat)
- Tunnel registry (in-memory v1, Redis v1.5)
- `tunnel:proxy` scope on api_keys
- `POST /api/agent-connect-tokens` + agent-type-aware Connect panel
- Broker routes: `POST /api/agents/{env_id}/chat`, `GET .../logs`,
  `GET .../files/tree`, `GET .../native-ui/{path*}`, etc.
  - For hosted: reverse-proxy to `Deployment.endpoints` with
    `gateway_token`
  - For self-managed: route through tunnel WS to library running
    in `clawdi serve`

**Phase 2c: State plane sync UX** (this repo):
- `clawdi serve` daemon command (embeds gateway library when
  agent runtime is daemon-mode; runs sync-only for CLI-mode)
- 60s cron pull with etag-safe sweep mode
- Per-agent sync indicators, `[Sync now]` button, save toast,
  delete confirmation
- SIGTERM flush of session push queue

After Phase 2, self-managed users get full direct-connect UX
identical to what hosted users have today. The dashboard's chat
and logs (built in Phase 3) work for both.

### Phase 3 — Dashboard chat / logs / native UI  (medium)

Direct-connect UI is **universal** — works for both `On Clawdi`
and `Self-managed` daemons via the broker API. Files live
OUTSIDE `apps/web/src/hosted/`:

- `apps/web/src/components/agents/chat-panel.tsx` — consumes
  broker SSE; UI inspired by clawdi.ai's existing
  `apps/web/src/components/console/` (we'll port relevant parts
  rather than rewrite from zero)
- `apps/web/src/components/agents/logs-panel.tsx` — consumes
  broker SSE for `event: line` chunks
- `apps/web/src/components/agents/native-ui-panel.tsx` — iframe
  pointing at the broker's native-ui proxy path; CSP overwritten
  by broker so frame-ancestors permits the dashboard origin
- Agent detail page: tabs Sessions / Skills / Memories / **Chat**
  / **Logs** / **Native UI**
- Capability discovery: dashboard reads adapter capabilities from
  cloud-api `GET /api/agents/{env_id}` and hides tabs whose
  capability is unsupported
- The "Start a session" CTA on an empty Sessions tab opens the
  Chat tab (for daemon agents) or shows a terminal-command
  panel (for CLI agents like Codex/Claude Code)

The OSS-clean test must NOT flag these files; they're not hosted.

After Phase 3: dashboard surfaces the broker's chat/logs/native-UI
endpoints. By the time Phase 4 ships hosted deploy, the user-facing
chat experience already works (from self-managed users in Phase 2
testing).

### Phase 4 — Hosted deploy + auto-registration + starter skills + vault allowlist  (large)

In clawdi clawdi.ai (private):
- CORS allowlist for `cloud.clawdi.ai` (controller already has
  `CLAWDI_DASHBOARD_ORIGINS` env support — extend default list)
- `/openapi.json` for type generation
- `POST /api/deployments` mints registration token server-side
  (and persists token bound to deployment_id + env_id)
- Pod entrypoint runs the existing controller process unchanged
  (with the gateway library extracted in Phase 2a, so it runs the
  same routes via the shared package). Cloud-api's broker reaches
  it via reverse-proxy to `Deployment.endpoints[i]:18789` using the
  pod's `gateway_token`. No tunnel for hosted; tunnel is for
  self-managed only (because user machines aren't reachable from
  the public internet).
- Pod manifest: PVC mount at `/var/lib/clawdi/sessions/`,
  `terminationGracePeriodSeconds: 35` (5s buffer over the
  state-sync flush deadline)

In this repo:
- `apps/web/src/hosted/deploy-agent-dialog.tsx`
- `apps/web/src/hosted/deploy-trigger.tsx` (sidebar entry)
- `apps/web/src/hosted/welcome-card.tsx` (the first-day card)
- `POST /api/internal/redeem-deploy-token` (receiver-side)
- `agent_environments.deployment_id`, `api_keys.deployment_id`,
  `api_keys.scopes` migration
- Scope-aware authz: deploy-key scope set is explicitly
  `[sessions:write, skills:read, memories:write, vault:resolve,
  mcp:proxy, tunnel:proxy]`. Deploy keys do NOT get `skills:write`
  (cloud panel is authoritative for skills on hosted; pods are
  read-only consumers — see "State plane" sync model). Self-managed
  keys (issued by `agent-connect-tokens`, see Phase 2) DO get
  `skills:write` because users push from laptop. Legacy keys
  (`scopes IS NULL`) keep wide access
- Starter skill seeding: canonical starter pack lives at
  `backend/seeds/starter-skills.yaml` in this repo (colocated with
  the loader, matching Cal.com / PostHog / Twenty / Sentry / GitLab
  conventions). The Welcome card's preview list of skill names
  duplicates this content as a hardcoded array in
  `apps/web/src/hosted/welcome-card.tsx`; acceptable for v1
  because the 7 names rarely change. Promote to an API endpoint
  (or build-time codegen) when starter content starts iterating.
  Each skill
  has a `starter_pack_version` field (bumped on canonical edit).
  On Clerk webhook `user.created`, seed handler INSERTs each skill
  with `starter_original_etag` recorded.

  When the YAML is updated, existing users get a non-destructive
  notification on their Skills page: *"Updates available for 2
  starter skills you haven't modified."* Click → preview → apply.
  Skills the user has modified (etag differs from
  `starter_original_etag`) get a 3-way diff dialog showing their
  version, the original, and the new canonical, with `[Keep mine]`
  / `[Take new]` / `[Merge in editor]` options. We never silently
  overwrite a user's edits.

  Settings → `Reset starter skills` re-applies the canonical pack,
  with the same 3-way diff dialog for any user-modified ones.
- Welcome card lifecycle: shown on Dashboard until user dismisses
  it (`[×]` button) OR until they have one or more agents in their
  account (deployed via Deploy OR connected via Settings).
  State stored in `user_settings.welcome_dismissed`. Returning
  users (existing accounts) get `welcome_dismissed = true` migrated
  as default — they never see it.

After Phase 4: hosted users sign up → see Welcome → click Deploy →
agent is online with seeded skills, tunnel up, **chat tab works
immediately** (built in Phase 3).

### Phase 5 — Lifecycle UI + billing CTA  (small — mostly thin proxy)

Reuses the status observation chain built in Phase 4 (clawdi-api
status events → cloud-api → dashboard). Phase 5 adds:

- Restart / Stop / Start / Delete buttons on agent header (when
  `On Clawdi`) — each calls the corresponding clawdi-api endpoint
  via cloud-api thin proxy
- 402-from-clawdi-api → upgrade modal linking to clawdi.ai billing

Status transitions during Restart use the same sequence Phase 4
established: `Restarting → Connecting tunnel → Pulling skills →
Ready`. No new state machine.

`Redeploy with latest image` was considered for v1 but cut — it's
an advanced operations feature with no early-user demand signal.
Add in v1.5 alongside cross-runtime migration if real users ask.

After Phase 5: core hosted product is feature-complete.

### Phase 6 — Transport-only migration with epoch fencing  (medium, in v1)

The OSS-no-lock-in promise made concrete. **Mostly orchestration
on top of Phase 2 (tunnel + connect tokens) and Phase 4 (deploy +
redeem) infrastructure.** What's actually new:

In this repo:
- `apps/web/src/components/agents/migrate-dialog.tsx` — single-step
  dialog for transport flip (same runtime); reuses Phase 4's status
  observation chain
- `POST /api/agents/{env_id}/migrate` — thin orchestrator: mints
  connect-token (hosted → self-managed) or forwards to clawdi-api
  with env_id reservation (self-managed → hosted)
- New `Migrating…` status (reuses sub-step progress mechanism
  from Phase 4)
- Migration audit log: row per event in
  `agent_environments_history`
- Re-issue api_key on transport flip (hosted-mode key vs
  self-managed-mode key — scope set already defined in Phase 2's
  Connect panel)
- `migration_epoch` column + lease-claim fencing (the codex
  round-3 critical primitive)

In clawdi clawdi.ai:
- Lease-loss → teardown webhook receiver: cloud-api notifies
  clawdi-api when a self-managed daemon has claimed the lease;
  clawdi-api distinguishes `replaced` (safe to teardown) from
  `timeout` (transient — wait)
- `POST /api/deployments` accepts optional `env_id` reservation
  parameter (vs always minting a fresh env_id)
- Rollback: keep previous pod manifest for **7 days** post-migration
  (extended from 24h on codex's recommendation since users may not
  discover bad behavior within 24h, especially low-traffic agents);
  `[Roll back]` re-applies it

Phase 6 ships **inside v1**. The migration story is in the launch
announcement, not a follow-up post.

### Phase 7 — Cross-runtime migration  (v1.5, medium)

Adds OpenClaw ↔ Hermes swap on top of Phase 6. Lands when we have
real-world signal that users want to switch runtimes (currently
guessing this is rare; let demand prove it).

- `validateSkillForRuntime` adapter contract extension
- Step 2 of migrate-dialog — per-skill compatibility matrix
- `POST /api/deployments/migrate` in clawdi clawdi.ai (atomic image
  swap on existing env_id)
- `agent_environments.declared_agent_type` column for self-managed
  runtime swap UX

## CI / security invariants

1. **OSS-clean static guards** (`apps/web/src/hosted/oss-clean.test.ts`):
   walk hosted/ + non-hosted dirs and assert via regex / file walk:
   - Every `.tsx` under `hosted/` carries `data-hosted="true"` on
     its root element
   - Every non-hosted file importing `@/hosted/*` references
     `IS_HOSTED` somewhere (gate-by-flag invariant)
   - `app-sidebar.tsx`'s `<DeployTrigger>` JSX is preceded by
     `IS_HOSTED && ` in the same expression
   - `IS_HOSTED` defaults to `false` when `NEXT_PUBLIC_CLAWDI_HOSTED`
     env var is unset
   The static / file-walk approach was chosen over render tests
   because apps/web has no jsdom setup and a single env-flag invariant
   doesn't justify wiring it up.

2. **Tunnel scope test** (`backend/tests/test_tunnel_auth.py`):
   - api_key without `tunnel:proxy` scope is rejected at session mint
   - tunnel session token bound to env_id A cannot route to env_id B
   - Expired token (> 24h) is rejected on WS handshake
   - Two CLIs racing for same env_id: second one wins, first gets
     `Replaced` event

3. **CLI non-interactive contract** (`packages/cli/tests/serve.test.ts`):
   - `clawdi serve` exits 0 on graceful SIGTERM
   - Reads no stdin (won't deadlock in entrypoint)
   - Reconnects after server-side close within 5s

4. **State plane sync sweep semantics**
   (`packages/cli/tests/pull-sync.test.ts`):
   - `clawdi pull --yes --sync` removes local skills only when the
     remote list omits the key AND the local copy's recorded etag
     matches a known prior remote etag (i.e. cloud is the
     authoritative source for those skills)
   - Local skills with no recorded prior etag — i.e. files the
     user added directly on disk and never pushed — are preserved
     across sweep
   - `clawdi pull --yes` without `--sync` does no deletion at all

5. **Hosted module side-effect freedom** (lint rule via custom
   biome plugin or Phase 2 manual review): no top-level
   instantiation of clients, no top-level env reads that throw, in
   `apps/web/src/hosted/`.

## Operational policies

### Audit log retention

`agent_environments_history` (migration events) and
`tunnel_audit_log` (per-tunnel-request rows) grow without natural
bound. Policy:

- **Hot retention: 90 days.** Queryable from cloud-api directly.
- **Archive: 1 year.** Moved to cold storage (S3/Glacier or
  equivalent); restorable on request for compliance.
- **Hard delete: 1 year + 1 day** unless a legal hold is set.
- Tables partitioned by `created_at` month for cheap
  expiration via partition drop.

Implemented as cron + table partitioning during Phase 2 migration.
Skipping it means DB bloat 3 months post-launch.

### Legacy key scope migration

Existing CLI api_keys with `scopes IS NULL` keep wide access for
backwards-compat. v1 adds a one-time prompt: on next CLI command
that authenticates, return `426 Scope Migration Required` with a
JSON body explaining the new scope model and a deep-link to
Settings → API Keys → `Migrate now`. The migration page shows the
key's likely scope set (inferred from usage history) with edit,
and writes the explicit array.

After 90 days, legacy NULL-scope keys are auto-migrated to a
read-only minimum scope set. We do NOT silently preserve wide
access forever — that's the kind of soft-pedal that's a CVE
later.

### Clerk dependency / SEV path

Clerk is a hard dependency for: dashboard auth, connect-token
mint, deploy requests, starter-skill webhook. Existing pods keep
running on their api_keys (no Clerk dependency), so a Clerk
outage doesn't break in-flight agents — but it does freeze
onboarding and admin.

SEV-1 response if Clerk reports an outage:
1. Auto-post status banner to cloud.clawdi.ai: *"Authentication
   provider experiencing issues. New sign-ins / deploys
   temporarily unavailable. Existing agents continue running."*
2. Disable Deploy / Connect / Migrate buttons with explicit copy
   pointing at the Clerk status page.
3. Tunnel + state-plane APIs continue serving authenticated
   api_key requests normally (no Clerk hit on the hot path).
4. Manual recovery procedure documented in the operator runbook
   (kept out of this public doc).

## OSS narrative

The README needs to communicate the model clearly. Skeleton:

```markdown
# clawdi-cloud

iCloud for AI agents. Manage skills, sessions, memories, and vault
across all your agents — wherever they run.

## Try it

- Hosted: cloud.clawdi.ai (we run your agents for you, billing applies)
- Self-host: docker compose up
- Connect any agent: install clawdi CLI, then `clawdi auth login`
  (daemon-mode agents also run `clawdi serve` for chat/logs)

## What runs where

| Where | How | Direct-connect |
|---|---|---|
| Our infra | Click Deploy on cloud.clawdi.ai | ✅ automatic |
| Your machine, daemon-mode agent | Install clawdi, run `clawdi serve` (systemd) | ✅ automatic |
| Your machine, CLI-mode agent | Install clawdi, use `clawdi push/pull` | n/a |

*Direct-connect availability depends on the agent runtime, not
where it lives. Daemon-mode agents (OpenClaw, Hermes) expose chat
and log endpoints; CLI-mode agents (Claude Code, Codex) are
stdio-only and have no remote chat surface in any environment.*

## Why hosted

We run the agent for you, seed your skill library with starters,
handle billing. Everything else is identical.
```

This frames the OSS product as the substantive thing and hosted as
a convenience layer — true to the architecture and aligned with
"OSS-first product" principle.

## Open product decisions (not v1 blockers)

1. **Bulk operations across agents.** Restart all / Update all
   skills. Probably not v1; revisit when users show up with 10+
   agents.
2. **Audit log surface.** We capture per-tunnel-request audit
   entries; no UI to view them yet. Add when first compliance
   conversation happens.
3. **Vault allowlist UI for self-managed agents already deployed
   pre-v1.** Existing legacy keys (`scopes IS NULL`) keep wide
   vault access until their one-time scope migration. New keys
   minted after v1 ship use the allowlist from day one.
4. **Multi-region routing.** v1 ships single-region only
   (`us-west-2`); Deploy dialog displays the region as static text,
   no selector. Multi-region + selector arrive in v1.5.
5. **Mobile / responsive.** Dashboard is desktop-first in v1.
6. **Self-host clawdi-cloud + Clawdi-managed pods cross-binding.**
   v1: locked, hosted pods only register to cloud.clawdi.ai. Tech
   path open (redeem-deploy-token is OSS), but no UI work scheduled.

## Conventions and invariants (the ones that bite)

### Imports

- Files inside `apps/web/src/hosted/` can import from anywhere.
- Files outside import `IS_HOSTED` from `@/lib/hosted` and gate
  rendering with `{IS_HOSTED && <X />}`. Top-level imports of
  `@/hosted/*` are fine.
- **Hosted modules MUST be side-effect-free at module top level.**
  No top-level `new ApiClient()`, no top-level `process.env.X!`
  reads that throw. Initialize lazily inside hooks/queries/event
  handlers. The OSS chunk graph still includes hosted modules; we
  just don't want them blowing up at import.

### UI promise (the OSS-clean rule)

OSS UI must contain ZERO traces of hosted features:
- No "Hosted only" badges
- No greyed-out deploy buttons
- No upgrade modals or marketing CTAs

OSS user awareness of the hosted version comes from README and
GitHub landing — not the in-product UI. Deliberate trust trade-off.

### What goes private (clawdi clawdi.ai)

- k8s / compute-orchestration driver, billing, legacy chat
  pairing flow (now obsolete with CLI tunnel — to be deleted)
- `POST /api/deployments` (and the server-side mint of registration
  token inside it)
- agent-image build pipeline

### What stays OSS (this repo)

- All state plane (skills/sessions/memories/vault)
- All direct-connect plane (tunnel, registry, session token)
- All MCP proxy plane (existing)
- `POST /api/internal/redeem-deploy-token` (receiver-side endpoint
  cloud.clawdi.ai uses to register pods deployed by clawdi-api)

### Naming

- "Clawdi" / "Clawdi Cloud" = the product (OSS or hosted instance)
- "On Clawdi" = badge for an agent runtime we run on our infra
- "Self-managed" = badge for any user-run agent (server, VPS, laptop)
- "Daemon" / "CLI" = runtime mode (separate metadata, not in badge)
- "Hosted" = adjective describing our cloud.clawdi.ai instance
  (used in copy, not as a category)

## Appendix: agent-side gateway library

Replaces the v0.21 "adapter contract" (chatEndpoint / logSource /
nativeUiUrl) which was too shallow. The library extracted from
the existing controller is the abstraction.

Library code lives at `packages/agent-gateway/` (workspace
package, exported to clawdi.ai via npm or workspace
symlink). Controller and `clawdi serve` both depend on it.

### Library config schema (TypeScript)

```ts
interface ControllerLibraryConfig {
  stateRef: ControllerStateRef;
  cors?: { allowedOrigins: string[]; credentials?: boolean };
  files?: {
    auth: ControllerAuth;
    defaultRootKey: string;
    roots: { key: string; absolutePath: string; writable?: boolean }[];
    backup?: { enabled: boolean };
  };
  logs?: {
    auth: ControllerAuth;
    sources: {
      id: string;
      label: string;
      stream(opts: { lines: number; signal: AbortSignal }): AsyncIterable<LogEvent>;
    }[];
    defaultSource: string;
  };
  httpProxies?: { pathPattern: string; target: ProxyTarget;
                  stripPrefix?: string; stripAuth?: boolean }[];
  wsProxies?: { match(pathname): boolean; target: ProxyTarget;
                rewritePath?: (url) => string;
                auth?: ControllerAuth }[];
  hermes?: { enabled: boolean; auth: ControllerAuth;
             apiTarget: ProxyTarget; webTarget: ProxyTarget;
             onConfigWrite?: (reason) => void };
  nativeUi?: { enabled: boolean; baseUrl: string; mountPath: string;
               rewriteHeaders?: boolean; csp?: string };
}
```

### Per-shell config provisioning

| Shell | files.roots | logs.sources | httpProxies | hermes | nativeUi |
|---|---|---|---|---|---|
| Hosted agent-image | `[{openclaw, /data/openclaw}, {hermes, /data/hermes}]` | supervisor logs | gateway @ 127.0.0.1:3001 | enabled, fixed ports | gateway catch-all |
| Self-managed w/ agent-image | same as above | same | same | same | same |
| `clawdi serve` for bare OpenClaw | local config-driven roots | local agent log paths | configured local OpenClaw URL | optional, user-configured | configured local URL |
| `clawdi serve` for stdio agents | n/a | n/a | n/a | n/a | n/a |

### Library token

`clawdi serve` calls `POST /api/tunnel/session` to mint a session,
receives `library_token` derived as
`HKDF(tunnel_session_token, salt=session_id, info="clawdi-library-auth-v1")`.
Library uses `library_token` as `auth.expectedToken`. Same primitive
shape as hosted's `gateway_token` from `MASTER_KEY`.

CLI-mode adapters declare nothing — no chat, no log shipping, no
web UI. The CLI tool runs on the user's own machine in their own
terminal; logs are already where they need them. Dashboard's Logs
tab is hidden for these agents.

## Appendix: schema additions (this repo)

Migrations introduced across phases. Listed with column names,
types, defaults, and purpose so engineers can write the migration
files directly.

```sql
-- Phase 2: tunnel + sessions infrastructure

-- NOTE: api_keys.revoked_at already exists (models/api_key.py:21).
-- Only add the new columns.
ALTER TABLE api_keys
  ADD COLUMN scopes text[] NULL,                    -- NULL = legacy wide
  ADD COLUMN deployment_id text NULL,               -- sqid; NULL for self-managed
  ADD COLUMN allowed_vault_uris text[] NOT NULL DEFAULT '{}';

CREATE TABLE connect_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,                  -- never store raw token
  user_id text NOT NULL,
  agent_type text NOT NULL,                         -- 'openclaw'|'hermes'|'claude-code'|'codex'
  vault_allowlist text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,                  -- typically now()+5min
  redeemed_at timestamptz NULL,                     -- single-use; non-NULL after redeem
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON connect_tokens (user_id, redeemed_at);
-- Cron: expire-and-purge after 24h regardless of redemption status

CREATE TABLE tunnel_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id uuid NOT NULL REFERENCES api_keys(id),
  env_id uuid NOT NULL REFERENCES agent_environments(id),
  endpoint_allowlist text[] NOT NULL,               -- e.g. ['chat','logs']
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  last_heartbeat_at timestamptz NULL,
  last_error_at timestamptz NULL,
  last_error_message text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON tunnel_sessions (env_id, revoked_at);

-- Phase 4: hosted deploy + auto-registration

-- NOTE: AgentEnvironment is currently defined in
-- backend/app/models/session.py (not its own file). When we add
-- columns, do not look for models/agent_environment.py.
ALTER TABLE agent_environments
  ADD COLUMN deployment_id text NULL,
  ADD COLUMN migration_epoch integer NOT NULL DEFAULT 0;

CREATE TABLE redeemed_tokens (
  jti uuid PRIMARY KEY,                             -- token's jti claim
  deployment_id text NOT NULL,
  env_id text NOT NULL,
  api_key_id uuid NOT NULL REFERENCES api_keys(id),
  redeemed_at timestamptz NOT NULL DEFAULT now()
);

-- Phase 4: starter skills

ALTER TABLE skills
  ADD COLUMN starter_pack_version integer NULL,    -- non-NULL = was a starter
  ADD COLUMN starter_original_etag text NULL;

ALTER TABLE user_settings
  ADD COLUMN welcome_dismissed boolean NOT NULL DEFAULT false;

-- Phase 6: migration audit log

CREATE TABLE agent_environments_history (
  id bigserial PRIMARY KEY,
  env_id text NOT NULL,
  event_type text NOT NULL,                        -- 'migration_started',
                                                   -- 'migration_completed',
                                                   -- 'migration_failed',
                                                   -- 'rollback_applied',
                                                   -- etc.
  from_state jsonb NULL,                           -- prior deployment_id, runtime, etc.
  to_state jsonb NULL,                             -- target
  actor_user_id text NOT NULL,
  reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)
PARTITION BY RANGE (created_at);
-- Monthly partitions; Phase 2 audit-retention cron drops partitions
-- after 90 days hot retention + 1 year archive.
```

## Appendix: clawdi clawdi.ai deploy API surface

```
POST   /api/deployments                       deploy + mint registration token (private)
GET    /api/deployments                       list user's deployments
DELETE /api/deployments/{id}                  delete
POST   /api/deployments/{id}/restart          restart
POST   /api/deployments/{id}/stop             stop
POST   /api/deployments/{id}/start            start
GET    /api/deployments/{id}/status           live status
POST   /api/deployments/{id}/onboard-agent    add agent type to existing pod
```

Phase 4 calls `POST /api/deployments` and `GET .../status`.
Phase 5 calls restart/stop/start/delete.
Phase 6 calls `POST /api/deployments` with `env_id` reservation (transport-only migration). Phase 7 (v1.5) adds `POST /api/deployments/migrate` for cross-runtime swap.
`pairing-token` and `Mux` keep serving messaging integrations
(telegram/discord/whatsapp/imessage) — see line 44. Cloud-side
plumbing doesn't replace them; the CLI tunnel is a separate state-
plane concern, not a competitor.

## Appendix: redeem flow (server-to-server)

```
clawdi-api                                       cloud-api (this repo)
──────────                                       ─────────────────────
POST /api/deployments (Clerk JWT)
  creates Deployment row
  signs registration_token:
    {
      iss: "clawdi-api",
      aud: "cloud-api",          ← audience binding
      sub: deployment_id,
      user_id,
      jti: <UUID>,                ← single-use marker
      exp: now+5m,
      iat: now,
    }
    using clawdi-api's signing key (asymmetric, ed25519)
  POST cloud-api/api/internal/redeem-deploy-token
    body: { registration_token }
    (sent via private VPC link or mTLS; never via public internet)
                                          ─────▶  verifies signature using
                                                  cloud-api's verify key
                                                  validates aud == "cloud-api"
                                                  validates iss == "clawdi-api"
                                                  validates exp not passed

                                                  INSERT INTO
                                                  redeemed_tokens(jti,
                                                    deployment_id,
                                                    env_id, api_key, ...)
                                                  with UNIQUE on jti

                                                  if INSERT succeeds:
                                                    mints new env + api_key
                                                  if INSERT fails (jti seen):
                                                    SELECT cached row by jti,
                                                    return its env_id +
                                                    api_key (legitimate retry)

                                          ◀───── { env_id, api_key, mcp_token }
  injects into pod env (kubernetes Secret,
    NOT in deployment manifest annotations)
  starts pod
                                                  pod entrypoint
                                                  (full sequence in
                                                  "Entrypoint sequence"
                                                  section above):
                                                    clawdi auth bootstrap
                                                    clawdi serve &  (background)
                                                    clawdi pull --yes --sync
                                                    exec agent runtime
```

**Honest threat model for `jti` single-use.** Caching by `jti`
(not by `deployment_id`) means a leaked registration_token, within
its 5-min validity, lets an attacker retrieve the SAME `(env_id,
api_key)` pair the legitimate caller would have gotten. The defense
is *containment*, not *prevention of read*: the token is never
useful for minting different credentials, never useful past 5
minutes, and never useful to attack a different deployment. Combined
with no-logging discipline below and private-network transit
(VPC link or mTLS, never public internet), the realistic leak
surface is small.

**Logging discipline.** `registration_token`, `api_key`, and
`mcp_token` MUST NEVER appear in logs (clawdi-api, cloud-api, or
k8s events). Code paths that handle them use a `Secret` wrapper
type with a redacted `Debug` impl. CI grep test rejects any logger
call passing these field names.

**Asymmetric verify-key** rationale: cloud-api holds only the
verify key, never the sign key. A cloud-api config leak /
verify-key disclosure does NOT grant the ability to mint new deploy
tokens. Full runtime compromise of cloud-api is more serious —
attacker can create env rows and mint api_keys directly — and
asymmetric verify keys do not protect against that.

**Key distribution + rotation:** ed25519 keypair. clawdi-api's
signing key lives only in clawdi-api's secret manager. cloud-api's
verify key lives in cloud-api's config (loaded at startup).

**Two-phase rotation procedure (machine-checked, not just runbook):**

1. **Pre-flight:** deploy cloud-api with both old AND new verify
   keys configured. Verify both keys load by hitting `/api/healthz`
   which returns the SHA-256 fingerprint of each.
2. **Synthetic test:** before flipping clawdi-api's signing key,
   run a synthetic redeem against staging cloud-api using the
   new signing key. CI gate blocks the flip if synthetic redeem
   fails.
3. **Flip:** clawdi-api switches to new signing key. Cloud-api
   keeps both verify keys during the dual-verify window.
4. **Dual-verify window: 4 hours** (was 24h — shortened on
   codex's recommendation; long windows extend exposure to
   mis-rotation, and 4h is enough to spot real signing failures
   in staging traffic).
5. **Cleanup:** cloud-api drops old verify key after window
   passes; verified by next deploy.

If the synthetic test fails at step 2, rotation aborts; old key
remains active. No in-flight deployment is affected.

Failure of in-flight deployments during a botched rotation looks
like: `redeem_deploy_token` returns `401 invalid_signature` →
clawdi-api flags the new Deployment row as `failed_registration`
→ pod startup retries every 30s for 5 minutes then gives up →
user sees `Provision failed: registration_failed`. Rolling back
to the old signing key recovers any new deploys (existing pods
are unaffected — they already have their api_keys).
