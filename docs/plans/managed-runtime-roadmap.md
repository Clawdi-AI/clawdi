# Managed Runtime Roadmap

| Field | Value |
| --- | --- |
| Status | Public roadmap |
| Last updated | 2026-06-30 |
| Owner | CLI runtime layer |

This roadmap tracks the open-source CLI work needed for managed runtime
environments. Service rollout plans, deployment-specific topology, live service
hosts, and private control-plane behavior are intentionally out of scope for
this repository.

## Current Capabilities

- Runtime policy and desired-state validation.
- `clawdi runtime init/watch/bridge/status/doctor` command surface.
- Local fixture manifests for tests and diagnostics.
- Deterministic provider and channel projection.
- Non-secret desired-state cache and secret redaction.
- Runtime launch through `clawdi run -- <command>`.
- Generated command shims for managed runtime names.
- Stable-image contract: runtime behavior is driven by manifest + CLI, not
  image-level per-agent wrappers.
- Supervisor rendering that launches runtimes through `clawdi run -- <runtime>`.
- Runtime bridge for Control UI surfaces.
- Hosted Terminal dashboard contract with xterm, tty-style framing, and
  WebSocket subprotocol token transport.
- Broker profile validation and local broker lifecycle tests.

## Active Work

1. Keep the runtime desired-state schema small and explicit.
2. Keep the stable-image contract intact: new runtime behavior should come from
   CLI support or manifest `run.command`, not image wrapper churn.
3. Keep provider modes provider-oriented:
   `openai_chat`, `openai_responses`, `anthropic_messages`, and
   `google_generate_content`.
4. Keep target-runtime transport names inside projection code only.
5. Improve diagnostics without printing secrets.
6. Expand focused tests for provider, channel, run-environment, command-shim,
   Control UI, and Terminal projection.

## Non-Goals

- No private control-plane RPC surface in the open-source CLI.
- No production deployment documentation in this repository.
- No source patching of upstream agent runtimes.
- No durable storage of resolved secrets.
- No runtime-specific transport names as Clawdi provider API modes.
- No image-level per-agent command wrappers.
