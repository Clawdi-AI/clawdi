# Managed Runtime CLI Notes

| Field | Value |
| --- | --- |
| Status | Public implementation notes |
| Last updated | 2026-06-29 |
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

## Command Surface

Runtime commands are intentionally small:

```bash
clawdi runtime init --non-interactive [--json]
clawdi runtime init --manifest-file <path> [--json]
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
6. Record status and diagnostics.

The command should be idempotent. Re-running it with the same desired state
should not produce unnecessary config churn.

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

## Testing Expectations

Runtime changes should include focused tests for:

- manifest validation;
- provider projection for each supported API mode;
- channel projection and secret redaction;
- `runtime init` idempotence;
- `runtime status` and `runtime doctor` JSON output;
- `clawdi run -- <runtime>` environment construction.

Generated API clients should be regenerated whenever backend contracts change.
