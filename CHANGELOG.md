# Changelog

This changelog tracks notable user-facing Clawdi releases. It is written for
people using or upgrading Clawdi, so it intentionally omits internal deployment,
database migration, CI, and implementation details.

- Clawdi app/backend/web releases use `clawdi-YYYY-MM-DD` for the first UTC
  release of a day, then `clawdi-YYYY-MM-DD-2`, `-3`, and so on for
  additional releases that same day. Older releases may use the previous dotted
  `clawdi-v...` CalVer tag format.
- CLI/npm releases use `clawdi-cli-vX.Y.Z`.

## Unreleased

### Added

- Session search now matches visible user and assistant message text in addition to summaries, folders, and IDs. CLI and Web results show the best matching message excerpt; private reasoning, tool payloads, system messages, and hidden events remain excluded.
- Session detail pages can search the current transcript directly, move between matches, and highlight matching text without loading the whole conversation.

### Changed

- Hosted plan selection now explains the single 7-day trial shared by an
  account's first Basic or Performance subscription, while grandfathered Basic
  capacity is labeled Included.
- Newest-first Session detail pages now paginate from the actual visible transcript instead of relying on separately reported message counts, including for incrementally appended event chunks.
- Session search keeps its controls visible in long conversations, supports keyboard match navigation, shows clearer loading feedback, and gives message matches more context in result cards.
- The public README now focuses on the two run paths, current product capabilities, quickstart, and self-hosting entry points.
- The product tour now shows messaging Channels and explains the separate bot, Agent link, and paired-chat boundaries.

### Fixed

- Managed CLI installations now create protected directories independently of
  the parent process's umask, without relaxing verification of existing paths.
- Managed runtime egress no longer emits raw request URLs or WebSocket control
  payloads in routine logs; certificate validation and warnings remain enabled.
- Managed runtimes accept released images' initial CLI bootstrap receipts
  without a spurious invalid-status warning. Adoption revalidates the installed
  CLI; malformed or unsafe state now stops instead of being overwritten.
- Ending a hosted trial now shows subscription updates while the agent stops,
  rather than waiting for payment. Expired checkouts can be retried, while
  uncertain payment results retain the original request and provide support guidance.

- OpenClaw sync serializes asynchronous discovery commands to reduce overlapping
  memory use. Skill polling survives inventory failures without reporting false
  deletions, and skill synchronization performs fewer workspace lookups.
- CLI health reporting no longer stalls during OpenClaw session scans, sends
  compatible sync heartbeats, and promptly refreshes observations after delayed
  acknowledgements while retaining bounded retries.
- Hosted runtime reconciliation now reloads user systemd services after an
  official runtime installer replaces their unit definitions, even when the
  restored managed drop-in is byte-for-byte unchanged.
- Managed Discord connections now reset reconnect backoff after a successful
  Gateway session and resume immediately when Discord requests a reconnect,
  avoiding minute-long offline windows after earlier transient failures.
- Managed Discord reconnects now discard expired interaction events after their
  short-lived response tokens have been scrubbed, instead of repeatedly
  crashing upgraded clients before later messages can be delivered.
- Session detail search now preserves spaces while typing multi-word queries.
- Session search now indexes very large messages in bounded chunks, so long
  transcripts remain fully searchable without exceeding PostgreSQL full-text
  limits; results and match navigation still point to the original message.
- Managed OpenClaw WhatsApp now installs the exact plugin version compatible with the runtime.
- Hosted OpenClaw upgrades now retire the legacy Clawdi provider plugin even
  when OpenClaw requires capability consent before it can inspect the plugin.

## Clawdi CLI v0.14.48

Package: `clawdi@0.14.48`

### Fixed

- Reuse existing Hermes and OpenClaw background services instead of reinstalling
  them when version displays or native service definitions change.
- Prepare Hermes service configuration before starting the gateway, and reload
  systemd when native service changes precede reconciliation.
- Preserve the latest failed installer log after successful recovery, and avoid
  treating failed inspections or stale cached versions as a repair request.
- Reduce overlapping OpenClaw discovery processes and keep skill polling alive
  through inventory failures without reporting false deletions.

## Clawdi CLI v0.14.35

Package: `clawdi@0.14.35`

### Added

- Connected Agents now use a stable local installation identity instead of
  deriving identity from the hostname, platform, and architecture.
- `clawdi agent reconnect` can restore a lost local binding to an existing
  Connected Agent without creating a second Cloud identity.

### Changed

- Logging out preserves local Agent registrations with an account binding, so
  signing back into the same account remains stable without exposing those
  registrations after an account switch.

### Fixed

- Damaged installation identity state now fails safely instead of silently
  rotating identity and risking a duplicate Agent registration.

## Clawdi CLI v0.14.34

Package: `clawdi@0.14.34`

### Fixed

- Hosted runtime reconciliation now restarts a failed systemd service when the
  current transaction changed that service or still needs to activate its
  latest definition. This lets managed environment drop-ins recover after an
  official runtime installer replaces the base unit.

## Clawdi CLI v0.14.33

Package: `clawdi@0.14.33`

### Changed

- Hosted OpenClaw now negotiates native plugin capabilities across the supported
  `2026.7.1-2` and `2026.8.1` releases.
- Hosted OpenClaw uses its native environment-backed provider authentication
  without the historical `clawdi-managed-provider` metadata plugin. Existing
  Clawdi-owned installations are removed automatically during convergence.

### Fixed

- OpenClaw session sync now scans sessions in bounded batches, skips unchanged
  transcripts by revision, and uses the release-appropriate native transcript
  API or JSONL fallback without breaking incremental updates.

## Clawdi CLI v0.14.32

Package: `clawdi@0.14.32`

### Changed

- CLI help and package metadata now use the approved “best home” positioning and
  concise run-path supporting copy.

## Clawdi CLI v0.14.31

Package: `clawdi@0.14.31`

### Changed

- CLI help and package metadata now describe Clawdi's released run paths and
  shared Agent resources without listing roadmap features.

## Clawdi CLI v0.14.30

Package: `clawdi@0.14.30`

### Changed

- CLI help and package metadata were updated to the product positioning used for
  this release.

## Clawdi CLI v0.14.29

Package: `clawdi@0.14.29`

### Fixed

- Hosted Hermes session sync now scans large history stores in bounded batches
  and avoids reloading unchanged transcripts, preventing daemon restart loops
  on large state databases without dropping queued sessions.

## Clawdi CLI v0.14.28

Package: `clawdi@0.14.28`

### Added

- Hosted OpenClaw can receive a separate manifest-declared embedding provider
  without changing its primary chat provider.

## Clawdi CLI v0.14.27

Package: `clawdi@0.14.27`

### Fixed

- Managed OpenClaw embedding settings now follow the installed config schema,
  repair the incompatible legacy path, and clear when the managed provider is removed.

## Clawdi CLI v0.14.26

Package: `clawdi@0.14.26`

### Fixed

- Hosted Hermes WhatsApp gateways now keep the explicit allow-all safety opt-in required by their managed open access policy after CLI upgrades.

## Clawdi CLI v0.14.25

Package: `clawdi@0.14.25`

### Added

- Hosted OpenClaw can use the embedding model declared by its runtime provider
  for managed memory search without exposing that model as a chat option.

## Clawdi CLI v0.14.24

Package: `clawdi@0.14.24`

### Fixed

- Hosted OpenClaw and Hermes channel reconciliation now preserves user-authored
  access policies, allowlists, and channel experience preferences.

## Clawdi CLI v0.14.23

Package: `clawdi@0.14.23`

### Fixed

- Hosted Hermes channel reconciliation now preserves user-authored channel
  preferences, including Discord free-response channels.

## Clawdi CLI v0.14.22

Package: `clawdi@0.14.22`

### Added

- OpenCode is available as a Connected sessions-only adapter. It reads the official SQLite store and incrementally syncs messages, hidden text, private reasoning, tool calls/results, safe attachment metadata, and lifecycle markers.
- Rich Session events now preserve owner-private reasoning and continuation state while ordinary content, sharing, search, and memory projections remain limited to useful visible messages.

## Clawdi CLI v0.14.21

Package: `clawdi@0.14.21`

### Fixed

- Hosted runtimes now enable generated system services in the volatile systemd unit tree, so immutable images no longer fail by trying to write persistent links under `/etc`.

## Clawdi CLI v0.14.20

Package: `clawdi@0.14.20`

### Added

- Pi is now available as a Connected sessions-only adapter, including active-branch and compaction-aware JSONL ingestion.
- Rich Session upload preserves visible messages and structured tool calls/results through an incremental, retry-safe event protocol when the server supports it. Attachments are explicit external references or metadata-only records in this release; attachment bytes, local paths, hidden reasoning, and encrypted continuation state are never uploaded.

### Changed

- Local adapters now advertise complete Sessions and Skills modules. Setup, sync, commands, and Connected dashboard routes only start or show modules the adapter actually supports.
- Session uploads are fenced by Cloud origin, Agent origin, adapter, source identity, and exact stored-content receipts. Oversized legacy Sessions now enter durable blocked health instead of retrying indefinitely.

## Clawdi CLI v0.14.19

Package: `clawdi@0.14.19`

### Changed

- The manifest fallback polling interval is now uniformly jittered around its 15-second average. Fleets no longer phase-align into synchronized request bursts after rollouts, which removes the shared ~1s latency floor those bursts imposed on the control plane.

## Clawdi CLI v0.14.18

Package: `clawdi@0.14.18`

### Changed

- Steady-state converge now completes in about a second with single-digit process spawns (previously ~25s and dozens of spawns): Hermes config reconciliation reads and writes the config once per round, OpenClaw probes are cached against manifest revisions with on-disk verification, and systemd state is read in batch.
- Successful convergence is reported to the control plane immediately instead of waiting for the next heartbeat, so plugin and skill installs show as applied right away.
- The per-round recursive ownership sweep of the tenant home was removed; every write path now creates files under the correct owner (requires upgrading from 0.14.17).

### Removed

- Expired migration guards for pre-0.14.17 on-disk state (legacy applied-state fields, CLI upgrade journal, MCP ledger and WhatsApp marker cleanup, retired runtime state cleanup, Hermes legacy gateway argv). Upgrading directly from 0.13.x to 0.14.18 is not supported; upgrade through 0.14.17 first.

## Clawdi CLI v0.14.17

Package: `clawdi@0.14.17`

### Fixed

- First converge after an upgrade no longer reruns official runtime installers (and no longer restarts the OpenClaw gateway a second time): a missing service command-revision record is adopted from the live binary instead of being treated as a change.

## Clawdi CLI v0.14.16

Package: `clawdi@0.14.16`

### Fixed

- Bundled Skill staging on hosts with a root-only platform state root: tree verification now stages the platform source as root and only reads the tenant tree as the runtime user. Hosts stuck on "prepared bundled Skill could not be staged" self-heal on upgrade.
- Managed Skill staging errors now carry the underlying cause, errno, and path.

## Clawdi CLI v0.14.15

Package: `clawdi@0.14.15`

### Changed

- Major internal consolidation: ~17,400 lines removed with behavior preserved
  (single-authority state records, single wire manifest schema, single-file CLI
  upgrade state).
- Runtime apply flattened to a declarative line; failed candidate generations
  recover by replaying the last-good manifest (whole-tree snapshots, systemd
  transaction journal, and /proc revision proofs removed).
- Tenant home is now fully tenant-owned; legacy root-owned systemd trees
  migrate once on first converge.
- Operational note: the first converge after upgrading reinstalls each managed
  skill once and restarts managed agent units once (state-record format
  promotion). Roll out off-peak.

## Clawdi CLI v0.14.14

Package: `clawdi@0.14.14`

### Changed

- Collapse hosted Skill ownership to the reservation ledger; platform receipt
  subsystem removed (net -900 lines).
- WhatsApp auth directory: adopt 0.13.x in-tree marker into the platform
  receipt on upgrade, session preserved.

## Clawdi CLI v0.14.13

Package: `clawdi@0.14.13`

### Fixed

- Managed service enablement is now declared by the platform writing the
  systemd wants links directly, removing the tenant-manager `enable` calls
  that failed on brand-new hosts. Fresh deployments for both Hermes and
  OpenClaw converge end to end, verified in a faithful zero-state environment.

## Clawdi CLI v0.14.12

Package: `clawdi@0.14.12`

### Fixed

- Fresh deployments converge on first boot: systemd files created for the
  first time are published with manager-readable permissions before official
  installers start gateways, and activation proof waits for the manager
  reload it just required. Existing deployments were unaffected.

## Clawdi CLI v0.14.11

Package: `clawdi@0.14.11`

### Improved

- Convergence no longer reports transient errors when a gateway is restarting
  during an upgrade handoff.
- Completed one-shot migrations from the 0.14.x rollout were removed now that
  the fleet has fully converged, together with the last internal module
  dependency cycles.

## Clawdi CLI v0.14.10

Package: `clawdi@0.14.10`

### Fixed

- Skills installed through the retired loopback-URL path are migrated once to
  Hermes's local form via the official uninstall, clearing stale hub install
  records; genuinely user-installed hub skills are untouched.

## Clawdi CLI v0.14.9

Package: `clawdi@0.14.9`

### Fixed

- Hosted Hermes skills now install by placing the verified bytes directly into
  Hermes's official local skills directory — the same mechanism the bundled
  skill has always used — instead of driving `hermes skills install` over a
  loopback URL. This removes the installer's scanner, naming, and
  reference-fetch failure modes entirely.
- Repairing drifted ownership no longer re-runs official service installers:
  install receipts are bound to content only, not ownership metadata.
- Platform enclaves stay root-owned at all times outside installer critical
  sections, and skill reservations are recorded only after a verified install.

## Clawdi CLI v0.14.8

Package: `clawdi@0.14.8`

### Fixed

- The loopback skill source now serves the staged archive's actual contents
  and lets Hermes's official semantics decide about missing referenced files;
  a skill with broken content fails alone, attributed by name, without
  blocking the remaining skills.

## Clawdi CLI v0.14.7

Package: `clawdi@0.14.7`

### Fixed

- Hosted project skills install from locally verified bytes served over a
  transient loopback source, removing the network fetch (and its rate limits)
  from Hermes skill installs entirely while keeping the official installer
  path.

## Clawdi CLI v0.14.6

Package: `clawdi@0.14.6`

### Fixed

- Hosted project skills now install correctly on Hermes 0.20: the installed
  location is resolved from Hermes's own install lock instead of assuming the
  manifest ID names the directory, and installs that print errors but exit
  zero are no longer treated as success.

## Clawdi CLI v0.14.5

Package: `clawdi@0.14.5`

### Fixed

- Repairing drifted ownership of systemd artifacts now also restores the
  read/traverse permissions the tenant's systemd user manager needs, so the
  repair no longer makes running units unresolvable. A bounded daemon-reload
  retry guards enable calls when the manager's unit view is stale.

## Clawdi CLI v0.14.4

Package: `clawdi@0.14.4`

### Fixed

- Stale skill reservations whose target directory no longer exists are now
  released idempotently instead of failing convergence with a misleading
  "tree is unsafe" error.
- Platform-owned systemd artifacts inside the tenant home that had drifted to
  tenant ownership are repaired back to root; the ownership enforcer is now
  bidirectional across declared platform enclaves.

## Clawdi CLI v0.14.3

Package: `clawdi@0.14.3`

### Fixed

- Legacy root-owned skill metadata left by older CLI versions no longer breaks
  convergence: tenant-home ownership is repaired as a platform invariant before
  every converge, legacy markers are claimed through a single adoption path,
  and one skill failing to install no longer blocks the remaining skills.

### Improved

- All platform metadata (skill receipts, WhatsApp auth ownership) now lives in
  platform state outside the tenant home; tenant directories contain only
  tenant-owned content, read and written strictly as the runtime user.

## Clawdi CLI v0.14.2

Package: `clawdi@0.14.2`

### Fixed

- Managed skill installs are now anchored to the receipt of what the official
  installer actually wrote, instead of predicting the installer's byte
  transformation. This removes the "did not preserve the exact native catalog
  projection" failure class entirely and decouples skill convergence from the
  installed Hermes version.

## Clawdi CLI v0.14.1

Package: `clawdi@0.14.1`

### Fixed

- Hermes plugin installs no longer fail when `plugins.scan_on_install` has
  never been set: the managed install-scanner policy is now a simple idempotent
  persistent setting instead of a transient toggle that read the current value
  first.

## Clawdi CLI v0.14.0

Package: `clawdi@0.14.0`

This release consolidates a full review-and-hardening pass over the hosted
runtime supervisor.

### Security

- Commands the supervisor runs as the runtime user no longer inherit platform
  credentials, and tenant-writable directories are removed from their `PATH`,
  closing a credential-exposure and command-shadowing window.

### Fixed

- Failed CLI self-upgrades now roll back automatically to the previous
  verified version, with a one-hour cooldown before the same version is
  retried, so a bad rollout can no longer strand a fleet.
- Agent plugin failures during reconvergence are reported truthfully to the
  control plane instead of being filtered as healthy.
- Managed skills tampered with inside the runtime now self-heal on the next
  convergence, and a cleanup failure can no longer roll back a committed
  install.
- OpenClaw configuration drift now restarts the runtime after repair, matching
  Hermes behavior.
- Corrupted supervisor state files (upgrade journal, heartbeat state) are
  quarantined and rebuilt instead of permanently blocking convergence.
- Hermes plugin installs disable the upstream install scanner only for the
  duration of the managed install and restore the tenant's own setting
  afterwards.

### Improved

- The hosted convergence engine was consolidated and split into
  single-responsibility modules, removing duplicated validation, ownership,
  and rollback logic across runtimes without behavior changes.

## Clawdi CLI v0.13.109

Package: `clawdi@0.13.109`

### Improved

- Updated the CLI build toolchain for Bun 1.4 while retaining the supported
  Node.js 22 runtime baseline.

## Clawdi CLI v0.13.108

Package: `clawdi@0.13.108`

### Fixed

- Hosted Hermes commands now fully drop root credentials before starting, so
  first-boot runtime files remain owned by the runtime user.

## Clawdi CLI v0.13.107

Package: `clawdi@0.13.107`

### Improved

- Updated CLI dependencies and release tooling while retaining the supported
  Node.js 22 runtime baseline.

## Clawdi CLI v0.13.106

Package: `clawdi@0.13.106`

### Improved

- Multi-agent Session sync now uses targeted local scans for faster updates,
  while cloud Session metadata can be searched and read across agents.

## Clawdi CLI v0.13.105

Package: `clawdi@0.13.105`

### Fixed

- Hosted v2 installs OpenClaw or Hermes only when its runtime executable is
  missing. An installed runtime that lacks a required Hosted capability now
  fails convergence without automatically reinstalling or upgrading it.

## Clawdi CLI v0.13.104

Package: `clawdi@0.13.104`

### Fixed

- Hosted v2 OpenClaw deployments no longer inherit an exact OpenClaw version
  from the Clawdi CLI. OpenClaw and Hermes now both use their official
  installers' default latest release without a version argument.

## Clawdi CLI v0.13.103

Package: `clawdi@0.13.103`

### Fixed

- Hosted v2 deployments now keep core runtime convergence and CLI upgrades
  healthy when a Skill or Agent Plugin cannot be projected after exact local
  rollback. Resource delivery remains visible and retryable without blocking
  the agent or its browser interface.

## Clawdi CLI v0.13.102

Package: `clawdi@0.13.102`

### Fixed

- Hosted v2 OpenClaw deployments now repair private runtime state-directory
  ownership before official installer and config-repair commands run, allowing
  existing deployments with legacy ownership drift to converge normally.

## Clawdi CLI v0.13.101

Package: `clawdi@0.13.101`

### Fixed

- Hosted v2 OpenClaw recovery now checks only the public SDK exports shipped by
  the pinned OpenClaw package, allowing existing deployments to upgrade and
  clean stale managed-provider credentials before gateway activation.

## Clawdi CLI v0.13.100

Package: `clawdi@0.13.100`

### Fixed

- Hosted v2 OpenClaw convergence now installs the audited exact
  `openclaw@2026.8.1-beta.2` package, repairs existing version drift, verifies
  the installed version exactly, and delegates downgrade protection to the
  official installer's config-writer compatibility guard.

## Clawdi CLI v0.13.99

Package: `clawdi@0.13.99`

### Fixed

- Hosted v2 OpenClaw recovery now registers the managed API-key environment
  marker before repairing legacy config, so existing deployments can converge
  without persisting the marker as a local credential.

## Clawdi CLI v0.13.98

Package: `clawdi@0.13.98`

### Fixed

- Hosted v2 OpenClaw deployments now keep their managed environment SecretRef
  as the sole `clawdi` API-key authority, prevent doctor from persisting its
  marker as a credential, and remove stale local `clawdi` auth state during
  normal runtime reconciliation.

## Clawdi CLI v0.13.96

Package: `clawdi@0.13.96`

### Fixed

- Hosted runtime dashboards remain available when only managed Skill or Agent
  Plugin projection fails, while core runtime failures continue to report an
  error and fail closed.
- Hermes Skill removal and failed-install recovery now follow the native CLI's
  confirmation and ownership contracts.
- OpenClaw Agent Plugin repair now uses its supported overwrite mode and
  verifies the installed package from structured provenance records.

## Clawdi CLI v0.13.78

Package: `clawdi@0.13.78`

### Fixed

- Hosted agents no longer retain redundant installer egress profiles or
  intercept WhatsApp traffic when no managed WhatsApp Link is configured.

## Clawdi CLI v0.13.65

Package: `clawdi@0.13.65`

This entry summarizes notable upgrade behavior from v0.13.44 through v0.13.65.

### Added

- Hosted Hermes and OpenClaw runtimes can receive managed WhatsApp channel
  bindings through the runtime bundle, with Link-scoped credentials and
  fail-closed validation.

### Fixed

- Exact Hosted CLI-only updates hand off to the new CLI without restarting
  healthy daemon, egress sidecar, or runtime services. Failed or inactive units
  still follow the normal recovery path.
- Hermes WhatsApp restores recipient encryption state and restarts only the
  affected Hermes gateway when its managed credentials rotate.
- Hosted upgrades and restarts preserve active service state and OpenClaw
  configuration while repairing Clawdi-owned Skill, MCP, provider, and gateway
  state when its durable ownership or generated files need reconstruction.

## Clawdi CLI v0.13.43

Package: `clawdi@0.13.43`

### Fixed

- Hosted runtime platform roots keep their systemd-defined access modes:
  the CLI no longer re-asserts modes on `/etc/clawdi`, `/var/lib/clawdi`,
  `/var/cache/clawdi`, or `/run/clawdi` when it writes files inside them, so
  the root-owned `0700` configuration and cache boundaries stay closed to
  the tenant user.

## Clawdi CLI v0.13.42

Package: `clawdi@0.13.42`

### Fixed

- Transparent egress on every tenant: the runtime now publishes
  `transparent-egress.env` owned by root with a mode that lets the numeric
  egress identity read it, so the mitmproxy add-on can load the tenant's
  mTLS and copy rules instead of failing convergence.

## Clawdi CLI v0.13.41

Package: `clawdi@0.13.41`

### Fixed

- Hosted convergence now refuses to run unless the resolved runtime identity
  matches the tenant contract, so a stray `HOME` can no longer redirect a tenant
  into the wrong home or let installers run as root.
- The shared `/run/clawdi` root is owned solely by the boot preparation unit,
  and convergence can no longer recreate a missing platform root.
- External runtime probes, installs, and uninstalls are bounded, so a wedged
  third-party CLI fails convergence instead of hanging it.

## Clawdi CLI v0.13.40

Package: `clawdi@0.13.40`

### Changed

- The hosted runtime context is now the single file `/etc/clawdi/runtime-context.json`
  instead of a directory containing one identically named file.
- Hosted platform data follows FHS and systemd conventions: configuration under
  `/etc/clawdi`, durable state under `/var/lib/clawdi`, disposable data under
  `/var/cache/clawdi`, and runtime data under `/run/clawdi`. systemd owns these
  roots through its directory directives, and every status file now lives in one
  place. Tenant tools use their own npm and XDG defaults.

## Clawdi CLI v0.13.38

Package: `clawdi@0.13.38`

### Fixed

- Hosted runtime convergence now uses one probed privilege-drop strategy for
  runtime-user CA checks, systemd operations, installers, and launched services,
  without depending on `gosu`.

## Clawdi CLI v0.13.36

Package: `clawdi@0.13.36`

### Changed

- Hosted runtime manifests now use the exact `clawdiCli.packageSpec` as their
  sole desired CLI version, with exact installation, verification, atomic
  activation, and self-re-exec completed before manifest convergence.

## Clawdi CLI v0.13.13

Package: `clawdi@0.13.13`

### Changed

- Agent filesystem Skills are now the authoritative local copies and appear in
  Cloud as read-only projections. Cloud-owned workspace and personal Project
  Skills remain explicitly importable.
- The local MCP process now forwards complete tool definitions and results
  without rebuilding dynamic schemas.

### Fixed

- Bundled platform Skills and MCP resources no longer appear as user-managed
  inventory.
- Mixed-version Skill sync now pauses safely instead of overwriting or deleting
  Agent-owned files.

## Clawdi CLI v0.13.12

Package: `clawdi@0.13.12`

### Fixed

- Made Hosted runtime reconciliation recover live systemd drift without
  redundant restarts, reject stale generations, verify managed installer state,
  and keep rollback snapshots within root-controlled paths.
- Reduced deployment readiness latency while bounding retry load.

## Clawdi CLI v0.13.11

Package: `clawdi@0.13.11`

### Added

- Added the recommended native curl installer for macOS x64/arm64 and Linux
  x64/arm64 systems, including glibc and musl builds with bundled skills and
  egress resources.

### Changed

- CLI updates now follow the current installation owner: native installs use
  checksum-verified exact release assets, npm/Bun installs use exact npm
  versions, and Hosted remains a separate exact-version npm authority.

### Fixed

- Improved local update transaction fencing, daemon restart lifecycle,
  share-token handling, and immutable release recovery.

## Clawdi CLI v0.12.10-beta.57

Package: `clawdi@0.12.10-beta.57`

### Fixed

- Managed Telegram method and file requests now keep agent-link credentials out
  of Cloud request URLs while preserving standard Telegram Bot API client
  behavior.
- Managed runtime CA trust bundles are readable only by root and the runtime
  user's primary group, including after an existing bundle is replaced.

## Clawdi CLI v0.12.10-beta.55

Package: `clawdi@0.12.10-beta.55`

### Changed

- Hosted manifests no longer carry host-owned user, home, workspace,
  persistence, or runtime path fields. Hosted runtime paths derive HOME,
  installer home, persistent home, workspace, and process working directories
  from the `/home/clawdi` runtime contract, while local workspaces remain
  `$HOME/clawdi`.

## Clawdi CLI v0.12.10-beta.54

Published immutable package: `clawdi@0.12.10-beta.54`

### Fixed

- Fixed a hosted runtime reboot deadlock: persistently enabled runtime user
  units referenced a convergence-generated environment file that only exists
  after boot-time convergence, tripping the systemd start limit and blocking
  the official installer's restart. Units now declare the dependency with
  `ConditionPathExists`, convergence clears failed unit state, and the
  converged drop-in and environment file are written before the official
  installer runs, so deployments created by earlier CLI versions self-heal on
  their next restart without manual intervention.
- Hosted convergence no longer fails on hosts without a reachable systemd user
  bus when reloading the user manager before official service installs.
- Vault reads and writes now use a stable identity across operations.
- Runtime bridge assets are cached by content hash for reliable serving.

## Clawdi CLI v0.12.10-beta.53

Package: `clawdi@0.12.10-beta.53`

### Changed

- Added explicit unmanaged provider convergence for runtime-only OpenClaw and
  Hermes deployments, including exact empty-provider health and safe removal of
  only Clawdi-owned runtime projections.
- Decoupled the fixed Hosted Codex terminal tool from runtime provider choice.
  The CLI now maintains its single default config and process-scoped managed
  egress shim without leaking provider material into unmanaged runtime units.
  Hosted Codex is installed and verified at the audited exact
  `@openai/codex@0.142.4` version.
- Restricted managed provider egress credential replacement to requests carrying
  the exact Clawdi placeholder marker, so user bearer tokens and unauthenticated
  requests to the same host remain untouched.

## Clawdi CLI v0.12.10-beta.52

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.10-beta.52

Package: `clawdi@0.12.10-beta.52`

### Changed

- Finalized the immutable Agent v2 CLI bundle with a single applied-state
  authority and fail-closed hosted runtime convergence.

## Clawdi CLI v0.12.10-beta.51

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.10-beta.51

Package: `clawdi@0.12.10-beta.51`

### Changed

- Added the strict hosted locale contract for supported response languages and
  IANA timezones. The CLI now preserves user-authored agent identity files while
  maintaining a delimited locale instruction block, projects runtime-native
  timezone settings, and restarts only affected runtime services.
- Added immediate hosted runtime manifest convergence from environment-scoped
  SSE notifications while retaining 15-second ETag polling and five-minute
  self-healing when the notification channel is unavailable.
- Made the hosted manifest fail closed on unknown fields and require explicit
  `runtime`, `minimumCliVersion`, `controlPlane.cloudApiUrl`, and the canonical
  `environmentId` identity, without inference, `appId`, datasource, or
  deployment fallbacks.
- Restricted runtime bindings, provider transport fields, runtime paths, and
  OpenClaw Control UI origins to the canonical Hosted wire shape.
- Required explicit Hosted system user, home, workspace, persistent paths, and
  runtime home/workspace paths instead of deriving image-default locations.
- Required a non-empty unique Hosted runtime provider selection and a structured
  primary model constrained to that selection.
- Required the selected Hosted runtime to include exactly
  `install: {source: "official"}` while the CLI remains the sole owner of the
  official installer URL and argument vector.
- Required Hosted provider `kind` to be exactly `openai-compatible`, and
  rejected singular Hosted provider `model` and empty provider objects while
  accepting Cloud's healthy, `provider_not_found`, and
  `provider_secret_unavailable` projections with required non-empty error
  messages. Generic runtime desired state
  keeps its existing provider and installer behavior.
- Restricted remote Hosted CLI package selection to exact
  `clawdi@<semver>` without build metadata, using strict SemVer prerelease
  identifier rules and the Cloud 200-character limit. Managed bootstrap tgz paths are
  accepted only through strict Hosted test fixtures. Runtime desired state no
  longer resolves floating package tags.
- Standardized npm publication on `beta` for prereleases and `latest` for
  stable releases, with no package-level tag override. Hosted runtime updates
  consume the public exact version from the Cloud manifest and never resolve a
  dist-tag.

### Fixed

- Kept headless runtime convergence independent of a systemd user manager while
  still requiring the manager for official runtime service installation.
- Restored SSE subscriptions after authentication failure or terminal task
  completion while retaining polling as the bounded retry cadence.

## Clawdi CLI v0.12.10-beta.50

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.10-beta.50

Package: `clawdi@0.12.10-beta.50`

### Changed

- Made the Cloud hosted manifest the fail-closed authority for the ongoing
  managed CLI channel. Hosted manifests must explicitly provide
  the strict `clawdiCli` source, package spec, and official npm registry; they
  can no longer implicitly select `clawdi@latest` or inherit npm registry
  configuration.
- Made agent-v2 publishing repository-autonomous: build, test, pack, install,
  and SHA-verify one immutable tarball, then publish prereleases to the standard
  npm `beta` channel with trusted-publisher OIDC.

## Clawdi CLI v0.12.10-beta.49

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.10-beta.49

Package: `clawdi@0.12.10-beta.49`

### Changed

- Added managed self-update support for beta builds through the standard npm
  `beta` channel while Hosted rollout remains pinned to an exact CLI version.

## Clawdi CLI v0.12.10-beta.48

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.10-beta.48

Package: `clawdi@0.12.10-beta.48`

### Changed

- Made hosted policy and runtime datasource validation CLI-owned contracts, so
  runtime images no longer carry command policy, control-plane URLs, or CLI
  release-channel metadata.

## Clawdi CLI v0.12.10-beta.47

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.10-beta.47

Package: `clawdi@0.12.10-beta.47`

### Changed

- Made the CLI the owner of hosted egress module paths, numeric UID/GID
  permissions, and name-free privilege dropping. Runtime images no longer need
  a dedicated named egress account.

## Clawdi CLI v0.12.10-beta.46

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.10-beta.46

Package: `clawdi@0.12.10-beta.46`

### Fixed

- Isolated hosted runtime npm metadata lookups in the managed CLI cache so
  root bootstrap does not leave root-owned npm files in the runtime user's
  home directory.

## Clawdi CLI v0.12.10-beta.45

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.10-beta.45

Package: `clawdi@0.12.10-beta.45`

### Changed

- Finalized the hosted runtime desired-state contract for the unified egress
  sidecar.

## Clawdi CLI v0.12.10-beta.44

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.10-beta.44

Package: `clawdi@0.12.10-beta.44`

### Changed

- Renamed the hosted runtime MITM command and manifest surface to the runtime
  sidecar and egress contract.

## Clawdi CLI v0.12.10-beta.26

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.10-beta.26

Package: `clawdi@0.12.10-beta.26`

### Fixed

- Fixed CLI auto-update for beta builds so beta daemons follow the npm `beta`
  dist-tag instead of only checking `latest`.

## Clawdi CLI v0.12.10-beta.25

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.10-beta.25

Package: `clawdi@0.12.10-beta.25`

### Fixed

- Fixed Hermes skill sync so archived dot-directories such as `.archive` are
  ignored instead of being uploaded as invalid skill keys.

## Clawdi CLI v0.12.10-beta.0

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.10-beta.0

Package: `clawdi@0.12.10-beta.0`

### Changed

- Added a hosted runtime CLI prerelease for controlled validation. This release
  keeps the hosted runtime flow behind explicit runtime commands and hosted
  controller manifests, so existing `clawdi` CLI users and the Clawdi
  app/backend/web release line are not changed by default.
- Cleaned up the runtime manifest contract so the CLI accepts one controller
  response shape and one local desired-state shape, with stricter validation for
  runtime paths, secrets, egress profiles, and manifest expiry.

## Clawdi CLI v0.12.9

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.9

Package: `clawdi@0.12.9`

### Fixed

- Fixed `clawdi runtime apply` so WhatsApp Baileys credential directories are
  made private even when the directory already existed with wider permissions.

## Clawdi 2026-06-09

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-2026-06-09

### Security

- Tightened native channel provider endpoint and agent webhook URL validation.
  Clawdi now rejects private, loopback, unresolved, HTTP, and WS targets, and
  revalidates webhook targets before delivery to reduce DNS-rebinding risk.

### Fixed

- Fixed Telegram and BlueBubbles agent webhook delivery so `4xx` responses no
  longer acknowledge pending inbound messages as successful deliveries.
- Fixed Telegram agent webhook redelivery so non-webhook pending messages do
  not block later webhook-mode inbox rows.

## Clawdi CLI v0.12.8

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.8

Package: `clawdi@0.12.8`

### Fixed

- Fixed skill uploads from local directories with names that need cleanup, such
  as long names or names containing punctuation. `clawdi skill add`,
  `clawdi skill init`, and daemon sync now use the same skill key rules as
  Clawdi Cloud, so generated skill keys are accepted without manual renaming.

## Clawdi CLI v0.12.7

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.7

Package: `clawdi@0.12.7`

### Fixed

- Fixed `clawdi run` for Cloud-saved BYOK AI providers inside Clawdi agents.
  Commands launched through `clawdi run` now receive the saved provider key at
  runtime without writing plaintext keys to shell files or local config.

## Clawdi CLI v0.12.6

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.6

Package: `clawdi@0.12.6`

### Fixed

- Fixed AI Provider apply for BYOK Codex Responses providers so OpenClaw uses
  the same Codex Responses route as Clawdi-managed AI providers.
- Fixed `clawdi ai-provider test --live` for managed providers running inside a
  Clawdi agent. The command now uses the injected runtime environment key before
  falling back to backend credential resolution.

## Clawdi CLI v0.12.1

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.1

Package: `clawdi@0.12.1`

### Fixed

- Fixed Codex AI Provider apply so provider-bound Codex OAuth profiles write
  the selected default model even when they use Codex's built-in OpenAI
  provider configuration.

## Clawdi 2026-06-05

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-2026-06-05

### Fixed

- Fixed Codex AI Provider OAuth setup in development environments whose web
  dashboard runs on a configured HTTP origin other than loopback. Unconfigured
  hosts and ports are still rejected.

## Clawdi CLI v0.12.0

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.12.0

Package: `clawdi@0.12.0`

### Added

- Added source-to-target AI Provider apply flows. `clawdi ai-provider apply
  openai-codex` now materializes one Codex OAuth source into every matching
  local target by default: Codex, Hermes, and OpenClaw.
- Added target-native Codex OAuth writes for Hermes and OpenClaw, including
  Hermes credential-pool state and OpenClaw auth profiles.

### Changed

- Replaced the previous `--engine` selector with `--target`; use
  `--target codex|hermes|openclaw|all` when you need to apply a source to a
  specific runtime.
- Codex OAuth application now uses the upstream target contracts instead of
  env-style API-key projection for subscription OAuth.

### Fixed

- Fixed OpenClaw Codex OAuth profiles to use OpenClaw's canonical
  `openai:<profile>` auth profile IDs and `auth.order.openai` configuration.
- Tightened AI Provider apply/export/test output redaction so OAuth tokens and
  env-backed secrets stay out of generated non-secret config and command
  output.

## Clawdi CLI v0.11.0

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.11.0

Package: `clawdi@0.11.0`

### Changed

- `clawdi daemon` now installs one singleton launchd/systemd unit that syncs
  every registered local agent. User-facing per-agent daemon install, restart,
  uninstall, logs, and `--all` controls were removed; use
  `clawdi daemon status --agent <type>` when you need a focused status view.
- Existing per-agent daemon units are migrated automatically. Re-running
  `clawdi setup` or `clawdi daemon install` installs the singleton and removes
  old per-agent supervisor units.

### Added

- Added `clawdi daemon ping` and `clawdi daemon rotate-token` for local daemon
  control checks and token rotation.
- Added headless daemon RPC methods for sync, vault, auth, update, and
  long-running operation status/log inspection.
- Added HTTP JSON-RPC host/port binding for daemon control. It listens on
  `127.0.0.1:17654` by default and supports custom host/port configuration.

### Security

- Daemon control RPC now requires bearer-token auth on every request. The
  generated token is stored owner-only, can be rotated with
  `clawdi daemon rotate-token`, and is checked with timing-safe comparison.
- HTTP RPC listeners bind to loopback by default. Non-loopback binds require
  explicit `--allow-remote` opt-in and should only be used behind SSH
  tunneling, private networking, or TLS termination.
- Vault plaintext RPC calls require explicit confirmation; plaintext rendering
  cannot be sent to background operation logs.

## Clawdi CLI v0.10.1

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.10.1

Package: `clawdi@0.10.1`

### Fixed

- Fixed `clawdi update` choosing Bun just because `bun` was on `PATH`. The
  updater now prefers the package manager that owns the currently running
  `clawdi` binary, so npm-installed CLIs update with npm and Bun-installed CLIs
  update with Bun.
- Reduced live-sync daemon noise during transient Cloud SSE reconnects and
  heartbeat timeouts. Short reconnect bursts are now classified as transient;
  only sustained failures are written to `last_sync_error` or logged as warning
  signals.
- Fixed AI Provider OpenClaw import round-trips, stale runtime env display after
  auth edits, and local no-auth endpoint validation parity between CLI and
  backend.
- Clarified that Codex provider auth should use `clawdi ai-provider
  import-auth/connect/materialize-auth`; lower-level `agent credentials` commands
  remain a compatibility backup/restore surface.

## Clawdi 2026-06-03-2

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-2026-06-03-2

### Fixed

- Fixed session sync failures when an agent runtime reported structured provider
  configuration or very long strings in the `model` field. Clawdi now extracts a
  usable model id when possible and caps stored model labels to the database
  limit instead of returning a 500.

### Security

- Hardened backend database error logging so SQL bound parameter values are not
  written to logs when an unexpected database exception occurs.

## Clawdi CLI v0.10.0

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.10.0

Package: `clawdi@0.10.0`

### Added

- Added account-global AI Provider management with `clawdi ai-provider`, so
  users can define OpenAI, Anthropic, OpenRouter, Gemini, Mistral, and
  OpenAI-compatible endpoints once and reuse them across agents.
- Added `clawdi ai-provider apply --engine codex|hermes|openclaw` to generate
  native agent configuration from the Provider Catalog. Codex uses a dedicated
  profile file, Hermes receives a structured `config.yaml` merge, and OpenClaw
  uses its native config patch command.
- Added Codex OAuth connection and provider-bound credential profile import /
  materialization, including loopback callback handling with manual paste
  fallback.
- Added encrypted Provider Catalog export/import for env-backed secrets. Plain
  API keys are never included in default exports.

### Security

- BYOK model requests remain direct from the runtime to the selected provider;
  Clawdi stores metadata and secret references but does not proxy model traffic.
- AI Provider catalog, generated agent config, exported secret env files, and
  materialized credential files are written with owner-only permissions.

## Clawdi 2026-06-03

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-2026-06-03

### Added

- Added backend AI Provider APIs for account-global provider metadata, managed
  provider API keys, Codex OAuth start/complete, and CLI-only credential
  resolution.

## Clawdi CLI v0.9.0

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.9.0

Package: `clawdi@0.9.0`

### Added

- Added `clawdi vault attach` and `clawdi vault detach` / `unlink` so users can
  add or remove one Project's access to an existing Vault without copying or
  deleting the underlying keys.

### Changed

- Deleting a key from a Vault attached to multiple Projects now requires
  explicit global confirmation. The CLI refuses `clawdi vault rm` unless
  `--global` is passed, and the API requires `global_delete=true`. Scripts
  that intentionally delete keys from shared Vaults must add the new explicit
  confirmation.
- `clawdi vault rm` now fails clearly in non-interactive shells when `--yes` is
  missing instead of waiting on a prompt that cannot be answered.

### Security

- Memory creation now rejects likely plaintext API keys, bearer tokens, and
  similar secrets in the CLI, MCP server, dashboard, and backend, and points
  users to Vault references instead. Automations that stored plaintext secrets
  in memory should store the secret in Vault and save only a `clawdi://`
  reference in memory.

## Clawdi CLI v0.8.6

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.8.6

Package: `clawdi@0.8.6`

### Fixed

- Fixed the npm package metadata for `clawdi@0.8.5`, which accidentally used
  Bun workspace catalog syntax for the `zod` runtime dependency and caused
  plain `npm install clawdi@0.8.5` installs to fail.

## Clawdi CLI v0.8.5

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.8.5

Package: `clawdi@0.8.5`

### Fixed

- `clawdi mcp` now exposes Composio connector tools through the Composio MCP
  bridge with original tool names and typed input schemas, so downstream agents
  such as Hermes and OpenClaw can discover and call connector tools correctly.

## Clawdi 2026-05-24

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-2026-05-24

### Fixed

- Connector MCP traffic now routes through a backend Composio bridge instead of
  the old reduced proxy path, preserving Composio tool metadata while keeping
  connector credentials server-side.

## Clawdi CLI v0.8.4

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.8.4

Package: `clawdi@0.8.4`

### Fixed

- Improved Vault resolve errors when a CLI talks to a backend that has not yet
  enabled shared Project Vault runtime reads for Viewers.

## Clawdi CLI v0.8.3

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.8.3

Package: `clawdi@0.8.3`

### Fixed

- Agent MCP setup now converges on the local `clawdi mcp` stdio server for
  Hermes and OpenClaw. Hermes setup removes stale `clawdi-mcp` HTTP entries and
  mixed HTTP/stdio blocks that could create duplicate or confusing Clawdi tool
  namespaces; OpenClaw setup now writes the matching `clawdi` MCP server through
  `openclaw mcp set`.

## Clawdi CLI v0.8.2

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.8.2

Package: `clawdi@0.8.2`

### Added

- Added non-interactive vault writes with `clawdi vault set --value <value>`
  and `clawdi vault set --stdin`.
- Added `--vault`, `--section`, and `--project` targeting to
  `clawdi vault import`, so `.env` imports can populate sectioned vault paths.
- Added `clawdi vault rm` / `clawdi vault delete` for scripted cleanup.
- Added `clawdi project list --include-envs` to show auto-created machine
  Projects when needed.

### Changed

- Vault write commands now print the concrete target vault, section, and Project
  before writing, then print exact `clawdi://project/...` references after
  writes.
- `clawdi project list` now hides auto-created machine Projects by default and
  reports how many were hidden.
- The bundled `clawdi` skill now points agents at the new vault CLI workflow
  for scripted secret migration and cleanup.

### Fixed

- `clawdi vault import` now warns about skipped invalid dotenv identifiers
  instead of reporting only that no keys were found.

## Clawdi CLI v0.8.1

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.8.1

Package: `clawdi@0.8.1`

### Changed

- Updated CLI vault commands for account-owned Vaults that can be attached to
  multiple Projects. JSON output now includes `project_ids`, while exact
  references continue to include the Project ID used for resolution.
- `clawdi project show`, `clawdi skill list`, `clawdi pull`, and
  `clawdi vault list` now page through cloud results instead of showing only
  the first page.
- Share-link preview copy now says Vault metadata unlocks after sign-in while
  keeping plaintext out of web preview flows.

## Clawdi 2026.05.21.2

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-v2026.05.21.2

### Added

- Added dashboard Projects and Project detail surfaces for viewing resources,
  metadata, sharing state, and Agent attachments.
- Added dashboard Project sharing flows, including share links, direct invites,
  member management, public share acceptance, and notifications.
- Added Vault import and Project attachment controls in the dashboard, including
  Vault metadata views for shared Project viewers.

### Changed

- Clarified the Project model across the dashboard: user-created Projects can be
  shared, the Global Project is the account default, and Agent Projects are
  managed per connected agent.
- Vaults are now account-owned resources that can be attached to multiple
  Projects. Existing `project_id` API consumers and legacy exact
  `clawdi://project/.../vault/...` references remain compatible.

### Security

- Shared Project recipients remain Viewers without write access. Vault
  plaintext stays hidden in web flows; CLI/API-key runtime reads can use shared
  Vault values, while bound Agent keys use shared values through explicit Agent
  Project attachments.

## Clawdi CLI v0.8.0

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.8.0

Package: `clawdi@0.8.0`

### Added

- Added `clawdi daemon` as the primary command for managing background sync.
  The old `clawdi serve` command remains available as a legacy alias.
- Added default daemon installation during `clawdi setup`, so every registered
  local agent gets live sync unless setup is run with `--no-daemon`.
- Added background auto-update for installed daemons. Daemons check for newer
  CLI releases, install them silently, and let launchd/systemd restart onto the
  new version.

### Changed

- CLI and daemon auto-update now install the latest available release, including
  major versions.
- `clawdi update` installs by default; use `--check` to report only.

### Fixed

- Reduced daemon idle and burst overhead by coalescing retry-queue persistence,
  waking the queue only when work arrives, and debouncing skill watcher events.
- Closed background auto-update log descriptors in the parent CLI process.

## Clawdi 2026.05.20.1

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-v2026.05.20.1

### Added

- Added first-class `clawdi://` secret references for project-scoped vault
  secrets.
- Added dry-run secret previews that show where a secret resolves from without
  printing plaintext.
- Added support for syncing local CLI credential profiles for Codex, Claude
  Code, and GitHub CLI.

### Changed

- Improved vault conflict and provenance handling for multi-project and agent
  workflows.
- Kept local CLI credential profiles separate from runtime vault secrets.

### Security

- Shared Project viewers can use shared runtime vault values, but cannot store or
  materialize another user's local CLI credential profiles.
- Vault storage remains server-managed encryption, not zero-knowledge.

## Clawdi CLI v0.7.0

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/clawdi-cli-v0.7.0

Package: `clawdi@0.7.0`

### Added

- Added `clawdi://` secret reference workflows across `read`, `inject`, and
  `run --env-file`.
- Added exact Project-scoped references such as
  `clawdi://project/<project>/vault/<vault>/field/<field>`.
- Added bulk reference resolution for templates and env files.
- Added local credential profile sync for Codex, Claude Code, and GitHub CLI.
- Added dry-run previews that show provenance without requesting plaintext.

### Changed

- `clawdi inject` writes generated secret files owner-only.
- `clawdi run --env-file` can resolve explicit references without broad
  all-vault env injection.

### Security

- Secret reference previews do not print secret values.
- Local CLI credential profiles are restored only for the authenticated user
  who stored them.
