# Release Runbook

Use this runbook when a PR is ready to merge or when an operator needs to
create a Clawdi release from an already-deployed commit.

## Release Lines

- App/backend/web/shared changes use calendar GitHub releases:
  `clawdi-vYYYY.MM.DD.<run_number>`.
- CLI/npm changes use semver GitHub releases and npm package versions:
  `clawdi-cli-vX.Y.Z` and `clawdi@X.Y.Z`.
- User-facing release notes come from GitHub generated notes. Keep PR labels
  accurate; use `skip-changelog` for implementation-only PRs.

## Pre-Merge Checklist

1. Rebase the PR onto `origin/main`.
2. Confirm generated clients are current when backend schemas changed:

   ```bash
   cd backend
   uv run python scripts/check_generated_api.py
   ```

3. Run verification from the repo root:

   ```bash
   bun run check
   bun run typecheck
   bun run test
   ```

4. Run backend verification:

   ```bash
   cd backend
   uv run ruff check app tests
   uv run pytest -q
   ```

5. Review Alembic migrations when the PR changes database schema:

   ```bash
   cd backend
   uv run alembic heads
   uv run alembic upgrade head
   ```

6. If the PR touches the CLI package and should publish, bump
   `packages/cli/package.json` using semver. If no npm publish is intended,
   leave the version unchanged.
7. Update the PR body with the latest head SHA, verification, release impact,
   migration notes, and whether the CLI publish workflow will run.

## Merge And Release

1. Merge the PR into `main` after required checks are green.
2. Watch Actions for these workflows:
   - `.github/workflows/clawdi-release.yml` runs for app/backend/web/shared
     paths and creates `clawdi-v...`.
   - `.github/workflows/cli-publish.yml` runs for `packages/cli/**` paths and
     publishes only when the local CLI version differs from npm.
3. For CLI releases, verify npm after the workflow succeeds:

   ```bash
   npm view clawdi version
   npm view clawdi dist-tags
   ```

4. For app/backend/web releases, verify the GitHub release exists and has
   user-facing notes. If production deploy happened out of band, run
   `Release Clawdi` manually with the deployed commit SHA.

## Production Deployment Checks

The deployment platform is outside this repository, but every deploy should
run these checks before traffic is considered healthy:

1. Apply migrations before starting code that depends on them:

   ```bash
   cd backend
   uv run alembic upgrade head
   ```

2. Confirm required extensions and services are available:
   - PostgreSQL has `pgvector` and `pg_trgm`.
   - File store credentials point at the intended bucket/prefix.
   - `VAULT_ENCRYPTION_KEY` and `ENCRYPTION_KEY` are both set and distinct.
   - Clerk JWT configuration is present for web auth.
3. Smoke test:
   - Web dashboard loads after sign-in.
   - Backend health/API requests return 2xx.
   - CLI can authenticate and run `clawdi vault list --json`.
   - A Vault key resolves only through CLI/API-key auth, never through web auth.
4. Check logs for migration errors, 5xx spikes, auth failures, and frontend
   build/runtime errors.

## Rollback

1. Prefer rolling back app/backend/web code to the previous deployment before
   rolling back database migrations.
2. Only downgrade migrations after checking the specific migration's downgrade
   keeps data needed by the previous code version.
3. Do not roll back an npm version. Publish a new patch version instead.
4. If a release has bad notes but the code is fine, edit the GitHub release
   body; do not create a replacement tag.

## Current Project-Sharing Migration Notes

The project-sharing Vault migration changes Vault ownership from
Project-scoped to account-scoped and stores Project access in
`vault_project_attachments`. It also preserves legacy Project-scoped Vault
slug aliases so older `clawdi://project/.../vault/<slug>/...` references keep
resolving after duplicate account-level slugs are suffixed.
