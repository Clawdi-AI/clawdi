# Managed Runtime Roadmap

| Field | Value |
| --- | --- |
| Status | Public roadmap |
| Last updated | 2026-07-02 |
| Owner | CLI runtime layer |

This roadmap tracks the open-source CLI work needed for managed runtime
environments. Service rollout plans, deployment-specific topology, live service
hosts, and private control-plane behavior are intentionally out of scope for
this repository.

## Current Capabilities

- Runtime policy and desired-state validation.
- `clawdi runtime init/watch/sidecar/status/doctor` command surface.
- Local fixture manifests for tests and diagnostics.
- Deterministic provider and channel projection.
- Non-secret desired-state cache and secret redaction.
- Explicit local/runtime debug launch through `clawdi run -- <command>`.
- Direct systemd launch for managed daemon runtime processes using
  runtime-owned service names.
- Clawdi support program boundaries for manifest watch, live sync, optional
  egress, status, and diagnostics.
- Stable-image contract: runtime behavior is driven by manifest + CLI, not
  image-level per-agent wrappers.
- The detailed ownership boundary is recorded in
  [ADR-0002](../adr/0002-runtime-image-is-a-stable-capability-envelope.md):
  the image supplies stable host capabilities and the CLI owns runtime-local
  egress paths, permissions, and numeric privilege dropping.
- Systemd service rendering that starts official runtime binaries directly with
  manifest-derived args, cwd, and env when upstream service installers do not
  cover the complete hosted contract.
- Hosted Terminal dashboard contract with xterm, tty-style framing, and
  WebSocket subprotocol token transport.
- Sidecar profile validation and local sidecar lifecycle tests.

## Active Work

1. Keep the runtime desired-state schema small and explicit.
2. Keep the stable-image contract intact: new runtime behavior should come from
   CLI support or manifest `run.command`, not image wrapper churn.
3. Keep provider modes provider-oriented:
   `openai_chat`, `openai_responses`, `anthropic_messages`, and
   `google_generate_content`.
4. Keep target-runtime transport names inside projection code only.
5. Improve diagnostics without printing secrets.
6. Expand focused tests for provider, channel, run-environment, direct systemd
   unit rendering, runtime-owned services, Control UI, and Terminal
   projection.

## Reference Research

Official Hermes/OpenClaw Docker images remain useful references for process
shape, ports, health checks, and safe network defaults. They are not the primary
hosted update model while official in-place UI updates remain a requirement,
because Docker installs update by image rollout.

## Non-Goals

- No private control-plane RPC surface in the open-source CLI.
- No production deployment documentation in this repository.
- No source patching of upstream agent runtimes.
- No durable storage of resolved secrets.
- No runtime-specific transport names as Clawdi provider API modes.
- No image-level per-agent command wrappers.
