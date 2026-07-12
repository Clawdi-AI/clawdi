# ADR-0002: Runtime Image Is a Stable Capability Envelope

**Status:** Accepted
**Date:** 2026-07-10
**Deciders:** Clawdi maintainers

## Context

The managed runtime image must remain a generic, stable host envelope rather
than accumulate Clawdi runtime business logic. Hosted
[PR #755, "Remove hosted image business logic"](https://github.com/Clawdi-AI/clawdi-hosted/pull/755)
established this direction. The Hosted architecture describes the host
envelope as stable and the image as absolutely stable.

Transparent egress needs filesystem paths, private CA and secret ownership, a
non-root mitmproxy identity, and nftables lifecycle management. Encoding those
details as named image accounts or image bootstrap logic would couple runtime
behavior to image releases and split ownership between the image and CLI.

## Decision

The runtime image supplies stable operating-system capabilities. The Clawdi CLI
owns runtime-local module paths, generated configuration, permissions,
privilege dropping, and lifecycle behavior.

Hosted mode is an explicit CLI contract selected by
`CLAWDI_RUNTIME_MODE=hosted`; it is not inferred from image files. The hosted
command policy is built into the CLI. Deployment must provide
`CLAWDI_RUNTIME_MANIFEST_URL` and `CLAWDI_RUNTIME_AUTH_ENV`, whose value names
the environment variable containing the manifest bearer credential. The CLI
validates both selectors and fails closed before datasource access. A hosted
runtime does not read `host-policy.json` or `runtime-source.json`.

API route versions and agent deployment generations are separate dimensions.
`/v1/runtime/manifest` is the only agent-v2 runtime manifest URL. The runtime
router is not exposed through the legacy `/api` alias. Agent deployment v1 does
not consume the `HostedRuntimeState` manifest surface.

The Hosted rollout writer selects the exact agent-v2 CLI package version as
`cli_package_spec`. Cloud validates and persists that value, then remains the
sole authority for its public manifest projection. The value must be
`clawdi@<exact-semver>`, must not contain build metadata, and must be at least
the Cloud-owned `0.12.10-beta.51` floor. Cloud fixes manifest source to
`npm:clawdi` and registry to `https://registry.npmjs.org`; Hosted cannot send
source or registry authority. The CLI reads the Cloud manifest before its first
managed install. `minimumCliVersion` uses the same Cloud-owned floor; locale and
active invalidation do not introduce another version authority.

Every agent-v2 manifest explicitly selects one enabled `openclaw` or `hermes`
compute runtime in top-level `runtime` and includes only that runtime in
`runtimes`; Codex remains an add-on/live-sync agent type. Ambiguous, missing, or
unsupported selection fails closed. The selected runtime is part of the
manifest ETag. Cloud derives strict `controlPlane: {cloudApiUrl}` from its own
public API origin, so Hosted cannot supply manifest or API URLs. The public
manifest does not emit `appId`.

Hosted runtime state requires canonical `system`, runtime `paths.home` and
`paths.workspace`, a non-empty `provider_ids` pool, structured
`primary_model: {provider_id, model}`, and
`install: {source: "official"}`. Installer URLs, channels, and invocation
arguments are CLI-owned implementation details and are rejected from Cloud
desired state. Cloud validates strict `install`, `run`, and `services` objects
before persistence and validates stored JSON again before manifest assembly.
Provider aliases, single-provider fields, model strings, unknown nested keys,
and account-provider fallback are not part of agent v2.

Every agent-v2 hosted manifest has a strict top-level `locale` object with
exactly `language` and `timezone`. `language` must be one of the product's
supported language codes, and `timezone` must be a valid IANA timezone.
Personality is not Cloud runtime desired state and is rejected by the admin
writer. Revision `d8f2a1c4b6e9` adds required `locale` JSONB and
`cli_package_spec` string columns with no defaults or backfill, makes
`hosted_runtime_states.system` non-null, and drops the obsolete
`hosted_runtime_states.clawdi_cli`, `hosted_runtime_states.control_plane`, and
`hosted_runtime_states.provider_id` columns. Both migration directions
deliberately fail before DDL if runtime state exists. That failure stops the
operation and directs operators to the approved resolution or decommission
procedure; because the backend migrates before serving, automatic restarts
repeat the failure until operators resolve it. The migration does not prescribe
direct deletion, repair, backfill, or state preservation.

Runtime-state writes use generation compare-and-swap under the existing row
lock. Lower generations fail with structured `stale_generation` conflicts;
equal generations with material differences fail with structured
`generation_conflict` responses. Both include `current_generation`. Equal and
identical effective state is idempotent, while higher generations apply.

`GET /v1/sync/events` carries a signal-only
`runtime_manifest_changed` event containing the environment id, never desired
configuration. Bound deploy keys receive only their exact environment;
unbound user keys may receive user-owned environment events and filter again
client-side. The mutation transaction queues PostgreSQL `NOTIFY`, which is
released only after commit, and every API process keeps a reconnecting
`LISTEN` connection. Normal manifest ETag polling remains the missed-event
fallback.

For transparent egress:

- `clawdi runtime sidecar` remains the only public support command;
  `mitmdump` is an internal engine.
- `CLAWDI_EGRESS_UID` and `CLAWDI_EGRESS_GID` are explicit numeric identities,
  defaulting to `10002`. Both must be decimal Linux IDs from `1` through
  `4294967294`; `0` and the `4294967295` chown sentinel are forbidden.
- Private egress CA and secret material is owned directly by that numeric
  UID/GID. Root-readable egress configuration and the projected system CA
  remain root-owned.
- When the sidecar starts as root, it drops privileges with `setpriv --reuid`
  and `--regid` plus `--clear-groups`, or with numeric `gosu UID:GID` when
  `setpriv` is unavailable. Startup fails closed if neither mechanism exists.
- When the sidecar starts as non-root, its current UID and GID must exactly
  match the configured egress identity before `mitmdump` can start.
- No named egress account, passwd lookup, account creation, compatibility
  alias, or old-account cleanup is part of the runtime contract.
- The nftables program remains the minimal managed table: bypass the egress
  UID, redirect the runtime UID's TCP ports 80 and 443, and remove only that
  table during cleanup.
- Bridge credentials and surfaces are excluded from the egress engine child
  environment.

## Options Considered

### Named account owned by the image

This gives conventional passwd metadata but makes the image responsible for a
Clawdi-specific identity and requires image rollout for runtime policy changes.
It conflicts with the stable capability-envelope boundary.

### CLI-owned numeric identity

This keeps the image generic, makes ownership explicit, avoids account lookup,
and permits deterministic fail-closed privilege dropping. It requires the host
envelope to provide `setpriv` or numeric `gosu` and reserve the configured IDs.

## Consequences

- Runtime egress behavior can evolve through CLI rollout without image churn.
- Files remain accessible to an egress process even when no matching
  `/etc/passwd` entry exists.
- UID/GID `0`, malformed values, and unavailable privilege-drop tools prevent
  egress startup instead of silently running mitmproxy as root.
- Hosted image changes that add runtime business logic violate this decision.
- Coordinated rollout order is: publish and verify an exact CLI version; have
  the Hosted rollout writer submit that exact `cli_package_spec`; then deploy
  Cloud and Hosted before launching agent deployment v2. Verify runtime-state
  writes, `/v1/runtime/manifest`, manifest fetch, sync-event invalidation, and
  runtime services. No cross-repository workflow, organization Actions access,
  or legacy agent image controls are required by this contract.

## Related Documentation

- [Managed runtime architecture](../managed-runtime.md)
- [Managed runtime CLI plan](../plans/managed-runtime-cli.md)
- [Managed runtime roadmap](../plans/managed-runtime-roadmap.md)
