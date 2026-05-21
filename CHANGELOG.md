# Changelog

This changelog tracks notable user-facing Clawdi releases. It is written for
people using or upgrading Clawdi, so it intentionally omits internal deployment,
database migration, CI, and implementation details.

- Clawdi app/backend/web releases use `clawdi-YYYY-MM-DD` for the first UTC
  release of a day, then `clawdi-YYYY-MM-DD-2`, `-3`, and so on for
  additional releases that same day. Older releases may use the previous dotted
  `clawdi-v...` CalVer tag format.
- CLI/npm releases use `clawdi-cli-vX.Y.Z`.

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
