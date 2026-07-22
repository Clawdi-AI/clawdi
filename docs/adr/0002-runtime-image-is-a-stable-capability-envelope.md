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

Provider ownership modes, terminal Codex provider selection, secret references,
egress profiles, and generated Codex configuration or command shims are desired-state
business logic. They are materialized by Cloud and reconciled by the CLI; none
of them may be baked into the stable runtime image or its entrypoints.

Hosted mode is an explicit CLI contract selected by
`CLAWDI_RUNTIME_MODE=hosted`; it is not inferred from image files. The hosted
command policy is built into the CLI. Deployment must provide
`CLAWDI_RUNTIME_MANIFEST_URL` and `CLAWDI_RUNTIME_AUTH_ENV`, whose value names
the environment variable containing the manifest bearer credential. The CLI
validates both selectors and fails closed before datasource access. A hosted
runtime does not read `host-policy.json` or `runtime-source.json`.

Hosted runtime manifests use the single canonical `/v1/runtime/manifest`
datasource contract. `CLAWDI_RUNTIME_MANIFEST_URL` may carry normal query
parameters, but its path must end with `/v1/runtime/manifest`.

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

## Cloud Hosted Authority

The Hosted rollout writer selects an exact CLI package spec. Cloud validates
and persists it, enforces the Cloud-owned `0.12.10-beta.57` minimum, fixes the
package source and official registry, and owns the public manifest projection.
Remote Hosted state cannot provide a floating package, installer URL, installer
args, source, or registry. Bootstrap tgz input is fixture-only, while generic
non-Hosted desired state keeps its existing package, provider, and installer
behavior.

Cloud serializes runtime-state create and update by locking the parent
`AgentEnvironment` before the optional `HostedRuntimeState`, then applies
generation compare-and-swap. Equal identical state is idempotent; stale or
equal-conflicting state fails with a structured `409` containing the current
generation. Committed changes emit signal-only SSE invalidation and remain
recoverable through manifest ETag polling.

Revision `d8f2a1c4b6e9` requires an empty hosted-runtime-state table in both
migration directions and fails before DDL otherwise. The backend migrates before
serving, so an unsatisfied invariant prevents API startup and repeats under an
automatic restart policy. No cross-repository CI, checkout, artifact exchange,
dispatch, or organization Actions access is required by this contract.

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
- The CLI repository independently builds, tests, packs, installs, and
  SHA-verifies one tarball before trusted-publisher OIDC publishes that exact
  prerelease under the standard npm `beta` dist-tag. `beta` is
  non-authoritative publication metadata, not a Hosted rollout selector.
- The Hosted image workflow takes an operator-supplied exact
  `clawdi@<semver>` package spec and performs no npm dist-tag lookup. A CLI-only
  change first validates that package against the current digest-pinned image
  and reuses the digest when the pairing smoke passes; it builds a new image
  only after a validate-only failure demonstrates image incompatibility.
  Production rollout selection lives in persisted Hosted setting/config, and
  Cloud constructs the public manifest from that exact selection. Neither
  repository calls the other repository's Actions workflows. No legacy image
  controls or old-state repair are part of this contract.

## Related Documentation

- [Managed runtime architecture](../managed-runtime.md)
- [Managed runtime CLI plan](../plans/managed-runtime-cli.md)
- [Managed runtime roadmap](../plans/managed-runtime-roadmap.md)
- [CLI development and release](../cli-development.md#releasing)
- [Clawdi release runbook](../runbooks/release.md)
