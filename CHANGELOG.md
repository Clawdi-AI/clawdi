# Changelog

This changelog tracks user-facing Clawdi releases. GitHub Releases remain the
canonical release artifacts:

- Cloud/backend/web releases use `cloud-vYYYY.MM.DD.<run_number>`.
- CLI/npm releases use `clawdi-cli-vX.Y.Z`.

## Clawdi Cloud 2026.05.20.1

Release: https://github.com/Clawdi-AI/clawdi/releases/tag/cloud-v2026.05.20.1

### Added

- Added backend support for bulk exact `clawdi://` reference resolution.
- Added `vault_credential_profiles` storage for personal local CLI credential sync.
- Added plaintext-free preview resolution for vault references.
- Added generated OpenAPI client updates for the new vault APIs.

### Changed

- Hardened shared Project and env-bound Agent credential boundaries.
- Separated runtime vault secrets from local CLI credential profile backup/restore.

### Migration

- Applied Alembic migration `e4f8a91c2d3b`.
- The migration creates `vault_credential_profiles` and indexes only; it does not
  rewrite existing vault data.

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

### Operational Notes

- `clawdi@0.7.0` expects hosted backend support for vault bulk resolve and
  credential profile endpoints.
- Vault storage remains server-managed encryption, not zero-knowledge.
