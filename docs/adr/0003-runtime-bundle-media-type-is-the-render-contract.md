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
or missing media type returns `406`; the CLI does not fall back to a legacy
manifest representation or a separate `/v1/channels` flow. Agent v2 had no
released client, so the endpoint has no unpublished compatibility response.

The backend loads environment state, providers, selected encrypted auth
payloads, and active Telegram/Discord links with set-based queries inside one
`REPEATABLE READ READ ONLY` snapshot. The endpoint and runtime health summary
use the same pure materializer. Summary rendering does not decrypt secrets.

The runtime provider plane has an explicit `configured | unmanaged`
discriminator. Runtime `providers` remains an exact projection of runtime
`provider_ids`; unmanaged renders both as empty and omits the runtime primary
model. Hosted Codex is a distinct typed `terminalTooling.codex` projection. Its
provider material is resolved from the same snapshot and deduplicated with a
shared configured runtime provider, but it is excluded from runtime provider
identity, observations, and health. Terminal Codex does not imply MCP.

`sourceRevision` hashes the effective public descriptor plus secret-reference
keyed encrypted-source identities. Because the v2 media-type renderer is
immutable, its strong HTTP ETag is derived as `"sha256:<sourceRevision>"`.
The frozen renderer plus that source identity covers every effective response
field without decrypting secrets in the summary path. The legacy v1 response
does not exist. The validator is not a persisted desired-state counter, table,
singleton, trigger, or cache.

The CLI holds one converge lock from fetch through validation, projection,
apply, and applied-authority commit. `runtime-applied.json` is the observation
authority. Its v2 record stores the source manifest's provider ID set alongside
the target-specific projected provider ID map used for stale deletion. The
heartbeat reports the source-level set, while health requires exact equality
with current desired provider IDs. SSE invalidation only reduces latency;
conditional polling and the applied ETag/sourceRevision preserve correctness.

## Consequences

- There is one network representation, validator, apply operation, and applied
  identity for Agent v2 convergence.
- Bundle `200` and `304` responses identify the vendor media type explicitly.
- Missing or unsupported media-type `406` responses vary on `Accept` and are
  not cached.
- Database mutation fan-out and cross-table revision triggers are unnecessary.
- WhatsApp remains outside v2 while its CLI projection gate is disabled.
- Offline recovery caches the effective projected manifest. Secret persistence
  remains limited to the existing root-only, reference-scoped secret cache; the
  plaintext bundle is never persisted as a whole.
- A future renderer change adds a new exact media type; clients never negotiate
  by fallback.
