# Changelog

This changelog tracks notable user-facing Clawdi releases. It is written for
people using or upgrading Clawdi, so it intentionally omits internal deployment,
database migration, CI, and implementation details.

- Clawdi app/backend/web releases use `clawdi-YYYY-MM-DD` for the first UTC
  release of a day, then `clawdi-YYYY-MM-DD-2`, `-3`, and so on for
  additional releases that same day. Older releases may use the previous dotted
  `clawdi-v...` CalVer tag format.
- CLI/npm releases use `clawdi-cli-vX.Y.Z`.

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
