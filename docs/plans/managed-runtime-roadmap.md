# Managed Runtime Roadmap

| Field | Value |
| --- | --- |
| Status | Public roadmap |
| Last updated | 2026-06-29 |
| Owner | CLI runtime layer |

This roadmap tracks the open-source CLI work needed for managed runtime
environments. Service rollout plans, deployment-specific topology, live service
hosts, and private control-plane behavior are intentionally out of scope for
this repository.

## Current Capabilities

- Runtime policy and desired-state validation.
- `clawdi runtime init/status/doctor` command surface.
- Local fixture manifests for tests and diagnostics.
- Deterministic provider and channel projection.
- Non-secret desired-state cache and secret redaction.
- Runtime launch through `clawdi run -- <command>`.
- Broker profile validation and local broker lifecycle tests.

## Active Work

1. Keep the runtime desired-state schema small and explicit.
2. Keep provider modes provider-oriented:
   `openai_chat`, `openai_responses`, `anthropic_messages`, and
   `google_generate_content`.
3. Keep target-runtime transport names inside projection code only.
4. Improve diagnostics without printing secrets.
5. Expand focused tests for provider, channel, and run-environment projection.

## Non-Goals

- No private control-plane RPC surface in the open-source CLI.
- No production deployment documentation in this repository.
- No source patching of upstream agent runtimes.
- No durable storage of resolved secrets.
- No runtime-specific transport names as Clawdi provider API modes.
