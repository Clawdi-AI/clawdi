# Channel Runtime Manifest

Status: implemented baseline
Date: 2026-06-08

> Clawdi v2 retired iMessage/BlueBubbles on 2026-08-03.

## Current State

The CLI now has baseline runtime manifest support for Clawdi-native channels.
It reconciles user-facing channel state through ordinary authenticated APIs and
materializes agent-facing SDK config into explicit local runtime outputs.

What exists today:

- `clawdi channel ...` manages the user-facing channel control plane through
  `/v1/channels`.
- `clawdi run ...` injects Vault and AI Provider runtime env into a child
  process.
- Core Hosted manifests carry the controller-selected AI Provider binding and
  the runtime reconciler projects it into Hermes or OpenClaw native config.
- `clawdi runtime plan/status/apply` reads `clawdi.runtime.yaml`, creates or
  reuses private channel accounts, links accessible bots to agents, emits pair
  codes, and writes enabled runtime outputs with private file permissions.

Still intentionally out of scope for this baseline:

- Admin/public bot publishing from the CLI.
- Provider webhook ownership, pair-code claiming, bindings, command replies,
  provider protocol state, and worker queues. Those remain backend-owned.
- Managed WhatsApp activation. Its stock native-plugin path has a CLI-owned
  compatibility seam, but remains gated on native-plugin E2E and a live drill.
- Custom WhatsApp OpenClaw connectors, Hermes platform adapters, and
  application-level relay projections.

## Decision

Add a `clawdi.runtime.yaml` manifest with a `channels` section. The manifest is
the user CLI surface for channel runtime configuration. It composes existing
user APIs; it does not add admin behavior to the CLI.

The runtime manifest is not a second channel control plane. It does not own
provider webhooks, pair-code claiming, bindings, command replies, provider
protocol state, or worker queues. Those remain in Clawdi-native Channels. The
manifest only reconciles user intent into channel accounts, bot-agent links,
pair codes, and local runtime outputs.

The legacy channel bridge process and env shape are compatibility inputs only. The
source of truth is Clawdi-native channel state:

- `channel_accounts`
- `channel_bot_agent_links`
- `channel_pair_codes`
- `channel_bindings`
- provider-specific state such as Link-scoped WhatsApp synthetic credentials

## Requirements

- User CLI only. No `/v1/admin/*` calls, no admin key, no public bot creation.
- No Project concept. Channels link bots to agents.
- Public bots are referenced by id. Public bot publishing and provider
  credential rotation stay admin API concerns.
- Private bots are created by the user through `/v1/channels`.
- One external chat session still routes to exactly one active bot-agent link.
- A bot can link to many agents, and one agent can link to many bots.
- Local runtime outputs must be written under explicit manifest output paths
  with private permissions. E2E tests should run with isolated `HOME` and
  `CLAWDI_HOME`; hosted-runtime tests should prefer an isolated Docker
  container home instead of the developer's host `~/.clawdi`.
- Each bot-agent link owns its own agent SDK token.
- Provider secrets are read from env or a future secret reference, never stored
  inline in the manifest.
- Agent SDK tokens are written only to explicit outputs with private file mode.

## Manifest Shape

```yaml
version: 1

channels:
  - ref: ops-telegram
    provider: telegram
    account:
      private:
        name: ops-telegram
        provider_token_env: TELEGRAM_PROVIDER_TOKEN
        config:
          bot_username: opsbot
        secrets_env:
          webhook_verify_token: TELEGRAM_WEBHOOK_VERIFY_TOKEN
    links:
      - ref: ops-telegram-main
        agent_id: 00000000-0000-0000-0000-000000000101
        runtime:
          token_env: TELEGRAM_BOT_TOKEN
          projection: dotenv
        pair_code:
          ttl_seconds: 300
          command_env: TELEGRAM_PAIR_COMMAND
    commands:
      sync: true

  - ref: public-discord
    provider: discord
    account:
      id: 00000000-0000-0000-0000-000000000202
      visibility: public
    links:
      - ref: public-discord-main
        agent_id: 00000000-0000-0000-0000-000000000101
        runtime:
          token_env: DISCORD_BOT_TOKEN
          projection: dotenv
        pair_code:
          ttl_seconds: 300
          command_env: DISCORD_PAIR_COMMAND

outputs:
  dotenv: .env.clawdi.channels
```

## Field Semantics

| Field | Meaning |
| --- | --- |
| `channels[].ref` | Manifest-local stable name. Not a database id. |
| `provider` | `telegram`, `discord`, or `whatsapp`. |
| `account.id` | Existing accessible channel account id, usually a public bot or pre-created private bot. |
| `account.visibility` | Optional assertion: `public` or `private`. Apply fails if the backend returns a different visibility. |
| `account.private` | Create or reuse a user-owned private bot by `(provider, name)`. |
| `provider_token_env` | Env var containing the real upstream provider token. Used only when creating the private bot. |
| `config` | Provider-wide account config, stored on `channel_accounts.config`. |
| `secrets_env` | Map of encrypted provider secret names to env var names. |
| `links[].agent_id` | Target AgentEnvironment id. |
| `links[].runtime.token_env` | Env var name that receives this link's agent SDK token. |
| `links[].runtime.projection` | Runtime adapter. v1 implements `dotenv`; OpenClaw and Hermes should be added as target-native adapters later. |
| `pair_code.command_env` | Optional env var containing the provider-specific pair command for onboarding scripts. |
| `outputs.dotenv` | Dotenv file to write with mode `0600`. |

## Apply Behavior

`clawdi runtime apply -f clawdi.runtime.yaml` should:

1. Parse and validate the manifest.
2. Resolve all provider token and secret env refs.
3. List caller-owned private channels through `GET /v1/channels` when the
   manifest needs to create or reuse a private bot.
4. For provider selection UX, optionally read `GET /v1/channels/bot-pool` so
   the user or managed runtime can choose among owned private and public bots
   without hardcoding ids. Selection should use `capabilities` instead of
   inferring permissions from `visibility`.
5. For `account.id`, fetch and validate the channel account.
6. For `account.private`, reuse an existing private channel by
   `(provider, name)` or create it through `POST /v1/channels`.
7. List the caller's links for the account.
8. Reuse an existing link by `(account, agent_id)` or create one through
   `POST /v1/channels/{account_id}/agent-links`.
9. Rotate only when requested by the manifest or CLI flag.
10. Create pair codes when requested.
11. Sync provider commands when requested.
12. Materialize runtime outputs.

Apply is idempotent except for explicitly requested one-time values:

- New link token issuance.
- Token rotation.
- New pair code issuance.
- Internal WhatsApp synthetic credential issuance once the upstream/runtime
  gates are deliberately enabled.

## One-Time Token Policy

Agent SDK tokens are returned only at link creation or rotation. The manifest
must not silently rotate existing links just because a dotenv output is missing.

Rules:

- If a link is newly created, write the returned token to the requested output.
- If a link already exists and no token is available, warn and leave the token
  env untouched.
- `--rotate-missing-tokens` may rotate only links whose requested token env is
  absent from the target output.
- `--rotate-all-tokens` is explicit and should require `--yes` outside JSON
  automation.
- Secret outputs must use `0600` files and must never be written to the
  manifest.

Store only non-secret apply state under:

```text
~/.clawdi/runtime/channels/<manifest-digest>.json
```

This state can cache account ids, link ids, output paths, and last-applied
manifest refs. It must not cache provider tokens, agent SDK tokens, pair codes,
or WhatsApp auth private keys.

## Runtime Projections

### Dotenv Projection

The dotenv output is the portable baseline. It should support explicit env
names so one agent can consume multiple bots for the same provider.

Telegram:

```dotenv
TELEGRAM_BOT_TOKEN=<agent-sdk-token>
TELEGRAM_BOT_API_BASE_URL=https://channels.example.test/v1/channels/telegram
```

Discord:

```dotenv
DISCORD_BOT_TOKEN=<agent-sdk-token>
DISCORD_BOT_API_BASE_URL=https://channels.example.test/v1/channels/discord
DISCORD_GATEWAY_URL=wss://channels.example.test/v1/channels/discord/gateway
```

WhatsApp deliberately has no dotenv application-API projection. Its gated
managed path uses the runtime's stock native Baileys plugin, a private auth
directory, and the generic managed-upgrade egress profile.

The dotenv projection is not allowed to resurrect old root routes such as
`/bot<token>/*`, `/api/v10/*`, `/api/v1/*`, or `/socket.io/*`. Those roots are
intentionally absent. SDK compatibility should use provider-prefixed routes or
target-native adapters.

For Telegram specifically, current FastAPI routes are
`/v1/channels/telegram/bot/{token}/{method}` and
`/v1/channels/telegram/file/bot/{token}/{file_path}`. Many Telegram SDKs build
the official shape `/bot<token>/<method>` from an `apiRoot`, so full
drop-in compatibility needs one of:

- a provider-prefixed alias
  `/v1/channels/telegram/bot<token>/<method>` plus matching
  `/v1/channels/telegram/file/bot<token>/<file_path>`, or
- a target adapter that knows Clawdi's slashful `/bot/{token}` route shape.

The Telegram `agent_token` is intentionally generated in Bot API-looking
`<9-digit bot id>:<secret>` form. Keep that shape stable because SDKs and
OpenClaw-compatible clients may validate it before sending requests.

### OpenClaw Projection

OpenClaw projection patches the same official runtime config shape OpenClaw uses
for channel accounts:

- Telegram account token and API root.
- Discord token, REST base URL, and Gateway URL.
- WhatsApp official native-plugin account and synthetic auth directory, only
  after all gates are enabled. It does not set a custom websocket URL.

The managed default Agent profile accepts at most one Link per provider. The
WhatsApp projection must not install a custom ChannelPlugin connector.

### Hermes Projection

Hermes should be a structured `config.yaml` merge, using the same target-native
provider projection owned by Hosted runtime convergence.

Telegram:

```yaml
platforms:
  telegram:
    enabled: true
    token: "${TELEGRAM_BOT_TOKEN}"
    extra:
      base_url: "https://channels.example.test/v1/channels/telegram/bot"
      base_file_url: "https://channels.example.test/v1/channels/telegram/file/bot"
```

This Hermes Telegram shape assumes the provider-prefixed `/bot<token>` alias
exists, matching `python-telegram-bot`'s default URL builder. Without that
alias, the Hermes adapter must explicitly support Clawdi's
`/bot/{token}/{method}` route shape.

Discord:

```yaml
platforms:
  discord:
    enabled: true
    token: "${DISCORD_BOT_TOKEN}"
    extra:
      base_url: "https://channels.example.test/v1/channels/discord/v10"
      gateway_url: "wss://channels.example.test/v1/channels/discord/gateway"
```

Hermes currently supports one profile per platform in the old integration
shape. Multiple bots for the same provider should require either multiple
Hermes profiles or a Hermes-side multi-account config before the adapter
claims full multi-bot support.

WhatsApp is not projected through a new Hermes `BasePlatformAdapter`. The gated
projection uses Hermes' stock native Baileys integration with the same
synthetic auth and managed-upgrade profile contract as OpenClaw.

### WhatsApp Native Baileys Projection

The managed projection is entirely gate-controlled:

1. The authenticated runtime-channel source mints or reuses one Link-scoped
   synthetic credential under the account row lock. There is no public credential
   authority API.
2. Runtime convergence embeds strict namespaced metadata under
   `creds.additionalData["clawdi.managedWhatsAppSocket"]` and writes that one
   synthetic `creds.json` into the stock OpenClaw or Hermes auth directory with
   private permissions. The metadata contains only its schema, per-Link
   selector, and public Noise trust material; it never contains the Link bearer
   or a websocket URL, and physical provider auth state is never copied.
3. A provider profile matches an exact per-Link managed upgrade capability,
   strips it, injects the Link bearer, and rewrites the WebSocket upgrade to the
   Noise endpoint. The capability is a profile selector, not a WhatsApp token.
4. Missing capability preserves the stock plugin's official upstream request;
   a present invalid, stale, or misplaced capability fails closed. The
   deterministic selector has no expiry because it grants no backend authority.
   Link removal deletes the valid route but retains the deny rule, while the
   backend independently rejects revoked bearers and cross-Link synthetic
   identities during convergence.

The Baileys aliases receive the dedicated WebSocket-only header and `authCert`
seams through the CLI-owned static compatibility reconciler. OpenClaw and
Hermes source remains stock: both already persist the full Baileys auth state,
including `additionalData`, on initial construction and reconnect. The
reconciler accepts only rigorously parsed SemVer major 7 packages whose audited
before/after context hunks each match uniquely and exactly with fuzz zero.
Unrelated bytes outside those hunks are allowed, while missing, duplicated,
mixed-without-ownership, or changed hunk semantics fail closed. It remains
inert without a projected managed Link. The aggregate upstream gate is still
false because OpenClaw and Hermes native-plugin E2E and the live-account drill
are not complete; runtime convergence therefore currently installs neither
WhatsApp auth state nor a WhatsApp egress profile.

## CLI Commands

```bash
clawdi runtime plan -f clawdi.runtime.yaml
clawdi runtime apply -f clawdi.runtime.yaml
clawdi runtime apply -f clawdi.runtime.yaml --dry-run --json
clawdi runtime status -f clawdi.runtime.yaml --json
```

Command boundaries:

| Command | Side effects |
| --- | --- |
| `runtime plan` | No writes, no backend mutations. Validates and prints intended operations. |
| `runtime apply --dry-run` | Backend reads only. Shows create/reuse/rotate decisions. |
| `runtime apply` | User API mutations plus local runtime output writes. |
| `runtime status` | Backend reads plus local output inspection. |

Do not add admin subcommands under `runtime`.

## Backend APIs Used

The CLI should use only existing user APIs:

- `GET /v1/channels`
- `GET /v1/channels/bot-pool`
- `POST /v1/channels`
- `GET /v1/channels/{account_id}`
- `GET /v1/channels/{account_id}/agent-links`
- `POST /v1/channels/{account_id}/agent-links`
- `POST /v1/channels/{account_id}/agent-links/{link_id}/token`
- `POST /v1/channels/{account_id}/pair-codes`
- `POST /v1/channels/{account_id}/commands/sync`

The ordinary user API has no WhatsApp credential mint/list or auth-certificate
authority route. Authenticated runtime-channel projection is the internal
producer once the gates are viable. No admin endpoint is needed for user
runtime setup.

First-party hosted control planes should follow the same boundary. They may
invoke the CLI inside the runtime or call these user APIs directly before
launch, but they should not store their own pair-code state, implement provider
webhooks, or recreate the legacy channel bridge tenant router.

## Compatibility Mapping

| Legacy channel bridge concept | Manifest / Clawdi-native equivalent |
| --- | --- |
| Tenant API key | Clawdi user auth token. |
| Tenant channel enrollment | `links[].agent_id` on an accessible channel account. |
| Synthetic bot token | `links[].runtime.token_env`, backed by `channel_bot_agent_links`. |
| `/v1/pair-codes` | `pair_code` under a specific link. |
| `TG_BASE_URL` / `DISCORD_BASE_URL` as router service upstream config | Backend settings or account config, not user runtime manifest fields. |
| `TELEGRAM_BOT_API_BASE_URL` | Runtime projection output. |
| `DISCORD_BOT_API_BASE_URL` | Runtime projection output. |
| `DISCORD_GATEWAY_URL` | Runtime projection output. |
| WhatsApp application relay env | No equivalent; the stock native plugin uses managed egress. |

## Endpoint Security Boundary

The runtime manifest describes agent-facing configuration: SDK tokens,
pair-code setup, dotenv projection, and gated synthetic credential files. It
must not expose backend provider egress knobs such as Discord REST/Gateway
base URLs as ordinary runtime fields.

Provider endpoint overrides live on channel account config and are validated by
the backend when accounts are created or updated, then again before each
outbound provider call. The backend rejects private, loopback, unresolved,
HTTP, and WS targets. A runtime manifest cannot weaken that outbound network
boundary.

## Open Questions

- Whether `clawdi run` should automatically load `outputs.dotenv`, or whether
  users should pass `--env-file .env.clawdi.channels` explicitly.
- Live validation of the exact target-native OpenClaw and Hermes config shape.
- Whether the backend should expose a user API to update private channel
  account config after creation. Today the manifest can create or reuse private
  bots, but not reconcile changed provider config without deletion.

## Implementation Plan

1. Add parser and validator for `clawdi.runtime.yaml`.
2. Add `clawdi runtime plan/apply/status`.
3. Implement idempotent account and link reconciliation through user APIs.
4. Implement dotenv projection with private atomic writes.
5. Implement explicit token rotation flags and missing-token warnings.
6. Keep WhatsApp native projection gated until native-plugin E2E and the live drill exist.
7. Use stock OpenClaw/Hermes WhatsApp integrations; do not add custom adapters.
8. Add CLI tests proving:
   - no admin endpoint is called,
   - private bot create/reuse is idempotent,
   - public bot reference is link-only,
   - existing one-time tokens are not silently rotated,
   - multiple bots can link to one agent with distinct token env names,
   - one bot can link to multiple agents,
   - disabled WhatsApp gates write no credential files or egress profiles,
   - malformed manifests fail before API mutation.
