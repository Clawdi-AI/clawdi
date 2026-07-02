# Managed Runtime CLI Notes

| Field | Value |
| --- | --- |
| Status | Public implementation notes |
| Last updated | 2026-06-30 |
| Owner | CLI runtime layer |

This note documents the open-source CLI surface for managed runtime
environments. It is not a private service architecture document and must not
contain private deployment details, live service hosts, or internal
control-plane behavior.

Related public contract: [`../managed-runtime.md`](../managed-runtime.md).

## Goals

- Keep `clawdi` as the single user-facing command.
- Let runtime environments converge from a validated desired-state document.
- Keep normal laptop onboarding separate from operator/runtime commands.
- Project provider and channel config deterministically for supported agent
  runtimes.
- Avoid storing secrets in durable manifests, caches, shell startup files, or
  generated config.
- Keep the runtime image stable by avoiding image-level per-agent wrappers.
- Route managed runtime commands through generated run config and `clawdi run`.

## Command Surface

Runtime commands are intentionally small:

```bash
clawdi runtime init --non-interactive [--json]
clawdi runtime init --manifest-file <path> [--json]
clawdi runtime watch [--self-heal-ms <ms>]
clawdi runtime bridge
# Compatibility only; backend /mcp/clawdi is the default hosted MCP target.
clawdi mcp http --host 0.0.0.0 --port 8788 --path /mcp --auth-token-file <file>
clawdi runtime status [--json]
clawdi runtime doctor [--json]
clawdi run -- <command>
```

Supporting inspection commands:

```bash
clawdi auth status [--json]
clawdi config paths [--json]
clawdi capabilities [--json]
```

`clawdi setup` remains the local interactive onboarding path. Runtime commands
are for environments where configuration is supplied by policy or by an
operator-provided manifest.

## Runtime Init

`runtime init` performs one convergence pass:

1. Load runtime policy and desired state.
2. Validate schema version, enabled runtimes, providers, channels, paths, and
   process launch settings.
3. Install or verify selected runtimes through their normal installers.
4. Write non-secret run configuration.
5. Project short-lived secret files only when needed for the current session.
6. Write command shims for active runtime names.
7. Render supervisor config.
8. Record status and diagnostics.

The command should be idempotent. Re-running it with the same desired state
should not produce unnecessary config churn.

Key generated outputs:

- `config/run/<runtime>.json` for `clawdi run`;
- `config/projections/<runtime>.json` for runtime-specific config projection;
- `config/runtime-command-shims.json` plus symlinks under the service-state bin
  directory;
- `supervisor/supervisord.conf` with each runtime launched as
  `clawdi run -- <runtime>`;
- `cache/manifest.last-good.json` and ETag files for recovery and refresh;
- `install-inventory/<runtime>.json` for diagnostics.

`runtime watch` is the remote refresh loop. It should use cache validators,
apply only validated desired state, record rejected generations, and keep a
last-good manifest only after successful convergence.

## Run Boundary

`clawdi run -- <command>` is the activation boundary for managed configuration.
It reads local run configuration, prepares the child process environment, and
then executes the requested command.

Rules:

- preserve the target runtime's normal CLI behavior;
- inject only the environment variables required by the generated run config;
- keep provider and channel projection deterministic;
- avoid source patching of target runtimes;
- keep request rewriting behind explicit runtime profiles.
- delete `CLAWDI_AUTH_TOKEN` before launching agent child processes.

In hosted mode, runtime command shims make managed runtimes feel native. The
host PATH points at the shim directory first. A shim named `openclaw`, `hermes`,
or another manifest runtime removes the shim directory from PATH, then calls:

```bash
clawdi run -- "$command_name" "$@"
```

This is the only per-runtime command wrapper. The image should not grow a new
wrapper each time a runtime is added. Disabled run configs must fail closed:
`clawdi run` reports the runtime as disabled and never falls back to a native
binary later on PATH.

For ordinary shell commands that are not managed runtime names, the hosted
terminal remains a real shell. The command shim model only intercepts command
names that `runtime init` generated.

## Runtime Support Model

Built-in support is explicit. The CLI currently knows official installer and
default run settings for supported runtimes such as OpenClaw and Hermes. A
future or externally supplied runtime can still be represented in the manifest
when it includes an explicit `run.command`.

Rules:

- supported runtimes with installer metadata must use official installer URLs;
- unknown runtime names with install metadata are rejected unless the CLI has
  been upgraded to support them;
- unknown runtime names without `run.command` are rejected;
- unknown runtime names with `run.command` can be launched and shimmed without
  image changes.

## Provider Projection

The Clawdi provider contract supports these API modes:

- `openai_chat`;
- `openai_responses`;
- `anthropic_messages`;
- `google_generate_content`.

Runtime projections may translate those modes into target-native config names.
That translation belongs at the projection layer. New provider input should not
use runtime-specific transport names as Clawdi API modes.

For new provider references:

- managed and OAuth-backed OpenAI providers use normal OpenAI model ids;
- API-key providers keep provider-native model names;
- legacy runtime-prefixed model references are rejected at Clawdi provider
  boundaries.

## Channel Projection

Channel projection follows the same contract-driven pattern:

- validate channel descriptors before writing local config;
- keep protocol credentials out of durable config;
- use deterministic file names and stable ordering;
- make diagnostics useful without printing secret values.

The public CLI contract describes local projection and validation only. Service
specific channel management remains outside this repository.

## Control UI And Terminal Notes

`clawdi runtime bridge` is the optional local authenticated bridge for
manifest-declared runtime surfaces. In the optimized official-container model,
Control UI should normally be exposed by the deployment layer as an
authenticated route to the upstream runtime UI. Bridge surfaces remain a
compatibility path for same-origin, CSP, or header mediation.

Bridge surfaces declare listen/upstream targets, protocol handling, auth
behavior, and header rewrite rules explicitly. The bridge is not an arbitrary
port forwarder. Static upstream headers are for non-secret policy values;
sensitive upstream auth should use environment-backed header injection. Terminal
is not a bridge surface.

The hosted Terminal is a dashboard/API contract, not a CLI command. The frontend
requests a short-lived terminal WebSocket URL with the selected `agent_id`,
moves fragment tokens into a `clawdi-terminal.<token>` WebSocket subprotocol,
and uses `tty` framing. Terminal is deployment-scoped and should exec into the
selected runtime container when the runtime is external;
deployment-side shell brokers resolve that container/user/cwd from the target
id's `execution.terminal`.

## Testing Expectations

Runtime changes should include focused tests for:

- manifest validation;
- provider projection for each supported API mode;
- channel projection and secret redaction;
- `runtime init` idempotence;
- `runtime status` and `runtime doctor` JSON output;
- `clawdi run -- <runtime>` environment construction.
- command shim routing, PATH cleanup, stale-shim cleanup, and disabled-runtime
  behavior;
- supervisor config rendering for watch, runtime bridge, daemon, and runtimes;
- terminal URL token transport and light/dark xterm theme behavior when web UI
  code changes.

Generated API clients should be regenerated whenever backend contracts change.
