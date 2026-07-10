# Full Rust CLI Rewrite Execution Plan

| Field | Value |
| --- | --- |
| Status | Accepted execution plan |
| Last updated | 2026-07-10 |
| Owner | CLI maintainers |
| Decision | [`ADR-0002`](../adr/0002-full-rust-cli-is-the-terminal-direction.md) |

## Scope And Boundaries

The terminal state is a Rust CLI suite delivered behind one stable launcher:

- `clawdi`: interactive commands and local user workflows;
- `clawdi-syncd`: the singleton sync daemon and local control RPC owner;
- `clawdi-runtime-agent`: the k3s Pod desired-state reconciler currently
  exposed through `runtime init`, `watch`, `status`, `doctor`, and `verify`;
- `clawdi-runtime-bridge`: the authenticated runtime UI bridge module currently
  hosted by `runtime sidecar`;
- a stable launcher/updater that selects, verifies, activates, rolls back, and
  execs the active version without changing service unit entrypoints.

Retained external boundaries are the Python FastAPI backend, TanStack web app,
Baileys Node sidecar, and mitmproxy Python addon. Rewriting those components,
changing hosted topology, and changing provider/channel product contracts are
non-goals.

The managed-runtime contract and projection rules stay authoritative in
[`../managed-runtime.md`](../managed-runtime.md) and
[`runtime-projection-boundary.md`](runtime-projection-boundary.md). This plan
links those documents instead of restating their behavior.

## Repository And Crate Layout

Add one root Cargo workspace without moving the existing JavaScript monorepo:

```text
Cargo.toml
crates/
  clawdi/                  interactive CLI and control clients
  clawdi-launcher/         stable selection, activation, rollback, legacy argv
  clawdi-syncd/            live sync, durable queue, watchers, local RPC
  clawdi-runtime-agent/    hosted desired-state reconciliation and supervision
  clawdi-runtime-bridge/   authenticated HTTP/WebSocket bridge
  clawdi-api/              generated OpenAPI client and error mapping
  clawdi-contracts/        versioned JSON, queue, status, and RPC types
  clawdi-platform/         atomic files, permissions, process/service adapters
  clawdi-adapters/         Claude Code, Codex, Hermes, and OpenClaw adapters
  clawdi-testkit/          shared fixtures, fake servers, and differential tools
```

Binary crates depend on the narrow library crates; they do not depend on one
another or embed the TypeScript runtime through FFI. Baseline implementation
choices are `clap` for command parsing, Tokio for async process/network work,
`reqwest` with rustls for API calls, Serde for contracts, `tracing` for
structured redacted logs, `axum`/`hyper` for local HTTP and bridge handling,
and `notify` for filesystem watching. Pin the workspace MSRV, deny unsafe code
by default, and gate dependencies with license, advisory, and duplicate checks.
Secret-bearing values use explicit wrapper types, never implement `Debug` with
plaintext, and are zeroized where ownership permits.

## Contract Strategy

Generate the Rust API client from the backend OpenAPI document in the same
workflow that generates the TypeScript client. Check in deterministic fixtures
for request paths, query encoding, headers, success bodies, structured errors,
pagination, SSE events, and WebSocket frames. Generated code must never be
hand-edited.

Version every durable or cross-process contract before migrating its owner:

- JSON config, auth, inventory, projection, status, and run-state files;
- daemon queue records, retry metadata, deduplication keys, and ordering rules;
- launcher active-version metadata and rollback state;
- sync daemon control RPC requests, responses, and error envelopes;
- runtime-agent/bridge readiness and status messages.

Readers accept the current version plus explicitly supported predecessors.
Writers remain on the oldest shared version during mixed deployments, then
advance only after rollback no longer requires the old reader. Fixtures include
unknown fields, corrupt/truncated files, interrupted atomic writes, and
permission failures.

## Command Ownership Matrix

| Surface | Initial owner | First Rust owner | Final binary |
| --- | --- | --- | --- |
| auth, config, status, doctor, update | TypeScript CLI | interactive phase | `clawdi` |
| project, agent projects, inbox, channel, AI provider, vault, memory, skill, read, inject, run, MCP | TypeScript CLI | interactive/adapters phases | `clawdi` |
| setup, teardown, push, pull, session, agent credentials | TypeScript CLI and local adapters | adapters phase | `clawdi` |
| daemon run/install/status/logs/doctor/restart/uninstall/ping/rotate-token | TypeScript daemon | sync phase | `clawdi-syncd` plus `clawdi` control client |
| runtime init/watch/status/doctor/verify | TypeScript runtime command | runtime phase | `clawdi-runtime-agent` |
| runtime sidecar bridge module | TypeScript sidecar | runtime phase | `clawdi-runtime-bridge` |
| runtime sidecar egress orchestration | TypeScript sidecar | runtime phase, excluding retained addon | `clawdi-runtime-agent` supervising mitmproxy addon |
| version selection, update activation, rollback | TypeScript updater/runtime shim | contract-freeze phase | stable launcher/updater |

Published aliases are contracts too. Differential command fixtures must cover
the top-level `bot` and legacy `serve` aliases, plus documented subcommand
aliases, until an explicit compatibility decision removes them. An alias does
not create a separate runtime owner.

Removed commands do not become Rust work merely because they existed in an old
release. Before deleting any other ambiguous public command, collect aggregated,
privacy-safe evidence limited to command identifier, CLI version, platform,
success/failure class, and coarse invocation count. Never collect arguments,
paths, environment names or values, project/agent identifiers, URLs, or command
output. Publish the retention window and deletion threshold before collection;
absence of opt-in evidence alone is not proof of zero use.

## Phase Order

### 1. Contract Freeze And Fixtures

- Inventory every command, file, queue, RPC, HTTP, WebSocket, and SSE boundary.
- Add golden fixtures consumable by Bun and Cargo tests and generate the Rust
  OpenAPI client.
- Introduce the stable launcher with an active binary/symlink, signed or
  checksummed artifacts, atomic activation, last-known-good metadata, and a
  no-network rollback command.
- Define rollout flags at global, binary, command-family, and daemon-unit scope;
  default all Rust ownership flags off.

Exit gate: fixtures cover released contracts, both clients parse them, launcher
activation survives interruption, and rollback restores the previous binary.

### 2. Runtime Agent And Bridge

- Move desired-state fetch/cache/reconcile/status ownership to
  `clawdi-runtime-agent` without changing the contracts linked above.
- Move authenticated bridge lifecycle to `clawdi-runtime-bridge`; keep the
  Baileys sidecar and mitmproxy addon as supervised external processes.
- Verify readiness, signal handling, last-good recovery, redaction, and file
  modes in throwaway local environments only.

Exit gate: differential fixtures and local simulations produce equivalent
projections/status; HTTP/WebSocket bridge conformance passes; rollback can
restart the TypeScript runtime owner against unchanged state.

### 3. Interactive API Commands

- Port read-mostly commands first, then authenticated mutations, then doctor,
  run/inject, MCP, and update control. Adapter-dependent command families stay
  on TypeScript until phase 4.
- Compare normalized stdout/stderr, JSON, exit codes, request traces, config
  mutations, and redaction. Human wording may improve only with explicit golden
  updates; JSON remains additive and versioned.
- Track ownership at subcommand granularity where a command family cannot move
  atomically; a Rust top-level parser that still dispatches production work to
  TypeScript does not count as completed ownership.

Exit gate: supported platforms pass command parity, authentication and API
error conformance, and no migrated command requires the TypeScript runtime.

### 4. Sync Daemon And Adapters

- Port queue storage, retries, watchers, SSE reconnect, local RPC, installers,
  setup/teardown, push/pull, session inspection, credential materialization,
  and each agent adapter behind independent rollout flags.
- Preserve compatibility with installed legacy units invoking
  `serve --agent <type> --environment-id <id>`. The stable launcher must accept
  that shape, migrate persisted identity into singleton state, install/activate
  the new unit, and remove the old unit only after the new daemon is healthy.
- Keep queue writers on the shared version until TypeScript rollback is retired.

Exit gate: mixed TS/Rust queue tests prove ordering, deduplication, retry and
crash recovery; SSE reconnect and local RPC suites pass; legacy units migrate
idempotently and rollback does not lose queued work.

### 5. Cutover And Removal

- Enable Rust by default one command family and service cohort at a time.
- Hold each cohort through the documented observation window, then remove its
  fallback only after completion metrics remain green.
- Remove TypeScript production entrypoints, runtime dependencies, and duplicate
  fixtures only when every completion gate is met; retain compatibility readers
  for the published support window.

## Packaging And Distribution

Keep the existing `clawdi` npm package name, release channels, and standalone
release assets throughout migration. During mixed ownership, the current thin
npm entrypoint remains the dispatcher and selects TypeScript or a verified Rust
binary by rollout flag. Hosted installs must continue to work with npm
`--ignore-scripts`; they may not require a postinstall download.

Publish Rust artifacts for Linux x64/arm64 and macOS x64/arm64 with checksums
and provenance in the existing CLI release workflow. The npm payload may use
platform-specific optional packages or bundled platform artifacts, but the
selected executable and digest must be known before activation. Windows x64 is
added for interactive commands before Windows daemon support is advertised.

At terminal cutover, Node/Bun is no longer required to execute `clawdi`; the
npm package may remain a distribution wrapper, while standalone archives and
the hosted active-symlink path execute Rust directly. Release channels such as
`latest` and `beta`, version output, update policy, and rollback metadata remain
compatible across both delivery forms.

## Verification Matrix

Every phase runs the same fixture corpus against TypeScript and Rust and
compares normalized observable behavior. Required suites cover:

- owner-only files/directories, umask variance, atomic rename, symlink refusal,
  traversal, partial writes, and Windows ACL-equivalent expectations;
- queue ordering, deduplication, leases, retry/backoff, poison records, crash
  recovery, and mixed-version readers/writers;
- HTTP methods, paths, query encoding, headers, timeouts, TLS failures, JSON
  errors, pagination and rate limits;
- WebSocket handshake/auth, subprotocols, fragmentation, close codes, ping/pong,
  reconnect and backpressure;
- SSE parsing across chunk boundaries, `id`/`retry`, comments, reconnect with
  last-event-id, duplicates and malformed events;
- Linux x64/arm64 and macOS x64/arm64 release artifacts, plus Windows x64 for
  interactive commands before Windows is declared supported for daemons;
- clean install, upgrade, downgrade, offline rollback, service restart, shell
  completion, and artifact checksum/signature verification.

CI must run Bun tests/typecheck for remaining TypeScript owners, Cargo fmt,
clippy, unit/integration tests, contract fixture tests, and platform packaging.
Release candidates must not require production or tenant operations for proof.

## Rollout And Rollback

The stable launcher is the permanent service-unit and user-facing entrypoint.
It resolves an atomic `active` binary/symlink and records `previous`, version,
artifact digest, activation time, and health result. Rollout flags can select
TypeScript or Rust globally, by command family, by runtime component, and by
explicit test cohort. Unknown/missing flags select the last known good owner.

Activation writes a staged target, verifies it, atomically switches `active`,
then performs a bounded health check. Failure restores `previous` without a
download. State writers stay backward compatible until the rollback window
closes. Service migrations never delete an old unit or binary before the new
process is healthy and its rollback metadata is durable.

## Completion Gates And Success Criteria

The rewrite is complete only when all of the following are measurable and true:

- 100% of supported public commands, subcommands, published aliases, and
  long-running owners map to Rust in the ownership matrix; no production
  command loads the TypeScript CLI.
- Golden/differential suites show no unexplained request, state, queue, JSON,
  exit-code, redaction, WebSocket, or SSE differences.
- Zero secret names or values appear in deprecation, diagnostic, launcher, or
  migration logs across the redaction corpus.
- Required file-mode and symlink tests pass on every supported platform.
- Upgrade and offline rollback succeed in all release-matrix jobs, including
  legacy `serve --agent --environment-id` migration.
- Crash/restart tests lose zero acknowledged queue records and introduce zero
  duplicate externally visible mutations beyond documented idempotency rules.
- Rust-default cohorts meet the agreed success/error and rollback thresholds
  for the full observation window before TypeScript fallback removal.
- TypeScript production code and dependencies are removed only after the final
  rollback support window closes; backend, web, Baileys, and mitmproxy
  boundaries remain operational and independently releasable.
