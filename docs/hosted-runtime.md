# Hosted Runtime Design

| Field | Value |
| --- | --- |
| Status | CLI/runtime contract implemented locally; deployment rollout is out of scope |
| Last updated | 2026-06-09 |
| Owner | CLI runtime layer |

This is the canonical Markdown design document for the hosted runtime work.
All hosted runtime design material should live in Markdown.

Related deep dives:

- System architecture overview: [`architecture.md`](architecture.md)
- CLI contract: [`plans/hosted-runtime-cli.md`](plans/hosted-runtime-cli.md)
- OpenClaw/Hermes patch replacement inventory:
  [`plans/openclaw-hermes-mitm-inventory.md`](plans/openclaw-hermes-mitm-inventory.md)
- Implementation roadmap:
  [`plans/hosted-runtime-roadmap.md`](plans/hosted-runtime-roadmap.md)

## Product Goal

Hosted runtime should feel like a normal Linux system inside a Docker envelope:

1. The host only needs to run Docker and inject `CLAWDI_AUTH_TOKEN`.
2. The base image stays stable and does not bake OpenClaw, Hermes, channel
   plugins, tenant config, or endpoint patches.
3. `clawdi runtime init --non-interactive` performs one cloud-init-style
   convergence pass.
4. Selected OpenClaw/Hermes runtimes install with official installers under the
   persistent runtime user's HOME.
5. Runtime startup uses `clawdi run -- <runtime>` or
   `clawdi run -- <command>`, not Docker startup flags.
6. Channel and provider routing is expressed as named MITM profiles.
7. Shared channel protocol state is owned by Clawdi native Channels; hosted-managed
   provider traffic can route to sub2api when explicitly configured.

The target is zero source patching for OpenClaw and Hermes.

## Design Decisions

| Decision | Rationale |
| --- | --- |
| Keep the base image plain Linux | The image should be stable, cacheable, and easy to reason about. App/runtime changes belong in Clawdi CLI and upstream installers. |
| Use `clawdi` as the convergence engine | One open-source CLI owns hosted runtime init, status, diagnostics, run config, and broker lifecycle. No private `clawdi-init` binary. |
| Keep service APIs out of CLI defaults | The CLI reads a runtime source contract and does not hardcode backend paths. |
| Install runtimes as the `clawdi` user | OpenClaw/Hermes files stay in the normal runtime user's HOME and preserve official updater expectations. |
| Persist Clawdi-managed state under `/var/lib/clawdi` | This follows Linux service-state conventions and separates managed config from user HOME. |
| Keep short-lived secrets under `/run/clawdi` | Secret projections and broker CA files should be recreated each boot/run and not cached in last-good manifests. |
| Use `clawdi run` as the activation boundary | The child process keeps official behavior while Clawdi projects proxy, CA, PATH, cwd, and env from persisted config. |
| Keep MITM out of the JS CLI process | The CLI starts a managed native broker child. The broker owns CONNECT, TLS, WebSocket, profile matching, and forwarding. |
| Prefer native runtime/provider config first | MITM is only for hosted-managed policy gaps and official-behavior simulation. User BYOK provider traffic must not be silently proxied. |

## Image Anatomy

The image has five operational layers. Each layer has one owner and one
persistence rule.

### 1. Read-Only System Layer

- Owner: image build / platform
- Persistence: baked into the image, treated as read-only at runtime

| Path | Purpose |
| --- | --- |
| `/usr/local/bin/clawdi` | Stable launcher or entrypoint for the managed CLI. |
| `/etc/clawdi/host-policy.json` | Host policy, denied local mutations, and hosted-mode constraints. |
| `/etc/clawdi/runtime-source.json` | Read-only datasource contract for runtime desired state. |
| `/usr/bin/supervisord` | Standard process manager for enabled long-running runtimes. |
| `/usr/bin/node` and npm tooling | Required for the npm-managed Clawdi CLI package and normal user workflows. |

The image should not contain:

- OpenClaw or Hermes app packages;
- channel plugins;
- channel runtime state;
- tenant credentials;
- endpoint patches;
- a legacy runtime tree;
- paths named after `agent-image-v2`.

`agent-image-v2` is a repository directory name only.

### 2. Persistent Runtime HOME

- Owner: ordinary runtime user, normally `clawdi`
- Persistence: persistent volume across container restarts

| Path | Purpose |
| --- | --- |
| `/home/clawdi` | Runtime user's HOME. Official runtime installers write here. |
| `/home/clawdi/clawdi` | Default workspace visible to agents and user workflows. |
| `/home/clawdi/.openclaw` | OpenClaw official app root. |
| `/home/clawdi/.openclaw/bin/openclaw` | OpenClaw executable expected by generated run config. |
| `/home/clawdi/.hermes` | Hermes app state/root when created by its official installer. |
| `/home/clawdi/.local/bin/hermes` | Hermes executable expected by generated run config. |

Requirement: if `runtime init` starts as root/system, official OpenClaw/Hermes
installers must drop to `CLAWDI_RUNTIME_USER` before writing HOME-local files.

### 3. Persistent Clawdi Service State

- Owner: Clawdi init/maintenance context
- Persistence: persistent volume across container restarts

| Path | Purpose |
| --- | --- |
| `/var/lib/clawdi/bin/clawdi` | Active managed CLI entrypoint. |
| `/var/lib/clawdi/npm` | Managed npm prefix for the CLI package. |
| `/var/lib/clawdi/npm-cache` | Managed npm cache. |
| `/var/lib/clawdi/config/clawdi.json` | Managed non-secret Clawdi config. |
| `/var/lib/clawdi/config/run/{hermes,openclaw}.json` | Persisted runtime launch contracts consumed by `clawdi run`. |
| `/var/lib/clawdi/config/mitm/profiles.json` | Non-secret MITM profile bundle. |
| `/var/lib/clawdi/cache/manifest.last-good.json` | Non-secret last-good manifest for degraded offline boot. |
| `/var/lib/clawdi/install-inventory/*.json` | Per-runtime install/present/disabled/failed status. |
| `/var/lib/clawdi/supervisor/supervisord.conf` | Generated standard supervisor config. |
| `/var/lib/clawdi/status/cli-bootstrap.json` | CLI bootstrap/update status. |

Normal user flows can execute the CLI, but should not hand-edit Clawdi-managed
state or mutate the managed npm prefix.

### 4. Ephemeral Runtime State

- Owner: Clawdi runtime / current boot
- Persistence: tmpfs or recreated on container restart

| Path | Purpose |
| --- | --- |
| `/run/clawdi/instance-data.json` | Non-secret per-boot instance metadata. |
| `/run/clawdi/instance-data-sensitive.json` | Redacted sensitive status marker. |
| `/run/clawdi/mitm/secrets.json` | Short-lived secret values for broker `secretRef` gates. |
| `/run/clawdi/mitm/brokers/<id>/ca.pem` | Per-invocation broker CA projected into child env. |
| `/run/clawdi/supervisor.sock` | Supervisor control socket. |
| `/tmp` | Normal temporary scratch for installers and tools. |

Secrets must not be written into:

- last-good manifests;
- npm state;
- shell startup files;
- OpenClaw/Hermes source patches;
- Docker args beyond the single runtime auth token injection.

### 5. External Services

- Owner: corresponding backend/service teams
- Persistence: outside the runtime container

| Service | Purpose |
| --- | --- |
| Runtime source | Endpoint configured by `/etc/clawdi/runtime-source.json`; returns a manifest and `secretValues`. |
| npm registry | Standard `clawdi` package update channel. |
| OpenClaw official installer | OpenClaw install/update authority. |
| Hermes official installer | Hermes install/update authority. |
| Clawdi native Channels | Shared Telegram, Discord, WhatsApp, iMessage, and Kobb-compatible channel control plane. |
| sub2api | Hosted-managed OpenAI/Codex-compatible provider gateway. |

## Boot Sequence

`clawdi runtime init --non-interactive` is the hosted runtime convergence
command. It is not a monorepo API client. The CLI reads a datasource contract
from `/etc/clawdi/runtime-source.json` by default, or from
`CLAWDI_RUNTIME_SOURCE_PATH` when explicitly overridden. `CLAWDI_RUNTIME_MANIFEST_PATH`
is only a local fixture/simulation escape hatch.

Example runtime source:

```json
{
  "schemaVersion": "clawdi.runtimeSource.v1",
  "type": "http",
  "url": "https://runtime-source.example.test/manifest",
  "auth": {
    "type": "bearer-env",
    "env": "CLAWDI_AUTH_TOKEN"
  },
  "timeoutMs": 15000
}
```

Boundary:

- `clawdi` CLI owns local convergence, validation, official installer
  execution, local state projection, supervisor config, `clawdi run`, and MITM
  broker lifecycle.
- The external runtime source owns manifest generation and secret resolution.
  Platform policy and UI remain outside this CLI contract.
- The runtime source contract is the only wire boundary between them.

| Step | Action | Expected result |
| --- | --- | --- |
| 1 | Detect hosted mode through host policy or explicit runtime mode. | Missing or invalid policy fails closed for mutation commands while recovery commands remain available. |
| 2 | Check runtime credential. | `CLAWDI_AUTH_TOKEN` is present, or a last-good manifest exists for allowed offline boot. |
| 3 | Fetch desired state from the configured runtime source. | Manifest generation, selected runtimes, channels, providers, and recovery policy are validated. |
| 4 | Cache non-secret desired state. | `/var/lib/clawdi/cache/manifest.last-good.json` is written without secret values. |
| 5 | Project short-lived secrets. | `/run/clawdi/mitm/secrets.json` is written only when secret values are returned. |
| 6 | Install selected runtimes. | Enabled OpenClaw/Hermes entries use official installers under `/home/clawdi`; disabled entries are skipped. |
| 7 | Write run contracts. | `/var/lib/clawdi/config/run/*.json`, MITM profiles, supervisor config, install inventory, status, and result files are written. |
| 8 | Start managed runtime processes. | Standard `supervisord` launches enabled long-running runtimes through `clawdi run -- <runtime>`. |

## Runtime Launch Sequence

Hosted runtime startup is not configured through runtime-specific Docker args.
`clawdi run` reads persisted local state.

For runtime commands:

```bash
clawdi run -- hermes
clawdi run -- openclaw
```

For generic hosted commands:

```bash
clawdi run -- codex exec ...
clawdi run -- node script.js
```

Launch behavior:

1. Read runtime run config from
   `/var/lib/clawdi/config/run/{runtime}.json` when the command is a managed
   runtime.
2. For generic commands, use the managed profile bundle directly when hosted
   mode has `/var/lib/clawdi/config/mitm/profiles.json`.
3. If no enabled MITM profiles exist, exec the child with normal env/PATH/cwd.
4. If profiles exist, start the native `clawdi-mitm-broker` bundle as a managed
   child process.
5. Wait for broker readiness and receive its actual proxy URL and generated CA
   path.
6. Project child-visible env:

   ```text
   HTTPS_PROXY
   HTTP_PROXY
   https_proxy
   http_proxy
   NO_PROXY
   NODE_USE_ENV_PROXY
   OPENCLAW_PROXY_URL
   SSL_CERT_FILE
   NODE_EXTRA_CA_CERTS
   REQUESTS_CA_BUNDLE
   CURL_CA_BUNDLE
   GIT_SSL_CAINFO
   DENO_CERT
   CODEX_CA_CERTIFICATE
   ```

7. Strip hosted control env before launching the child:

   ```text
   CLAWDI_AUTH_TOKEN
   CLAWDI_MITM_ENABLED
   CLAWDI_MITM_PROFILE_BUNDLE
   CLAWDI_MITM_PROXY_URL
   CLAWDI_MITM_PROXY_HOST
   CLAWDI_MITM_PROXY_PORT
   CLAWDI_MITM_CA_FILE
   CLAWDI_MITM_CA_PATH
   CLAWDI_MITM_SECRET_FILE
   CLAWDI_MITM_BROKER_PATH
   CLAWDI_MITM_BROKER_BUNDLE
   CLAWDI_MITM_ALLOW_REMOTE_PROXY
   ```

8. Exec the upstream child process and stop the broker when the child exits.

When the hosted runtime has enabled MITM profiles, `supervisord` starts
`clawdi run` from the system context. `clawdi run` starts the native broker
there, then drops only the upstream child process to `CLAWDI_RUNTIME_USER`
through `gosu` or `runuser`. The child keeps normal OpenClaw/Hermes/Codex
behavior and receives only standard proxy/CA env plus placeholder provider env.
It does not receive `CLAWDI_AUTH_TOKEN` or `CLAWDI_MITM_SECRET_FILE`.

## MITM Profile Model

Profiles are non-secret JSON generated by `runtime init`. They describe
matching, rewrite, and logging policy. Secret values live in `secretRef` entries
and short-lived runtime files.

Profile bundle path:

```text
/var/lib/clawdi/config/mitm/profiles.json
```

Secret value path:

```text
/run/clawdi/mitm/secrets.json
```

The containing directory is root-owned and not writable by the ordinary runtime
user. The CA file remains readable by the child process, while
`secrets.json` is root-owned and mode `0600`. It is readable by the broker
process and intentionally unreadable by the ordinary `clawdi` agent user.

Current productized profile IDs generated from the hosted runtime manifest are
provider profiles only. Channel profiles are no longer generated from
`manifest.channels`; channel routing is owned by cloud-api native channels and
scoped `agent_token` runtime configuration.

| Profile ID | Kind | Match | Route target |
| --- | --- | --- | --- |
| `codex-openai-responses` | Provider | `api.openai.com/v1/responses` + Bearer authorization when `apiKeySecretRef` is present | Clawdi-managed sub2api `/v1/responses` gateway |
| `codex-chatgpt-backend-responses` | Provider | `chatgpt.com/backend-api/codex/responses` + any Bearer authorization when `apiKeySecretRef` is present | Clawdi-managed sub2api `/backend-api/codex/responses` gateway; authorization is replaced from secretRef |

Profile constraints:

- `rewrite.upstreamBaseUrl` must use `http`, `https`, `ws`, or `wss`.
- `rewrite.upstreamBaseUrl` must not include credentials.
- Profile bundle JSON must not contain secret values.
- Broker defaults to loopback-only listening unless explicitly allowed for
  tests.
- Broker strips hop-by-hop headers, proxy-scoped auth headers, and upstream
  `Set-Cookie` responses.
- User BYOK provider traffic must not be silently proxied.

## Agent Vault Alignment

The MITM boundary intentionally follows Agent Vault's mature shape where it
fits the hosted runtime product:

- `clawdi run -- <command>` is the same wrapper boundary as
  `agent-vault run -- <command>`.
- The child receives standard `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`,
  Node/OpenClaw proxy hints, and CA trust env vars.
- The broker is a native Go HTTP forward proxy that owns CONNECT, TLS leaf
  minting, HTTP/1.1 forwarding, WebSocket upgrades, and header hygiene.
- Profiles are explicit service rules; secret values stay outside the profile
  JSON and are resolved through `secretRef` gates.
- The broker runs from the system context and the upstream agent child is
  dropped to the ordinary runtime user, so broker secret files are not readable
  from OpenClaw/Hermes/Codex.

Intentional differences:

- Clawdi strips `CLAWDI_AUTH_TOKEN` from the child. Agent Vault can expose its
  scoped token because that token is a broker credential; Clawdi's auth token is
  a full runtime/control credential.
- Clawdi defaults unmatched requests to deny. Agent Vault defaults unmatched
  hosts to passthrough unless a vault is put into strict deny mode. Hosted
  runtime should be stricter because Channels/sub2api routes are managed
  desired state, not local developer convenience. Clawdi v1 intentionally does
  not expose a passthrough profile kind.
- Clawdi's local broker has no `Proxy-Authorization` challenge in the normal
  loopback path. Remote proxy listening is for tests only unless a separate
  authenticated proxy boundary is added.
- Clawdi v1 profiles match and rewrite request metadata, but do not do
  placeholder substitution inside request bodies or WebSocket text frames. Use
  native provider projection or Clawdi Channels bridge surfaces for those cases.
- Clawdi channel routing is endpoint routing, not request body
  transformation. Runtime configs must use official-looking endpoints and
  scoped `agent_token` values; real platform credentials stay in cloud-api.
- Clawdi hosted runtime is not a network sandbox by itself. Strong bypass
  prevention requires Docker/network policy such as an egress-locked container
  mode; env-based proxying alone is cooperative.

## Channel Boundary

Hosted v2 channels are Clawdi-native channel resources. cloud-api provisions or
selects channel accounts and returns scoped `agent_token` values through the
native channel API. They are not represented as top-level hosted manifest
`channels` entries.

| Channel | Boundary |
| --- | --- |
| Telegram | Agent uses Bot API-shaped paths with scoped `agent_token`; cloud-api maps to the real bot token server-side. |
| Discord | Agent uses Discord REST/Gateway-shaped traffic with scoped `agent_token`; cloud-api maps to the real bot token server-side. |
| WhatsApp | Agent connects to the Clawdi native bridge; protocol state stays in cloud-api. |
| iMessage | Agent uses the BlueBubbles-compatible surface with scoped `agent_token`; cert/password material stays in cloud-api. |

The CLI must not add a private RPC route for channel control.

## Codex / Provider Boundary

Codex source check: `@openai/codex@0.136.0` maps to upstream tag
`rust-v0.136.0` (`7ca611348db9446711ed16ed81c84095e3721cee`). In that source,
Codex builds Requests API calls from provider `base_url` plus `responses`,
defaults OpenAI API-key mode to `https://api.openai.com/v1`, supports native
`model_providers.*.base_url`, `wire_api = "responses"`, and `env_key`, and
honors custom CA through `CODEX_CA_CERTIFICATE` / `SSL_CERT_FILE`.

Product decision:

- Hosted-managed Codex can use MITM so the child still sees official
  `https://api.openai.com/v1/responses` behavior.
- Hosted-managed OpenClaw Codex uses OpenClaw's native `openai` provider with
  `openai-chatgpt-responses`, so the child sees
  `https://chatgpt.com/backend-api/codex/responses`; the broker rewrites that
  to the managed sub2api Codex backend path and injects the managed provider
  bearer token.
- Hosted-managed OpenClaw/Hermes config must not contain the managed sub2api
  URL or managed provider token. The agent config uses the official
  ChatGPT/Codex endpoint plus a non-secret `CLAWDI_PROVIDER_PLACEHOLDER_TOKEN`
  value only; the real upstream URL and bearer token live in MITM profile
  policy and `secretRef` material.
- Ordinary OpenAI-compatible providers that do not need official OpenAI/Codex
  endpoint simulation should use native provider projection/direct provider
  URLs.
- Managed provider routing must not project provider pool/group selection into
  the agent environment. Provider selection stays in the runtime source and
  profile policy.

## Clawdi CLI Update Model

Hosted runtime CLI updates belong to the standalone `clawdi` repo and the
standard npm package channel.

| Component | Update authority |
| --- | --- |
| Base image | Runtime platform image pipeline. |
| Clawdi CLI | npm-managed `clawdi` package. |
| Native broker | `clawdi-mitm-broker/` bundle shipped with the CLI package. |
| OpenClaw | OpenClaw official installer/updater behavior. |
| Hermes | Hermes official installer/updater behavior. |

The target hosted shape is:

- read-only `/usr/local/bin/clawdi` launcher;
- active managed CLI entrypoint at `/var/lib/clawdi/bin/clawdi`;
- root/system-owned npm prefix at `/var/lib/clawdi/npm`;
- normal user execution allowed;
- normal user mutation of the managed install/config denied by host policy.

## Current Verification

The current branch has local and CI coverage for the non-secret path.

Focused local checks used during the implementation:

```bash
bun run --filter clawdi typecheck
go test ./...
bun test --isolate --max-concurrency=1 \
  packages/cli/tests/runtime.test.ts \
  packages/cli/tests/runtime-mitm-env.test.ts \
  packages/cli/tests/runtime-mitm-profiles.test.ts \
  packages/cli/tests/runtime-mitm-broker.test.ts \
  packages/cli/tests/commands/run.test.ts \
  packages/cli/tests/smoke.test.ts
CLAWDI_MITM_BROKER_BUNDLE_OUTDIR=clawdi-mitm-broker \
  bun run --cwd packages/cli build:mitm-broker
bun run --cwd packages/cli check:publish-manifest
```

External runtime smoke should cover official runtime installers, real
Channels credentials, provider gateway credentials, restart behavior, and
inbound bot canaries. That smoke belongs to the runtime platform, not this CLI
package.

## Release Readiness

This slice is ready for npm-package integration and external runtime-platform
staging.

Ready:

- runtime init/status/doctor commands;
- hosted path resolver and host policy parser;
- runtime source fetch/cache path;
- selected official install for OpenClaw/Hermes;
- persisted run configs;
- generated standard supervisor config;
- self-contained native broker bundle;
- profile validation and broker tests;
- CLI CI and publish payload checks.

Production blockers:

- external channel activation must ensure per-channel credentials before
  publishing a new manifest generation;
- runtime source manifests must expose per-channel secret refs for precise
  generated profiles;
- real npm publish/update channel must be promoted;
- runtime-platform staging and real external bot-message canary have not run
  yet;
- Channels/provider-gateway runtime smoke remains external to this CLI PR;
- daemon/control RPC full-suite flake remains an unrelated residual risk even
  though the failing shard passes when rerun directly.

## Source Map

| Area | File |
| --- | --- |
| System architecture overview | `docs/architecture.md` |
| Runtime manifest contract and datasource normalization | `packages/cli/src/runtime/manifest-contract.ts`, `packages/cli/src/runtime/manifest-source.ts` |
| Runtime convergence, official install, profiles, supervisor config | `packages/cli/src/runtime/manifest.ts` |
| Path contract | `packages/cli/src/runtime/paths.ts` |
| Run wrapper | `packages/cli/src/commands/run.ts` |
| MITM env projection | `packages/cli/src/runtime/mitm-env.ts` |
| Profile schema | `packages/cli/src/runtime/mitm-profiles.ts` |
| Native broker | `packages/cli/native/mitm-broker/main.go` |
| Broker tests | `packages/cli/tests/runtime-mitm-broker.test.ts` |
| Runtime tests | `packages/cli/tests/runtime.test.ts` |
| CLI contract | `docs/plans/hosted-runtime-cli.md` |
| OpenClaw/Hermes patch replacement inventory | `docs/plans/openclaw-hermes-mitm-inventory.md` |
