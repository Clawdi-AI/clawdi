# Managed Runtime Contract

| Field | Value |
| --- | --- |
| Status | Public runtime contract |
| Last updated | 2026-07-01 |
| Owner | CLI runtime layer |

This document describes the public Clawdi CLI and dashboard contract for managed
runtime environments. It intentionally avoids deployment-specific topology,
private service details, live service hosts, and internal runtime orchestration.

Related public docs:

- CLI notes: [`plans/managed-runtime-cli.md`](plans/managed-runtime-cli.md)
- Roadmap: [`plans/managed-runtime-roadmap.md`](plans/managed-runtime-roadmap.md)
- Projection boundary:
  [`plans/runtime-projection-boundary.md`](plans/runtime-projection-boundary.md)

## Scope

The open-source CLI owns local runtime convergence, explicit `clawdi run`
env-injection, runtime UI bridging, and diagnostics. The web app owns the
hosted deployment dashboard surfaces, including Control UI and Terminal tabs. A
separate control plane may provide desired state, credentials, terminal
authorization, rollout policy, and deployment lifecycle, but that
platform-specific implementation is outside this repository.

The public contract covers:

- validating runtime desired state;
- installing or verifying supported agent runtimes through their normal
  installers;
- writing non-secret local run configuration;
- projecting short-lived secrets only for the current runtime session;
- running final hosted runtimes from direct process-manager entries that name
  official Hermes/OpenClaw binaries;
- running Clawdi-owned support programs under the runtime process manager;
- supporting explicit `clawdi run -- <command>` when a caller opts into Clawdi
  runtime env injection;
- optionally proxying runtime browser UIs through the sidecar bridge module when
  Clawdi, rather than the official runtime or platform ingress, owns browser
  auth and header policy;
- exposing a dashboard Terminal contract for one deployment shell;
- reporting status and diagnostics through runtime commands.

The public contract does not cover:

- deployment-specific topology;
- private control-plane endpoints;
- tenant or billing policy;
- internal service implementation;
- image build pipelines or platform rollout details.

## Core Architecture

The primary hosted runtime model is a Linux-like runtime host. The host image
provides the OS envelope, a runtime user, a stable `clawdi` bootstrap path,
official Hermes/OpenClaw installs, and a process manager. Runtime behavior
comes from the manifest and official runtime binaries, not from per-agent
wrappers.

```mermaid
flowchart TB
    CP[Hosted runtime manifest] --> Init[clawdi runtime init]
    Init --> Durable
    Init --> Ephemeral
    Ephemeral --> Supervisor[supervisord or equivalent]

    subgraph Durable["Durable non-secret state: /var/lib/clawdi"]
        RunConfigs[config/run/<runtime>.json]
        Projections[config/projections/<runtime>.json]
        Inventory[install-inventory/<runtime>.json]
        CliBin[managed bin/clawdi]
    end

    subgraph Ephemeral["Ephemeral runtime state: $CLAWDI_RUN_DIR"]
        SupervisorConfig[supervisor/supervisord.conf]
        Secrets[secrets and auth-token files]
        MitmCA[mitm/supervisor/ca.pem + sidecar-private key]
    end

    subgraph Support["Clawdi support programs"]
        Watch[clawdi runtime watch]
        Daemon[clawdi daemon run]
        Sidecar[optional clawdi runtime sidecar]
        Bridge[bridge module]
        Mitm[MITM module]
    end

    subgraph Runtime["Official runtime programs"]
        HermesGateway[hermes gateway run]
        HermesDashboard[hermes dashboard]
        OpenClaw[openclaw gateway run]
    end

    Supervisor --> Watch
    Supervisor --> Daemon
    Supervisor --> Sidecar
    Sidecar --> Bridge
    Sidecar --> Mitm
    Supervisor --> HermesGateway
    Supervisor --> HermesDashboard
    Supervisor --> OpenClaw

    Bridge -->|optional Control UI proxy| HermesDashboard
    Bridge -->|optional Control UI proxy| OpenClaw
    Mitm -. proxy URL + CA trust .-> HermesGateway
    Mitm -. proxy URL + CA trust .-> HermesDashboard
    Mitm -. proxy URL + CA trust .-> OpenClaw
```

`supervisord` is an implementation choice, not a behavior boundary. The
important contract is that each long-running program is declared directly with
its official command, args, cwd, and env. The supervisor entry must not point at
`clawdi run -- openclaw`, `clawdi run -- hermes`, a generated launch shell, or a
PATH shim.

The Linux-like host preserves official updater behavior. If a user or an
official UI runs `openclaw update` or `hermes update`, PATH resolves to the
official binary. Clawdi does not intercept that command. After an updater
replaces files, the process manager may restart the relevant official program,
but the update transaction remains owned by the runtime.

Hermes gateway and dashboard are separate official commands in this model. A
deployment that needs both declares both supervisor programs explicitly. The
dashboard is the browser Control UI surface. The gateway is still supervised
directly, but it is not treated as a bridge target unless a deployment configures
an actual HTTP/WebSocket listener for it. This mimics the useful process fan-out
of the Hermes official Docker image without adopting Docker image rollout as the
update mechanism.

### Runtime Host Contents

| Area | Contains | Must not contain |
| --- | --- | --- |
| Host envelope | runtime user, home directory, base packages, process manager, host policy | runtime-specific shell wrappers |
| Clawdi | managed `clawdi`, native `clawdi-mitm-sidecar`, status/doctor tooling | per-agent command shims |
| Hermes | official install and official `hermes` binary | Clawdi-owned `hermes` wrapper |
| OpenClaw | official install and official `openclaw` binary | Clawdi-owned `openclaw` wrapper |
| Runtime state | `/var/lib/clawdi`, `$CLAWDI_RUN_DIR`, workspace, short-lived secret files | durable plaintext provider secrets |

The host should not add:

- `/usr/local/bin/openclaw` or `/usr/local/bin/hermes` wrappers owned by
  Clawdi;
- generated launch scripts that call `clawdi run -- openclaw` or
  `clawdi run -- hermes`;
- a Clawdi process as PID 1 for Hermes or OpenClaw;
- direct public exposure of `--auth none` runtime ports.

The image must not contain per-agent command wrappers, generated launch scripts,
or PATH shims for `openclaw`, `hermes`, or future runtime names. Official
runtime commands still resolve to official binaries, so native commands such as
`openclaw update` and `hermes update` keep their own updater behavior.

## Support Module Boundaries

The Clawdi support programs run under the same process manager as the runtime
programs. `clawdi runtime sidecar` is one support process with optional modules,
and those modules keep explicit authority boundaries:

| Module | Starts when | Direction | Sensitive input | Network exposure | Must not own |
| --- | --- | --- | --- | --- | --- |
| manifest/watch | an auth token file exists | control-plane polling | Clawdi auth token from file | outbound API only | official runtime PID 1 |
| live-sync daemon | `liveSync.agents` is non-empty | live sync and local daemon APIs | Clawdi auth token from file | local daemon surface | MITM rewrite policy |
| sidecar bridge module | `bridge.surfaces` is non-empty and platform chooses Clawdi auth/proxy | browser reverse proxy | bridge token only | declared listen ports | outbound MITM policy |
| sidecar MITM module | enabled MITM profiles exist | runtime outbound proxy | profile bundle, CA cert/key under `$CLAWDI_RUN_DIR`, optional secret file | loopback/private proxy | live-sync/API authority |
| official runtime program | runtime is enabled | normal runtime behavior | runtime-specific env/config only | official runtime ports | Clawdi auth secrets |

The sidecar is still not a hidden wrapper around Hermes/OpenClaw. It only hosts
Clawdi-owned support modules; official runtime programs remain direct process
manager entries.

The MITM module keeps its root CA certificate and private key under the
ephemeral run directory so a sidecar restart does not change the trust root for
already-running runtimes. Runtime programs receive only the CA certificate path
as trust env; the private key path is not projected into runtime env.

The sidecar bridge module is optional, not a replacement for official ports. If
the platform exposes the official ports behind trusted ingress auth and the
runtime native UI works with that auth/CORS/path policy, the bridge can be
disabled. If Clawdi needs cookie/token auth, tenant isolation, CSP/header
rewriting, WebSocket/SSE mediation, or a single hosted Control UI URL, the
bridge remains the correct inbound module.

### Official Container Reference Research

Official runtime images are useful references, but they are not the primary
hosted architecture while in-place official UI updates are a requirement:

| Image | Useful reference | Update implication |
| --- | --- | --- |
| `nousresearch/hermes-agent` | s6 starts `hermes gateway run` and, with `HERMES_DASHBOARD=1`, also starts `hermes dashboard`; ports are `8642` and `9119` | Docker installs update by pulling/recreating the image, so dashboard update cannot be the normal in-place updater path |
| `ghcr.io/openclaw/openclaw` | `tini` runs the gateway; official container rejects unauthenticated non-loopback binds; `--auth token --bind auto` works for directly exposed ports | Docker installs update by image rollout; in-place `openclaw update` belongs to non-Docker installs |

The Linux-like host can adopt these lessons without switching to container
rollout updates: declare Hermes gateway and dashboard as separate official
supervisor programs, keep OpenClaw loopback when behind the bridge, and require
runtime-native auth when exposing the official OpenClaw port directly.

## Manifest Shapes

The CLI accepts two related shapes:

- `clawdi.hosted-runtime.manifest.v1` is the hosted control-plane response
  shape. It can include `system`, `controlPlane`, `clawdiCli`, `runtimes`,
  `providers`, `liveSync`, `mitmProfiles`, `mcp`, `tools`, and `recovery`.
- `clawdi.runtimeDesiredState.v1` is the normalized internal convergence shape
  consumed by `runtime init`.

Normalization maps hosted fields into the internal shape:

| Hosted field | Internal purpose |
| --- | --- |
| `deploymentId`, `environmentId`, `instanceId`, `generation` | Identity, cache keys, status, and idempotence |
| `system.home`, `system.workspace` | Runtime HOME and workspace root |
| `controlPlane.manifestUrl`, `controlPlane.cloudApiUrl` | Manifest datasource and API origin |
| `clawdiCli.packageSpec` | System-managed CLI package selection |
| `runtimes.<name>.enabled` | Run config and supervisor program state |
| `runtimes.<name>.install` | Supported official installer input |
| `runtimes.<name>.run` | Command, args, cwd, env, and PATH projection |
| `runtimes.<name>.services` | Runtime-owned auxiliary processes, such as a browser dashboard, supervised without user command shims |
| `bridge.surfaces` | Optional authenticated runtime surface listen/upstream mappings |
| `providers` | Runtime-scoped AI provider projections and secret refs |
| `mcp`, `tools` | Runtime MCP/tool projection input |
| `liveSync` | Optional daemon sync configuration |
| `mitmProfiles` | Explicit local sidecar profiles |
| `recovery` | Manifest cache and offline-boot behavior |

Manifest validation is defensive. Enabled built-in runtimes must use the
expected official installer metadata unless they provide an explicit run
command. Unknown runtime names require `run.command`; otherwise the manifest is
rejected so the image does not need to know every future agent.

## Commands

Runtime operators can use these commands in controlled environments:

```bash
clawdi runtime init --non-interactive
clawdi runtime watch
clawdi runtime sidecar
clawdi runtime status --json
clawdi runtime doctor --json
clawdi run -- <command>
```

Normal local onboarding still uses `clawdi setup`. Runtime commands are for
managed environments where configuration is supplied by policy or a manifest,
not by an interactive user setup flow.

`runtime watch` is the long-running reconciliation loop. It refreshes remote
manifest state using ETags, applies changes, records status, and falls back to
last-good cached manifests only when recovery policy allows it. `runtime
sidecar` is the single Clawdi support process for optional runtime-local modules:
the bridge module exposes manifest-declared browser surfaces behind hosted access
controls, and the MITM module proxies outbound runtime traffic when explicit
MITM profiles are enabled.

The current hosted bridge surfaces are browser-facing runtime UIs. Each surface
declares its listen address, upstream target, protocol behavior, auth model, and
header rewrite rules. The bridge must not become a generic arbitrary-port
forwarder. Terminal is deliberately out of scope because it is a shell-exec
authorization path, not a browser UI proxy.

## Bridge Policy

The sidecar bridge module stays in the architecture as an optional inbound
module. The default safe mode is bridge-on with loopback runtime upstreams.
Direct official port exposure is an explicit manifest/platform choice.

| Mode | Runtime bind/auth | External exposure | Bridge |
| --- | --- | --- | --- |
| Bridge mode | runtime may bind loopback and use local/no auth | Dashboard reaches the runtime through Clawdi access controls | enabled |
| Direct official port mode | runtime must use runtime-native auth or trusted ingress auth | Platform ingress exposes the official runtime port | disabled or bypassed |

Use bridge mode when Clawdi owns browser-facing auth, tenant isolation,
cookie/token handling, CSP/frame header rewriting, WebSocket/SSE mediation, or a
single hosted Control UI URL. Disable the bridge only when platform ingress and
the official runtime together cover those responsibilities.

## Desired State Boundary

The CLI consumes a desired-state document plus optional secret values. The
desired state should contain only non-secret configuration such as enabled
runtimes, command launch settings, channel projections, and provider routing
metadata. Secret values are delivered separately and must not be cached in
plain text.

At the boundary:

- the control plane owns desired-state generation and secret resolution;
- the CLI owns local validation, projection, diagnostics, and command launch;
- the runtime process owns normal agent behavior after launch.

The CLI writes durable non-secret state under the service state root. Important
outputs include:

| Output | Purpose |
| --- | --- |
| `config/clawdi.json` | Redacted managed runtime config |
| `sync/runtimes.json` | Runtime sync state |
| `cache/manifest.last-good.json` | Last accepted manifest |
| `cache/manifest.etag`, `cache/channels.etag` | Remote refresh cache validators |
| `install-inventory/<runtime>.json` | Install/verify observation |
| `config/projections/<runtime>.json` | Runtime projection payload |
| `config/run/<runtime>.json`, `config/run/<runtime>+<service>.json` | `clawdi run` launch config for runtime main processes and internal runtime-owned services |
| `$CLAWDI_RUN_DIR/secrets/*` | Short-lived token and secret files for the current runtime session |
| `$CLAWDI_RUN_DIR/supervisor/supervisord.conf` | Ephemeral process plan for Clawdi support programs and official runtime programs |

Short-lived secrets belong under the runtime run directory, not in durable
config. Status and diagnostic output must redact secrets.

## Command And Launch Model

`clawdi run -- <command>` is a local vault-injection command and an interactive
hosted shell boundary. In hosted mode, it first tries to resolve the command
against a generated runtime run config. If a matching enabled config exists, it
launches that runtime with the configured command, args, cwd, env, PATH, secret
refs, and optional sidecar profile. If the config exists but is disabled,
`clawdi run` exits with a disabled-runtime error.

Interactive shell commands are not intercepted. `openclaw`, `hermes`, and
future runtime names resolve to official binaries on PATH. Clawdi only
participates when the caller explicitly invokes `clawdi run` or when
`runtime init` projects manifest-selected config.

Hosted daemon startup avoids `clawdi run`. `runtime init` renders private
`$CLAWDI_RUN_DIR/supervisor/supervisord.conf` entries that contain the official
binary, args, cwd, and env:

```ini
command='/home/clawdi/.openclaw/bin/openclaw' 'gateway' 'run' '--allow-unconfigured' '--auth' 'none' '--bind' 'loopback' '--force'
directory=/home/clawdi/clawdi
environment=HOME="/home/clawdi",PATH="/home/clawdi/.openclaw/bin:..."
```

When bridge surfaces or MITM profiles are enabled, supervisor runs one Clawdi
support process (`clawdi runtime sidecar`). Bridge token/surface config and MITM
profile/CA config stay inside that sidecar process. Runtime programs receive
only final proxy and CA env such as `HTTPS_PROXY`, `OPENCLAW_PROXY_URL`, and
`NODE_EXTRA_CA_CERTS`; sidecar control env and secret-file paths stay out of the
official runtime process.

Hermes has multiple official long-running surfaces. The Linux-like host should
declare `hermes gateway run` and `hermes dashboard --host 127.0.0.1 --no-open`
as separate official supervisor programs when both are needed. Clawdi should not
emulate that fan-out with shell wrappers.

OpenClaw's bridge-only hosted default stays loopback and unauthenticated because
the runtime is reachable only through the Clawdi bridge and hosted access
controls:

```bash
openclaw gateway run --allow-unconfigured --auth none --bind loopback --force
```

Production manifests should provide OpenClaw configuration and a real gateway
token or password when the official OpenClaw port is exposed directly. The
official Docker test showed `--auth none --bind lan` fails closed; direct-port
manifests should use runtime-native auth and a non-loopback/container-aware
bind such as `--auth token --bind auto`. `--allow-unconfigured` is acceptable
for development, diagnostics, or first-boot recovery, but it should not hide
missing production configuration.

## Official Update Compatibility

Supervisor is compatible with official updater behavior only when it stays a
process manager:

- supervisor entries name official binaries directly;
- install roots are writable by the runtime user expected by the official
  installer;
- `openclaw`, `hermes`, and their update subcommands are not shadowed by
  Clawdi wrappers or PATH shims;
- `clawdi run` is used only when explicitly requested by a caller;
- after an updater replaces files, the process manager restarts the relevant
  official programs, or autorestart picks them up when they exit.

The update transaction belongs to Hermes/OpenClaw. Clawdi may observe status,
surface diagnostics, and restart programs, but it must not emulate or wrap
`hermes update` or `openclaw update`.

Runtime-owned services use the same generated run-config and supervisor model,
but they are not user commands and do not receive command shims. A manifest entry
such as `runtimes.hermes.services.dashboard` writes
`config/run/hermes+dashboard.json` and supervisor starts the official command
directly:

```ini
command='hermes' 'dashboard' '--host' '127.0.0.1' '--no-open'
```

This covers browser helper processes such as a runtime dashboard while keeping
the user's shell PATH clean: typing `hermes` enters the managed Hermes runtime,
not a dashboard alias.

## Provider And Channel Routing

Provider configuration uses standard Clawdi AI Provider modes:

- `openai_chat`;
- `openai_responses`;
- `anthropic_messages`;
- `google_generate_content`.

Agent-specific transport details belong to the target runtime projection layer.
For example, if a runtime needs a target-native transport name, the CLI maps the
standard provider contract into that runtime's configuration format at launch
time. The Clawdi provider model itself should stay provider-oriented, not
runtime-transport-oriented.

Channel configuration follows the same rule: the open-source contract describes
the local projection shape and validation rules, while service-specific channel
control planes remain outside this repository.

## Runtime UI And Terminal

Hosted deployment pages expose two live surfaces:

- **Control UI** embeds or links to the runtime's browser UI. It can use the
  official runtime port directly when platform ingress owns auth and header
  policy, or the sidecar bridge module when Clawdi owns those browser-facing
  controls. It is runtime-specific and should be labelled as `<Runtime> Control
  UI`.
- **Terminal** opens a shell for the deployment. It is not split per agent; a
  deployment has one Terminal surface.

```mermaid
flowchart LR
    Dashboard[Dashboard] -->|Control UI URL| Ingress[Platform ingress]
    Ingress -->|direct mode| RuntimeUI[Official runtime UI port]
    Ingress -->|bridge mode| Bridge[sidecar bridge module]
    Bridge --> RuntimeUI
    Dashboard -->|Terminal WebSocket| HostedAPI[Hosted API]
    HostedAPI --> Shell[Deployment shell<br/>default runtime user]
```

The browser Terminal contract is:

1. The dashboard calls `POST /v2/deployments/{deployment_id}/terminal`.
2. The API returns a short-lived `websocket_url`.
3. The frontend removes any fragment token from the URL and sends it as a
   WebSocket subprotocol named `clawdi-terminal.<token>` when possible.
4. The frontend also sends the `tty` subprotocol and uses tty-style frames:
   `0` for terminal input/output and `1` for resize.
5. The terminal uses xterm, auto-fits to the panel, focuses on pointer down, and
   switches theme when the dashboard switches light/dark mode.

The service-side implementation is outside this repository. It must
authenticate the user, require the deployment to be running, bind the terminal
token to the deployment, and bridge the WebSocket to a shell as the default
runtime user. Query-param token transport is kept only as a compatibility
fallback for environments that reject custom WebSocket subprotocols.

## Security Rules

- Do not persist auth tokens, private keys, provider secrets, or resolved vault
  values in durable runtime config.
- Keep non-secret desired state separate from secret values.
- Treat runtime policy as an input to the CLI, not as hardcoded private logic.
- Prefer official runtime configuration and installers before proxying or
  request rewriting.
- Expose official runtime ports only behind runtime-native auth, platform
  ingress auth, or the sidecar bridge module.
- Keep defensive validation at every boundary: manifests, provider references,
  channel descriptors, filesystem paths, and process launch arguments.
- Remove `CLAWDI_AUTH_TOKEN` from agent child process environments unless that
  process is explicitly the Clawdi daemon or runtime reconciler.
- Start runtime browser UIs without public gateway auth only when they are
  reachable solely through the local sidecar bridge module and hosted access
  controls.
- Prefer WebSocket subprotocol auth for Terminal sessions so bearer tokens do
  not normally appear in URLs or proxy access logs.

## Recovery Rules

- Cache only manifests that validate and converge without install/projection
  errors.
- Use ETags for remote refreshes where the datasource supports them.
- Offline boot is allowed only when `recovery.allowOfflineBoot` is true and the
  cached manifest does not require missing secret values.
- `runtime status --json` and `runtime doctor --json` should surface enough
  state to distinguish manifest fetch failures, manifest rejection, degraded
  offline boot, install failures, and disabled runtimes.

## Implementation Notes

The CLI implementation should remain portable and testable:

- runtime commands must support JSON output for automation;
- local fixture manifests may be used for tests;
- generated provider and channel projections should be deterministic;
- diagnostics should report actionable local state without exposing secrets;
- operator-only behavior should not change normal laptop onboarding.

Primary implementation files:

| Area | Files |
| --- | --- |
| Manifest schema | `packages/cli/src/runtime/manifest-contract.ts` |
| Manifest fetch/normalize/validate | `packages/cli/src/runtime/manifest-source.ts` |
| Runtime convergence | `packages/cli/src/runtime/manifest.ts` |
| Runtime paths | `packages/cli/src/runtime/paths.ts` |
| Host policy | `packages/cli/src/runtime/host-policy.ts` |
| Run config | `packages/cli/src/runtime/run-config.ts` |
| Command execution | `packages/cli/src/commands/run.ts` |
| CLI update policy | `packages/cli/src/runtime/cli-update.ts` |
| Runtime bridge | `packages/cli/src/runtime/bridge.ts` |
| Dashboard terminal | `apps/web/src/hosted/agents/hosted-terminal-panel.tsx` |
| Dashboard hosted detail page | `apps/web/src/hosted/agents/hosted-agent-detail.tsx` |
