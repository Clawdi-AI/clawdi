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
- The CLI release uses exact version `0.12.10-beta.51` on the isolated npm
  `agent-v2` dist-tag without moving `beta`. The CLI repository independently
  builds, tests, packs, installs, and SHA-verifies one tarball before
  trusted-publisher OIDC publishes that artifact. The Hosted image repository
  independently resolves the published CLI to an exact npm semver and runs its
  image/CLI pairing smoke as part of its own image release. Neither repository
  calls the other repository's Actions workflows. No legacy image controls or
  old-state repair are part of this contract.

## Related Documentation

- [Managed runtime architecture](../managed-runtime.md)
- [Managed runtime CLI plan](../plans/managed-runtime-cli.md)
- [Managed runtime roadmap](../plans/managed-runtime-roadmap.md)
- [CLI development and release](../cli-development.md#releasing)
- [Clawdi release runbook](../runbooks/release.md)
