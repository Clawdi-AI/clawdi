# Hosted Runtime CLI Contract

**Status:** managed npm bootstrap and local runtime contract implemented
**Last updated:** 2026-06-09
**Owner:** CLI runtime layer

## Document Map

- Canonical hosted runtime design: `../hosted-runtime.md`.
- Current CLI contract: this file.
- Current implementation roadmap: `hosted-runtime-roadmap.md`.
- OpenClaw/Hermes patch replacement and MITM boundary:
  `openclaw-hermes-mitm-inventory.md`.
## Runtime Image Assumption

A managed runtime image owns only the Linux envelope, baked environment
defaults, host policy, and an entrypoint that calls:

```bash
clawdi runtime init --non-interactive
```

The image does not bake OpenClaw, Hermes, legacy runtime trees, source patches,
endpoint flags, or private runtime-control RPC behavior. All cloud-init-style
convergence and runtime command wrapping belongs to the standalone `clawdi`
CLI.

## Product Decision

The hosted runtime uses the normal open-source `clawdi` CLI as the
cloud-init-like convergence engine. There is no private `clawdi-init` binary,
no reduced hosted-only CLI, and no runtime-control RPC surface for ordinary agent
CLI actions.

Command namespace:

```bash
clawdi runtime init
clawdi runtime status
clawdi runtime doctor
```

Supporting inspect commands:

```bash
clawdi auth status
clawdi config paths
clawdi capabilities
```

`clawdi runtime init` is an operator/runtime command. Normal local onboarding
continues to use `clawdi setup`.

Hosted `runtime init` may run in a system context so it can write Clawdi-owned
service state. That does not make the whole `clawdi` CLI privileged: normal
agent/user CLI calls run as the ordinary runtime user. OpenClaw/Hermes official
installer processes are also launched as the runtime user when `runtime init`
itself starts as root.

## CLI Package And Broker Packaging

The user-facing command is still `clawdi`, but the hosted release unit is the
standard npm package. The package is prepared with:

```bash
bun run --cwd packages/cli build
bun run --cwd packages/cli build:mitm-broker
npm pack
```

That builds the JS CLI, builds a managed MITM broker bundle at
`packages/cli/clawdi-mitm-broker/`, and produces a tarball/installable package
with the same layout as the public npm release.

Packaging decision:

- `clawdi` remains the single user-facing command.
- The `clawdi` npm package owns manifest convergence, runtime command wrapping,
  policy evaluation, broker bundle selection, diagnostics, and update
  orchestration.
- The MITM broker remains a separate managed child process inside the package.
  TLS MITM
  and proxy protocol handling must not run inside the JS CLI process.
- The current broker bundle is a relocatable `clawdi-mitm-broker/` directory
  inside the package. It contains a Go native
  `bin/clawdi-mitm-broker` executable and a manifest.
- `clawdi run -- <runtime>` first looks for that bundle beside the active CLI
  package entrypoint. It can still use an explicit `CLAWDI_MITM_BROKER_PATH` or
  `CLAWDI_MITM_BROKER_BUNDLE` for local verification and emergency override.
- The native broker implements HTTPS CONNECT, TLS interception, HTTP
  forwarding, WebSocket upgrade tunneling, profile matching, secretRef gates,
  rewrites, denial, and original-host annotations.
- Runtime images should bake only the stable Linux envelope plus a way to invoke
  the managed npm-installed `clawdi`. CLI and broker updates are owned by the
  standalone `clawdi` npm release channel, not an image build.

This gives a one-command UX without running TLS MITM inside the Bun/JS CLI
process. The broker still keeps a process and version boundary so it can be
updated, replaced, or disabled independently.

## Managed CLI Npm Install

Managed runtime CLI install uses the same package channel as public `clawdi`:
the npm package. It is not a backend artifact URL/SHA channel.

- `/usr/local/bin/clawdi`: image-baked, read-only, root-owned launcher shim;
- `/var/lib/clawdi/bin/clawdi`: active managed CLI entrypoint;
- `/var/lib/clawdi/npm`: root-owned npm prefix;
- `/var/lib/clawdi/npm-cache`: root-owned npm cache;
- `/var/lib/clawdi/status/cli-bootstrap.json`: first-install status;
- `/usr/local/share/clawdi/cli-bootstrap.json`: read-only npm package spec for
  first boot when no active package exists.

The shim is intentionally small. It may locate an active npm-managed entrypoint,
run `npm install -g <packageSpec> --prefix /var/lib/clawdi/npm` for first boot,
and `exec` the real CLI. It must not parse runtime manifests, write
OpenClaw/Hermes config, own MITM profiles, resolve tenant policy, or persist
auth.

Rules:

- `CLAWDI_AUTH_TOKEN` is used only to fetch control-plane state and must not be
  persisted in npm state, status files, shell startup files, or manifests.
- Ordinary agent/user invocations execute the active CLI but cannot modify the
  managed npm prefix or Clawdi-managed config.
- Hosted policy may deny ordinary-user `clawdi update`; system init/maintenance
  can still update the managed npm package.
- CLI npm updates are separate from OpenClaw/Hermes native updater behavior.

Manifest shape:

```json
{
  "clawdiCli": {
    "source": "npm:clawdi",
    "packageSpec": "clawdi@latest",
    "managedConfig": true,
    "userEditableConfig": false
  }
}
```

Manifest contract:

- the runtime source returns `{ manifest, secretValues }`, where `manifest` is
  `clawdi.hosted-runtime.manifest.v1`;
- the CLI normalizes runtime source input into `clawdi.runtimeDesiredState.v1`
  before validation and convergence;
- runtime desired state does not include embedded secret values; runtime
  secrets are delivered through the response side channel and written only to
  `/run`;
- `system.workspace` controls the shared workspace root, while a runtime-level
  `paths.workspace` controls that runtime's run config `cwd`.

Current implementation:

- `runtime init` treats hosted manifest `clawdiCli` as non-secret metadata;
- the image-side shim bootstraps the first npm package from immutable metadata
  when `/var/lib/clawdi/bin/clawdi` is missing;
- local runnable image tests use a packed npm tarball to exercise the same npm
  install path without publishing a package.

## Ownership Boundary

The CLI owns:

- hosted/runtime path resolution;
- host policy parsing and enforcement;
- runtime manifest validation;
- boot state machine and local status files;
- official first-install orchestration for selected OpenClaw/Hermes runtimes;
- persisted per-runtime run configs consumed by `clawdi run -- hermes` and
  `clawdi run -- openclaw`;
- runtime source datasource, projection writers, diagnostics, and local
  maintenance commands.

External runtime platform responsibilities:

- container injection of `CLAWDI_AUTH_TOKEN`;
- runtime manifest generation;
- secret resolution service;
- CLI npm install policy;
- image build and Docker launch envelope.

The CLI consumes runtime policy. It must not contain private tenant policy or
platform UI policy.

## Implemented Surface

Implemented commands:

- `clawdi auth status [--json]`;
- `clawdi config paths [--json]`;
- `clawdi capabilities [--json]`;
- `clawdi runtime init --non-interactive --json`;
- `clawdi runtime init --manifest-file <path>`;
- `clawdi runtime status --json`;
- `clawdi runtime doctor --json`.
- `clawdi run -- hermes` and `clawdi run -- openclaw` in hosted mode when a
  managed runtime run config exists.

Implemented behavior:

- hosted/local path resolver;
- host policy parser;
- hosted policy enforcement for denied local mutation commands;
- hosted-mode local user self-update skip;
- cloud-init-style `status.json` and `result.json`;
- fixture manifest simulation;
- authenticated desired-state fetch/cache from the configured runtime source
  contract;
- normalizer from `clawdi.hosted-runtime.manifest.v1` into
  `clawdi.runtimeDesiredState.v1`;
- runtime `secretValues` projection into `/run/clawdi/mitm/secrets.json`
  without writing secrets into the last-good manifest cache. In hosted MITM
  mode this file remains system-owned `0600`; the MITM directory is not
  writable by the ordinary runtime user while CA material remains readable;
- last-good manifest cache and degraded offline restart;
- stale generation rejection;
- managed projection files and boot semaphores;
- manifest-selected official first install for OpenClaw/Hermes.
- managed run config generation under
  `/var/lib/clawdi/config/run/{hermes,openclaw}.json`.
- hosted `clawdi run -- <runtime>` command wrapping from those persisted
  configs without requiring docker startup flags.
- MITM profile bundle schema `clawdi.mitmProfiles.v1`.
- `runtime init` writes enabled non-secret MITM profiles to
  `/var/lib/clawdi/config/mitm/profiles.json`.
- managed run configs reference `mitmProfileBundlePath` when enabled profiles
  exist.
- generated `supervisord` config at
  `/var/lib/clawdi/supervisor/supervisord.conf` for enabled long-running
  runtimes. Supervised programs still execute through
  `clawdi run -- <runtime>`.
- hosted `clawdi run -- <runtime>` now injects broker/proxy/CA env when a
  managed MITM profile bundle is present.
- hosted `clawdi run -- <runtime>` now starts the managed broker bundle,
  rewrites child env to the broker's actual proxy/CA paths, and stops the
  broker when the runtime process exits.
- when MITM profiles are enabled, supervised runtime programs start
  `clawdi run` from the system context. The broker reads the root-only
  `secretRef` file there, and `clawdi run` drops only the OpenClaw/Hermes child
  process to `CLAWDI_RUNTIME_USER` with `gosu`/`runuser`.
- hosted `clawdi run -- <command>` also applies the managed MITM profile bundle
  to generic commands such as `codex` or `node` when no runtime-specific run
  config exists. This keeps Codex official endpoint MITM on the same user-facing
  command without adding a private RPC surface.
- `clawdi-mitm-broker/` is a self-contained native broker bundle. It supports
  profile-driven routing, secretRef header/path/query matching via short-lived
  secret files, HTTP rewrites, denial, original-host annotations, CONNECT/TLS
  interception, WebSocket upgrade tunneling, loopback-only default listening,
  strict upstream URL validation, proxy-scoped header stripping, upstream
  `Set-Cookie` stripping, and per-run CA generation.
- npm package build via `bun run --filter clawdi build` plus
  `build:mitm-broker`, including the packaged broker bundle.
- managed CLI npm bootstrap from immutable image metadata, with active symlink
  switch and bootstrap status under `/var/lib/clawdi/status/cli-bootstrap.json`.
- local broker/runtime tests covering profile validation, proxy/CA env
  projection, official-looking provider routes, HTTP rewrite, and WebSocket
  upgrade handling.

Not yet implemented in this branch:

- platform-level status handling for
  `/var/lib/clawdi/status/cli-bootstrap.json`.

## Official First Install

Runtime selection is manifest-driven:

```json
{
  "schemaVersion": "clawdi.runtimeDesiredState.v1",
  "runtimes": {
    "openclaw": { "enabled": true },
    "hermes": { "enabled": false }
  }
}
```

OpenClaw installer:

```text
https://openclaw.ai/install-cli.sh
```

Hermes installer:

```text
https://hermes-agent.nousresearch.com/install.sh
```

Installers run with `HOME` set to the runtime user's persistent HOME. The CLI
does not pass hosted-only install roots such as Hermes `--dir` or OpenClaw
`--prefix` in the normal path.

If the expected command already exists, install is skipped and inventory records
`present`. Disabled runtimes are not installed and inventory records
`disabled`. Enabled runtimes that cannot be installed make boot status fail.

## Filesystem Contract

Local mode:

- state root: user config/cache/state locations already used by the CLI;
- runtime homes: native defaults such as `~/.hermes` and `~/.openclaw`;
- user can run normal setup/update/teardown commands.

Hosted mode:

- user: `clawdi`;
- HOME: `/home/clawdi`;
- workspace: `/home/clawdi/clawdi`;
- service state: `/var/lib/clawdi`;
- runtime scratch and short-lived secrets: `/run/clawdi` and `/tmp`;
- host policy: `/etc/clawdi/host-policy.json`;
- no legacy target model.

`/var/lib/clawdi` must be exec-capable in hosted runtime deployments because
the active managed CLI entrypoint is `/var/lib/clawdi/bin/clawdi`.

Managed runtime command config:

- path: `/var/lib/clawdi/config/run/{runtime}.json`;
- owner: `clawdi runtime init` in the system convergence context;
- consumer: `clawdi run -- hermes` / `clawdi run -- openclaw`;
- contents: command path, default args, environment, PATH prefix, cwd,
  generation, and instance id;
- sensitive values should be delivered as secret references or short-lived
  runtime files, not plain persisted tokens.

Managed MITM profile bundle:

- path: `/var/lib/clawdi/config/mitm/profiles.json`;
- schema: `clawdi.mitmProfiles.v1`;
- owner: `clawdi runtime init`;
- consumer: hosted `clawdi run -- <runtime>` and `clawdi run -- <command>`
  broker startup;
- contents: enabled profile ids, match rules, rewrite targets, redaction
  policy, and secret references;
- sensitive values must not be inlined.

## `clawdi run` Broker Direction

The current implementation makes `clawdi run -- hermes` and
`clawdi run -- openclaw` consume a persisted run config and, when profiles are
present, start a managed broker child process. In hosted mode, generic
`clawdi run -- <command>` also starts the broker when the managed profile bundle
exists. This is the activation boundary for runtime MITM/broker policy across
Hermes, OpenClaw, Codex, and small diagnostic tools.

Target behavior:

- read the persisted run config;
- read a persisted non-secret MITM profile bundle generated by `runtime init`;
- start or attach to a local broker/proxy process;
- project a CA PEM when TLS interception is enabled;
- strip stale proxy/trust env from the parent process;
- inject `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy`, `http_proxy`, `NO_PROXY`,
  `no_proxy`, `NODE_USE_ENV_PROXY`, `OPENCLAW_PROXY_URL`, and CA trust env into
  the child;
- strip `CLAWDI_AUTH_TOKEN` and all `CLAWDI_MITM_*` control variables before
  `exec` so the child sees standard proxy/CA behavior, not Clawdi internals;
- if running as root with `CLAWDI_RUNTIME_USER`, drop the upstream child to that
  user while keeping the broker in the system context;
- do not globally inject `--use-env-proxy` through `NODE_OPTIONS`; Node-based
  diagnostics/runtimes need a hosted base Node version that supports
  `NODE_USE_ENV_PROXY` for their HTTP client path, or an explicit runtime
  command/config decision;
- inject service/provider credentials only through secret references or
  short-lived runtime files;
- exec the upstream runtime command;
- never require normal startup flags such as Discord endpoint, channel URL,
  provider token, or certificate path.

Focused implementation checks:

```bash
bun test packages/cli/tests/commands/run.test.ts \
  packages/cli/tests/runtime-mitm-broker.test.ts
bun test packages/cli/tests/runtime.test.ts \
  packages/cli/tests/smoke.test.ts \
  packages/cli/tests/runtime-mitm-broker.test.ts \
  packages/cli/tests/commands/run.test.ts
bun run --filter clawdi typecheck
bun run --filter clawdi build
CLAWDI_MITM_BROKER_BUNDLE_OUTDIR=packages/cli/clawdi-mitm-broker \
  bun run --filter clawdi build:mitm-broker
```

The focused tests prove proxy+CA routing, profile validation, secretRef gates,
HTTP rewrite, WebSocket tunneling, and official-looking provider routes without
requiring deployed runtime services. Real runtime image boot, deployed native
channel credentials, and inbound bot canaries belong to an external runtime
platform smoke lane.

Agent Vault is the implementation reference for the mechanics: one local plain
HTTP proxy listener handles both `CONNECT` for HTTPS upstreams and absolute-form
HTTP forwarding; WebSocket upgrade/tunnel traffic is supported explicitly; proxy
auth is stripped before upstream forwarding; request logging redacts tokens.

Clawdi now follows the Agent Vault-style split more closely: `clawdi` remains
the user-facing orchestrator, while a native broker child process owns the
local proxy transport. The profile model stays above the transport
implementation so a future broker can be replaced without changing run config
or runtime UX.

Clawdi-specific boundaries:

- Telegram and Discord route to Clawdi native channel HTTP/WebSocket surfaces
  when native runtime config is missing.
- WhatsApp channel protocol state belongs to the hosted channel service. The
  broker may route a runtime-facing bridge, but it must not own real WhatsApp
  protocol state.
- iMessage channel service paths and managed trust config belong to the hosted
  channel service, not the CLI.
- Hosted-managed Codex uses MITM to simulate the official OpenAI Responses
  path from the child process view. The child still sees
  `https://api.openai.com/v1/responses`; the broker owns the managed-provider
  credential and rewrite boundary.
- Hosted-managed OpenClaw Codex uses OpenClaw's native
  `openai-chatgpt-responses` transport. The child sees
  `https://chatgpt.com/backend-api/codex/responses`; the broker rewrites to the
  managed sub2api `/backend-api/codex/responses` surface and replaces
  authorization from secretRef.
- Ordinary OpenAI-compatible provider APIs use native provider projection or a
  direct provider URL when official Codex/OpenAI behavior does not need to be
  simulated.
- User BYOK provider traffic must not be silently proxied.

External runtime smoke is not part of default CLI CI because it depends on a
runtime image, external channel credentials, and provider gateway credentials.

The current hosted-manifest-generated profile IDs are:

- `codex-openai-responses`;
- `codex-chatgpt-backend-responses`.

Channel profiles are not generated from hosted manifest `channels`. Clawdi
native channels use scoped `agent_token` values and cloud-api server-side
credential mapping.

An egress-deny profile remains a follow-up policy profile, not part of the
current generated default bundle.

Hosted mode should support a read-only rootfs shape where:

- `/home/clawdi` is writable by the ordinary `clawdi` runtime user;
- `/var/lib/clawdi` is writable only by the system init/maintenance context and
  exec-capable for the managed CLI entrypoint;
- `/run/clawdi` is system-writable scratch;
- `/tmp` is normal temporary scratch;
- system assets are read-only.

If `runtime init` starts as root/system, official OpenClaw/Hermes installers
must still execute as `CLAWDI_RUNTIME_USER` so files created under HOME remain
owned by the runtime user.

## Current Non-Goals

- No deployment rollout policy in this repo; the CLI fetch path is implemented
  and deployment gating belongs to the runtime platform.
- No OpenClaw/Hermes native updater or rollback behavior in the current slice.
- No default-CI native channel E2E in the current slice.
- No endpoint/token flags on normal runtime startup.
- No OpenClaw/Hermes source patching.

## Next Implementation Gates

1. Publish the production `clawdi` npm package with the broker bundle and keep
   runtime image bootstrap on the approved package spec or dist-tag.
2. Tighten generated native channel MITM routes once runtime source manifests expose
   per-channel secret refs.
3. Generate full OpenClaw/Hermes managed projection files from the manifest.
4. Keep the self-contained broker bundle part of the managed CLI npm package and
   report CLI/broker versions in runtime inventory.
5. Add an external opt-in smoke lane for runtime images and native channel
   credentials outside the default CLI PR checks.
6. Promote native channel smoke into a repeatable external test lane.
7. Expand broker tests for WebSocket, provider projection, and egress-deny
   policy.

## Verification

Focused checks for this branch:

```bash
bun test packages/cli/tests/smoke.test.ts packages/cli/tests/runtime.test.ts
bun run --filter clawdi typecheck
bun run --filter clawdi build
bunx biome check packages/cli/src/runtime docs/plans/hosted-runtime-cli.md docs/plans/openclaw-hermes-mitm-inventory.md docs/plans/hosted-runtime-roadmap.md
```
