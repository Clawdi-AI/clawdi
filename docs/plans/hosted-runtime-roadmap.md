# Hosted Runtime Roadmap

**Status:** current CLI roadmap after managed npm bootstrap and local runtime contract tests
**Last updated:** 2026-06-09

## Canonical Inputs

- Current CLI contract: `hosted-runtime-cli.md`.
- Canonical hosted runtime design: `../hosted-runtime.md`.
- OpenClaw/Hermes patch replacement and MITM boundary:
  `openclaw-hermes-mitm-inventory.md`.

## Current Slice

The active slice is hosted runtime command wrapping on top of selected
official first install:

- `clawdi runtime init` validates `clawdi.runtimeDesiredState.v1` after
  normalizing the runtime source `{ manifest, secretValues }` response;
- secret material is not part of the current desired-state schema; runtime
  source `secretValues` are projected only into ephemeral runtime files;
- hosted `system.workspace` and runtime-level `paths.workspace` are honored when
  writing managed config, supervisor config, and run configs;
- runtime selection is driven by `runtimes.openclaw.enabled` and
  `runtimes.hermes.enabled`;
- selected OpenClaw/Hermes runtimes use official installer metadata;
- installers run with the runtime user's persistent HOME;
- when `runtime init` runs in a system context, installers drop to
  `CLAWDI_RUNTIME_USER` before writing HOME-local app files;
- disabled runtimes are skipped;
- installed/present/disabled/failed states are recorded in local inventory;
- boot status fails if an enabled runtime cannot install.
- `runtime init` writes managed run configs under
  `/var/lib/clawdi/config/run/{runtime}.json`;
- `clawdi run -- hermes` and `clawdi run -- openclaw` consume those configs in
  hosted mode without docker startup flags.
- hosted `clawdi run -- <command>` also applies the managed MITM bundle to
  generic commands such as Codex when no runtime-specific config exists.
- `runtime init` writes `/var/lib/clawdi/supervisor/supervisord.conf`; the
  hosted image uses standard `supervisord` to manage enabled long-running
  runtimes through `clawdi run -- <runtime>`.

## Phase Status

| Phase | Status | Notes |
| --- | --- | --- |
| P0 naming and docs | Done | Use `clawdi runtime ...`; no private `clawdi-init`. |
| P1 inspect commands and path resolver | Done | `auth status`, `config paths`, `capabilities`, hosted/local paths. |
| P2 runtime namespace skeleton | Done | `runtime init/status/doctor` and status/result files. |
| P3 fixture manifest simulation | Done | Local manifest file override, cache, stale generation rejection. |
| P4 selected official first install | Done | OpenClaw/Hermes installed only when enabled. |
| P5 authenticated datasource | Done locally | `runtime init` reads a configured runtime source contract, fetches desired state with `CLAWDI_AUTH_TOKEN`, normalizes `clawdi.hosted-runtime.manifest.v1`, caches the non-secret manifest, and projects `secretValues` into `/run/clawdi/mitm/secrets.json`. |
| P6 managed projections | Partial locally | `runtime init` generates runtime run configs, supervisor config, MITM profiles, and `/run/clawdi/mitm/secrets.json` from the hosted manifest. Native OpenClaw/Hermes config fragment writers and on-demand OpenClaw plugin install remain follow-up. |
| P6.5 runtime process management | Done locally | `runtime init` generates `/var/lib/clawdi/supervisor/supervisord.conf`; the image default command runs `supervisord` after convergence. No private `clawdi runtime supervise` daemon. |
| P7 CLI npm bootstrap | Done locally | The standalone `clawdi` npm package includes the self-contained `clawdi-mitm-broker/` bundle. Runtime image bootstrap can use npm to install the package into `/var/lib/clawdi/npm` and switch `/var/lib/clawdi/bin/clawdi` to that package entrypoint. `runtime init` does not consume backend artifact URLs. |
| P8 native channel profiles | Done locally | Profile generation and broker tests cover Telegram, Discord, WhatsApp, BlueBubbles/iMessage, and OpenAI Responses-compatible routes with fake/local upstreams. Real channel credentials belong to an external smoke lane, not the default CLI PR. |
| P9 `clawdi run` broker | Self-contained native broker bundle implemented | Persisted run config exists; runtime init writes `clawdi.mitmProfiles.v1` bundles and run configs reference them. Hosted `clawdi run` starts the managed broker bundle for runtime commands and generic commands, rewrites child proxy/CA env to the actual broker values, hides the secret-file path from the child, and stops the broker with the child process. The bundle contains a Go native `clawdi-mitm-broker` binary; the broker owns CONNECT/TLS/WebSocket mechanics, header/path/query secretRef gates, rewrites, denial, and loopback-only default listening. |
| P10 native updater and rollback | Deferred | Keep authority with OpenClaw/Hermes native behavior. |

## Next Gates

1. Publish the standalone `clawdi` npm package with the broker bundle.
2. Keep runtime image bootstrap on `clawdi@latest` or an approved npm dist-tag
   outside this CLI repo.
3. Add native OpenClaw/Hermes projection writers and on-demand OpenClaw channel
   plugin installation for enabled Clawdi native Channels.
4. Report CLI/broker versions in runtime inventory.
5. Define an external opt-in smoke lane for runtime images and secret-gated
   native channel credentials.
6. Add native channel inbound E2E outside default CLI PR checks when the test
   control plane exposes safe admin ingress fixtures.

## Explicit Non-Goals For Current PR

- No channel credential activation transaction in the CLI; the runtime source
  and hosted service remain the authority for channel credentials.
- No native OpenClaw/Hermes update or rollback.
- No egress-deny network policy enforcement beyond broker profile gates.
- No default-CI native channel E2E implementation in this CLI PR.
- No rollout policy for the managed npm bootstrap in this repo.
- No private RPC surface for agent CLI actions.
- No OpenClaw/Hermes source patching.
