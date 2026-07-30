# ADR-0003: Runtime Bundle Media Type Is the Render Contract

**Status:** Accepted (amended 2026-07-30)
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

The v2 renderer and canonical JSON encoding are frozen except for the narrow
consumer-first amendment below. Any other response-affecting behavior change
requires a new media type and schema version. An unsupported
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

### 2026-07-30 generation identity amendment

The inner manifest `generation` permanently remains the checkpoint/content
generation. The bundle root may additionally contain positive
`applyGeneration` as the deployment Apply identity. The checkpoint and Apply
sequences are independently positive and monotonic; there is no ordering
relationship between their values.
When runtime state has no explicit Apply generation, the backend omits the root
field and preserves the previously released bundle bytes, `sourceRevision`, and
ETag. When present, `applyGeneration` participates in `sourceRevision`, so an
Apply-only advance cannot receive an incorrect `304`.

This is a one-field amendment to correct an identity conflation, not a second
renderer or state machine. The CLI uses one named compatibility resolver:
explicit `applyGeneration` wins, otherwise legacy state falls back to
`generation`. The same rule governs bundle Apply validation, durable applied
state, offline recovery, observation tuples, and backend health. Durable
`runtime-applied.json` retains checkpoint `generation` and optional
`applyGeneration` separately.

Previously released CLI schemas reject unknown bundle fields. Therefore the
activation gate is the nullable persisted `apply_generation` itself: it is
default-closed and the renderer omits the wire field while it is null. This OSS
consumer release must be deployed before any Hosted producer writes a non-null
value. Hosted activation is permitted only after the compatible CLI is present
on every targeted runtime.

Existing split identities require an ordered pre-activation rollout. For the
concrete metadata/apply `1`, checkpoint `2` case, the Hosted producer remains
off while the existing accepted
`POST /v2/deployments/{deployment_id}/restart` path increments only its
desired-state `rollout_nonce`; the legacy checkpoint floor then aligns the pair
to `2/2` without changing runtime-state content. Only after that equality may
the exact CLI pin and its ordinary controlled rollout advance both sequences to
`3/3`.
Pinning the CLI directly from `1/2` would instead produce `2/3`, which the old
single-generation fallback rejects. The rollout must then verify the online
bundle, durable applied state, last-good cache, offline boot, observation tuple,
and canonical Agent health before the Hosted producer gate is enabled. This is
a release-order constraint over the existing restart and desired-state paths,
not another state machine.

This compatibility phase is temporary. After all active CLIs accept the field
and all persisted runtime/applied states carry explicit Apply generation, a
follow-up contract release can remove nullable field shapes, the legacy
fallback, the null-as-omission activation gate, rollout notes, and legacy
fallback tests. That release must either introduce the next media type or amend
this ADR again before making the v2 field required; it must not leave a
permanent dual-track protocol.

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
- Checkpoint/content generation and deployment Apply generation remain distinct
  through rendering, cache, applied state, and observation.
- A future renderer change adds a new exact media type; clients never negotiate
  by fallback.
