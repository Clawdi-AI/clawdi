# ADR-0003: Runtime Bundle Media Type Is the Render Contract

**Status:** Accepted
**Date:** 2026-07-13
**Deciders:** Clawdi maintainers

## Context

Hosted runtime convergence previously combined a manifest response with a
separate channels response and separate cache validators. That allowed the
desired inputs and the applied identity to come from different database reads
or different convergence attempts. A persisted mutation counter or global
renderer setting would add invalidation paths that can be missed.

## Decision

`application/vnd.clawdi.runtime-bundle.v2+json` is the immutable renderer
contract for Agent v2. A client requesting that exact representation receives
one strict `clawdi.hosted-runtime.bundle.v2` response containing the hosted
manifest, sanitized Telegram and Discord channel bindings, merged secret
values, and a deterministic `sourceRevision`.

The v2 renderer and canonical JSON encoding are frozen. A response-affecting
behavior change requires a new media type and schema version. An unsupported
vendor media type returns `406`; a v2 CLI does not fall back to the legacy
manifest plus `/v1/channels` flow. Clients without the vendor `Accept` header
continue to receive the unchanged v1 response for self-upgrade compatibility.

The backend loads environment state, providers, selected encrypted auth
payloads, and active Telegram/Discord links with set-based queries inside one
`REPEATABLE READ READ ONLY` snapshot. The endpoint and runtime health summary
use the same pure materializer. Summary rendering does not decrypt secrets.

`sourceRevision` hashes the effective public descriptor plus secret-reference
keyed encrypted-source identities. The strong HTTP ETag hashes the complete v2
response, including plaintext secret values. Neither value is a persisted
desired-state counter.

The CLI holds one converge lock from fetch through validation, projection,
apply, and applied-authority commit. `runtime-applied.json` is the observation
authority. SSE invalidation only reduces latency; conditional polling and the
applied ETag/sourceRevision preserve correctness.

## Consequences

- There is one network representation, validator, apply operation, and applied
  identity for v2 convergence.
- Database mutation fan-out and cross-table revision triggers are unnecessary.
- WhatsApp remains outside v2 while its CLI projection gate is disabled.
- Offline recovery caches the effective projected manifest. Secret persistence
  remains limited to the existing root-only, reference-scoped secret cache; the
  plaintext bundle is never persisted as a whole.
- Cloud expands support for a new media type before a CLI starts requesting it.
