# Changelog

This changelog tracks notable user-facing Clawdi releases. It is written for
people using or upgrading Clawdi, so it intentionally omits internal deployment,
database migration, CI, and implementation details.

- Clawdi app/backend/web releases use `clawdi-vYYYY.MM.DD.<run_number>`.
- CLI/npm releases use `clawdi-cli-vX.Y.Z`.

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
