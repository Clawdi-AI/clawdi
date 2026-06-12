# Channel Runtime Manifest

Status: implemented baseline
Date: 2026-06-08

## Current State

The CLI now has baseline runtime manifest support for Clawdi-native channels.
It reconciles user-facing channel state through ordinary authenticated APIs and
materializes agent-facing SDK config into explicit local runtime outputs.

What exists today:

- `clawdi channel ...` manages the user-facing channel control plane through
  `/api/channels`.
- `clawdi run ...` injects Vault and AI Provider runtime env into a child
  process.
- `clawdi ai-provider apply ...` materializes AI Provider config into selected
  agent runtimes.
- `clawdi runtime plan/status/apply` reads `clawdi.runtime.yaml`, creates or
  reuses private channel accounts, links accessible bots to agents, emits pair
  codes, and writes dotenv/WhatsApp Baileys runtime outputs with private file
  permissions.

Still intentionally out of scope for this baseline:

- Admin/public bot publishing from the CLI.
- Provider webhook ownership, pair-code claiming, bindings, command replies,
  provider protocol state, and worker queues. Those remain backend-owned.
- Runtime output adapters beyond dotenv and the implemented WhatsApp Baileys
  credential output.
- OpenClaw/Hermes target-native adapters. They should be added as explicit
  future projections instead of overloading the dotenv baseline.

## Decision

Add a `clawdi.runtime.yaml` manifest with a `channels` section. The manifest is
the user CLI surface for channel runtime configuration. It composes existing
user APIs; it does not add admin behavior to the CLI.

The runtime manifest is not a second channel control plane. It does not own
provider webhooks, pair-code claiming, bindings, command replies, provider
protocol state, or worker queues. Those remain in Clawdi-native Channels. The
manifest only reconciles user intent into channel accounts, bot-agent links,
pair codes, and local runtime outputs.

The old `msg-router` process and env shape are compatibility inputs only. The
source of truth is Clawdi-native channel state:

- `channel_accounts`
- `channel_bot_agent_links`
- `channel_pair_codes`
- `channel_bindings`
- provider-specific credential rows such as WhatsApp tenant credentials

## Requirements

- User CLI only. No `/api/admin/*` calls, no admin key, no public bot creation.
- No Project concept. Channels link bots to agents.
- Public bots are referenced by id. Public bot publishing and provider
  credential rotation stay admin API concerns.
- Private bots are created by the user through `/api/channels`.
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
          ttl_seconds: 900
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
          ttl_seconds: 900
          command_env: DISCORD_PAIR_COMMAND

outputs:
  dotenv: .env.clawdi.channels
```

## Field Semantics

| Field | Meaning |
| --- | --- |
| `channels[].ref` | Manifest-local stable name. Not a database id. |
| `provider` | `telegram`, `discord`, `whatsapp`, or `imessage`. |
| `account.id` | Existing accessible channel account id, usually a public bot or pre-created private bot. |
| `account.visibility` | Optional assertion: `public` or `private`. Apply fails if the backend returns a different visibility. |
| `account.private` | Create or reuse a user-owned private bot by `(provider, name)`. |
| `provider_token_env` | Env var containing the real upstream provider token. Used only when creating the private bot. |
| `config` | Provider-wide account config, stored on `channel_accounts.config`. |
| `secrets_env` | Map of encrypted provider secret names to env var names. |
| `links[].agent_id` | Target AgentEnvironment id. |
| `links[].runtime.token_env` | Env var name that receives this link's agent SDK token. |
| `links[].runtime.projection` | Runtime adapter. v1 implements `dotenv`; OpenClaw and Hermes should be added as target-native adapters later. |
| `pair_code.command_env` | Optional env var containing `/bot_pair <code>` for onboarding scripts. |
| `outputs.dotenv` | Dotenv file to write with mode `0600`. |

## Apply Behavior

`clawdi runtime apply -f clawdi.runtime.yaml` should:

1. Parse and validate the manifest.
2. Resolve all provider token and secret env refs.
3. List caller-owned private channels through `GET /api/channels` when the
   manifest needs to create or reuse a private bot.
4. For provider selection UX, optionally read `GET /api/channels/bot-pool` so
   the user or hosted runtime can choose among owned private and public bots
   without hardcoding ids. Selection should use `capabilities` instead of
   inferring permissions from `visibility`.
5. For `account.id`, fetch and validate the channel account.
6. For `account.private`, reuse an existing private channel by
   `(provider, name)` or create it through `POST /api/channels`.
7. List the caller's links for the account.
8. Reuse an existing link by `(account, agent_id)` or create one through
   `POST /api/channels/{account_id}/agent-links`.
9. Rotate only when requested by the manifest or CLI flag.
10. Create pair codes when requested.
11. Sync provider commands when requested.
12. Materialize runtime outputs.

Apply is idempotent except for explicitly requested one-time values:

- New link token issuance.
- Token rotation.
- New pair code issuance.
- WhatsApp tenant credential minting when explicitly requested.

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
TELEGRAM_BOT_API_BASE_URL=https://cloud-api.clawdi.ai/api/channels/telegram
```

Discord:

```dotenv
DISCORD_BOT_TOKEN=<agent-sdk-token>
DISCORD_BOT_API_BASE_URL=https://cloud-api.clawdi.ai/api/channels/discord
DISCORD_GATEWAY_URL=wss://cloud-api.clawdi.ai/api/channels/discord/gateway
```

WhatsApp Graph-compatible runtime:

```dotenv
WHATSAPP_ACCESS_TOKEN=<agent-sdk-token>
WHATSAPP_GRAPH_API_BASE_URL=https://cloud-api.clawdi.ai/api/channels/whatsapp/graph
```

iMessage / BlueBubbles-compatible runtime:

```dotenv
BLUEBUBBLES_SERVER_URL=https://cloud-api.clawdi.ai/api/channels/imessage/bluebubbles
BLUEBUBBLES_API_BASE_URL=https://cloud-api.clawdi.ai/api/channels/imessage/bluebubbles/v1
BLUEBUBBLES_PASSWORD=<agent-sdk-token>
```

The dotenv projection is not allowed to resurrect old root routes such as
`/bot<token>/*`, `/api/v10/*`, `/api/v1/*`, or `/socket.io/*`. Those roots are
intentionally absent. SDK compatibility should use provider-prefixed routes or
target-native adapters.

For Telegram specifically, current FastAPI routes are
`/api/channels/telegram/bot/{token}/{method}` and
`/api/channels/telegram/file/bot/{token}/{file_path}`. Many Telegram SDKs build
the official shape `/bot<token>/<method>` from an `apiRoot`, so full
drop-in compatibility needs one of:

- a provider-prefixed alias
  `/api/channels/telegram/bot<token>/<method>` plus matching
  `/api/channels/telegram/file/bot<token>/<file_path>`, or
- a target adapter that knows Clawdi's slashful `/bot/{token}` route shape.

The Telegram `agent_token` is intentionally generated in Bot API-looking
`<9-digit bot id>:<secret>` form. Keep that shape stable because SDKs and
OpenClaw-compatible clients may validate it before sending requests.

For BlueBubbles, many clients append `/api/v1` under `BLUEBUBBLES_SERVER_URL`.
Full drop-in compatibility needs either
`/api/channels/imessage/bluebubbles/api/v1/*` aliases or a target adapter that
uses the existing `/api/channels/imessage/bluebubbles/v1/*` routes directly.

### OpenClaw Projection

OpenClaw should be a target-native adapter, not a pile of ad hoc env writes.
The adapter should patch the same runtime config shape OpenClaw already uses
for channel accounts:

- Telegram account token and API root.
- Discord token, REST base URL, and Gateway URL.
- WhatsApp websocket URL and credential path.
- iMessage server URL and password.

The projection must allow multiple accounts per provider. Env names are still
accepted as a transport, but the target-native config should be the preferred
output when OpenClaw supports it.

### Hermes Projection

Hermes should be a structured `config.yaml` merge, similar to
`clawdi ai-provider apply --target hermes`.

Telegram:

```yaml
platforms:
  telegram:
    enabled: true
    token: "${TELEGRAM_BOT_TOKEN}"
    extra:
      base_url: "https://cloud-api.clawdi.ai/api/channels/telegram/bot"
      base_file_url: "https://cloud-api.clawdi.ai/api/channels/telegram/file/bot"
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
      base_url: "https://cloud-api.clawdi.ai/api/channels/discord/v10"
      gateway_url: "wss://cloud-api.clawdi.ai/api/channels/discord/gateway"
```

Hermes currently supports one profile per platform in the old integration
shape. Multiple bots for the same provider should require either multiple
Hermes profiles or a Hermes-side multi-account config before the adapter
claims full multi-bot support.

### WhatsApp Baileys Projection

WhatsApp needs more than env:

```yaml
channels:
  - ref: shared-whatsapp
    provider: whatsapp
    account:
      id: 00000000-0000-0000-0000-000000000303
    links:
      - ref: wa-main
        agent_id: 00000000-0000-0000-0000-000000000101
        runtime:
          projection: dotenv
          token_env: WHATSAPP_ACCESS_TOKEN
        whatsapp:
          baileys_credentials_dir: .clawdi/whatsapp/default
```

Apply should call:

- `POST /api/channels/whatsapp/{account_id}/tenant-creds` to mint or reuse a
  link-scoped credential.
- `GET /api/channels/whatsapp/{account_id}/auth-cert` when the runtime needs
  shared account public auth material.

It should write the Baileys auth state into the requested credential directory
with private permissions and emit:

```dotenv
WA_WEBSOCKET_URL=wss://cloud-api.clawdi.ai/api/channels/whatsapp/<account-id>/baileys
CLAWDI_WHATSAPP_AUTH_DIR=.clawdi/whatsapp/default
```

This projection is the Clawdi-native WhatsApp runtime contract. It must not
emit old router env names.

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

- `GET /api/channels`
- `GET /api/channels/bot-pool`
- `POST /api/channels`
- `GET /api/channels/{account_id}`
- `GET /api/channels/{account_id}/agent-links`
- `POST /api/channels/{account_id}/agent-links`
- `POST /api/channels/{account_id}/agent-links/{link_id}/token`
- `POST /api/channels/{account_id}/pair-codes`
- `POST /api/channels/{account_id}/commands/sync`
- `POST /api/channels/whatsapp/{account_id}/tenant-creds`
- `GET /api/channels/whatsapp/{account_id}/tenant-creds`
- `GET /api/channels/whatsapp/{account_id}/auth-cert`

No admin endpoint is needed for user runtime setup.

Hosted deployment code should follow the same boundary. It may invoke the CLI
inside the runtime or call these user APIs directly before launch, but it should
not store its own pair-code state, implement provider webhooks, or recreate the
old `msg-router` tenant router.

## Compatibility Mapping

| Old `msg-router` concept | Manifest / Clawdi-native equivalent |
| --- | --- |
| Tenant API key | Clawdi user auth token. |
| Tenant channel enrollment | `links[].agent_id` on an accessible channel account. |
| Synthetic bot token | `links[].runtime.token_env`, backed by `channel_bot_agent_links`. |
| `/v1/pair-codes` | `pair_code` under a specific link. |
| `TG_BASE_URL` / `DISCORD_BASE_URL` as router service upstream config | Backend settings or account config, not user runtime manifest fields. |
| `TELEGRAM_BOT_API_BASE_URL` | Runtime projection output. |
| `DISCORD_BOT_API_BASE_URL` | Runtime projection output. |
| `DISCORD_GATEWAY_URL` | Runtime projection output. |
| `WA_WEBSOCKET_URL` | WhatsApp Baileys projection output. |
| `BLUEBUBBLES_SERVER_URL` / `BLUEBUBBLES_PASSWORD` | iMessage projection output. |

## Endpoint Security Boundary

The runtime manifest describes agent-facing configuration: SDK tokens,
pair-code setup, dotenv projection, and WhatsApp Baileys credential files. It
must not expose backend provider egress knobs such as Discord REST/Gateway
base URLs, WhatsApp Graph API base URLs, or iMessage server URLs as ordinary
runtime fields.

Provider endpoint overrides live on channel account config and are validated by
the backend when accounts are created or updated, then again before each
outbound provider call. The backend rejects private, loopback, unresolved,
HTTP, and WS targets. A runtime manifest cannot weaken that outbound network
boundary.

## Open Questions

- Whether `clawdi run` should automatically load `outputs.dotenv`, or whether
  users should pass `--env-file .env.clawdi.channels` explicitly.
- Exact target-native OpenClaw and Hermes config merge shape.
- Whether WhatsApp tenant credential reuse needs a stable manifest-local ref
  on the backend to avoid minting parallel credentials.
- Whether the backend should expose a user API to update private channel
  account config after creation. Today the manifest can create or reuse private
  bots, but not reconcile changed provider config without deletion.

## Implementation Plan

1. Add parser and validator for `clawdi.runtime.yaml`.
2. Add `clawdi runtime plan/apply/status`.
3. Implement idempotent account and link reconciliation through user APIs.
4. Implement dotenv projection with private atomic writes.
5. Implement explicit token rotation flags and missing-token warnings.
6. Add WhatsApp tenant credential materialization.
7. Add OpenClaw and Hermes target-native adapters.
8. Add CLI tests proving:
   - no admin endpoint is called,
   - private bot create/reuse is idempotent,
   - public bot reference is link-only,
   - existing one-time tokens are not silently rotated,
   - multiple bots can link to one agent with distinct token env names,
   - one bot can link to multiple agents,
   - WhatsApp writes private credential files,
   - malformed manifests fail before API mutation.
