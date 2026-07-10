# ADR-0002: Full Rust CLI Is the Terminal Direction

**Status:** Accepted
**Date:** 2026-07-10
**Deciders:** Clawdi maintainers

## Context

The TypeScript CLI owns interactive commands, local adapters, the live-sync
daemon, hosted runtime reconciliation, runtime bridge support, and its own
launcher/update behavior. That breadth makes startup, distribution, process
supervision, filesystem hardening, and cross-platform compatibility harder to
reason about as separate concerns.

A partial native rewrite without an explicit destination would leave two
permanent implementations and unclear ownership. A big-bang rewrite would put
released command, state, queue, daemon, and runtime contracts at unnecessary
risk.

## Decision

A full Rust implementation of the CLI and its long-running native processes is
the accepted terminal direction. Migration is incremental and contract-first,
not a big-bang replacement.

Each phase must freeze and test the boundary it moves, run TypeScript and Rust
implementations differentially where practical, and retain a reversible
launcher selection until the Rust owner satisfies its completion gates. The
TypeScript implementation remains authoritative for commands not yet migrated.

The target binaries and phase gates are defined in
[`../plans/full-rust-cli-rewrite.md`](../plans/full-rust-cli-rewrite.md).

## Invariants

- Released HTTP, WebSocket, SSE, JSON, filesystem, queue, and local RPC
  contracts change only through explicit versioning or additive compatibility.
- The Python backend and web application remain outside the CLI rewrite.
- The Baileys Node sidecar and mitmproxy Python addon remain external process
  boundaries.
- Hosted runtime desired-state and channel projection behavior remain intact
  during migration.
- Rollout is reversible through the stable launcher and active binary target.
- Ambiguous public commands are removed only after privacy-safe usage evidence
  and a documented compatibility decision.

## Consequences

- New CLI architecture should favor contracts reusable by Rust rather than
  TypeScript-only abstractions.
- Native runtime-agent and bridge work can land before interactive command
  parity, provided the launcher keeps ownership explicit.
- Both implementations and differential fixtures will coexist temporarily,
  increasing short-term test and release work.
- Completion is measured by removal of TypeScript production ownership, not by
  the first Rust binary shipping.

## Migration Direction

Follow the phased plan in
[`docs/plans/full-rust-cli-rewrite.md`](../plans/full-rust-cli-rewrite.md).
Architecture details for hosted desired state and projection remain in
[`docs/managed-runtime.md`](../managed-runtime.md) and
[`docs/plans/runtime-projection-boundary.md`](../plans/runtime-projection-boundary.md);
this ADR does not duplicate them.
