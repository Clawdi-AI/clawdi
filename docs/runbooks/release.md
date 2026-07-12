# Release Runbook

Use this runbook when a PR is ready to merge or when an operator needs to
create a Clawdi release from an already-deployed commit.

## Release Lines

- App/backend/web/shared/root-config changes use calendar GitHub releases:
  `clawdi-YYYY-MM-DD` for the first UTC release of a day, then
  `clawdi-YYYY-MM-DD-2`, `-3`, and so on for additional releases that same
  day.
- CLI/npm changes use semver GitHub releases and npm package versions:
  `clawdi-cli-vX.Y.Z` and `clawdi@X.Y.Z`.
- GitHub generated notes seed the release body. Keep PR labels accurate; use
  `skip-changelog` for implementation-only PRs, then review and edit the body
  before treating it as final release copy.

For app/backend/web releases, the date is UTC. A numeric suffix is a same-day
release sequence, not a semantic-version patch number. The manual
`Release Clawdi` workflow computes the next sequence by looking at existing
`clawdi-YYYY-MM-DD*` tags: first release is unsuffixed, second is `-2`, third
is `-3`. Older dotted `clawdi-v...` CalVer tags are considered only during the
transition so the same UTC day does not restart at `-1`.

Reserve `vX.Y.Z` tag shapes for semver release lines. The dated app release
line intentionally avoids both the `v` prefix and dotted date suffixes so users
do not read it as a package version.

GitHub release bodies are the published release notes. `CHANGELOG.md` is the
curated user-facing history in the repository. Keep them aligned for notable
releases.

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
   bun run test  # Docker-backed clean runner
   ```

   `bun run test` builds or reuses the local Docker test image and runs against
   an isolated container workspace. Host-local package tests are available as
   `bun run test:local` for development loops, but the clean Docker runner is
   the release gate.

4. Run backend verification:

   ```bash
   cd backend
   uv run ruff check app tests
   cd ..
   scripts/test.sh backend
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
   For the managed agent-v2 release line, this repository's release workflow must
   build, typecheck, run the full CLI suite, and pack one immutable tarball. It
   installs that tarball, records and verifies its SHA-256, transfers the same
   artifact to the protected npm job, verifies it again, and publishes it once
   to `agent-v2-candidate` with npm trusted-publisher OIDC. The build job may use
   the configured fast runner; the protected publish job must use GitHub-hosted
   `ubuntu-latest`, because npm trusted publishing does not support self-hosted
   or third-party GitHub Actions runners. The CLI workflow does not call
   workflows in the Hosted repository or depend on Hosted repository settings.
7. Decide whether `CHANGELOG.md` needs a curated entry. Add one for notable
   user-facing releases, especially when GitHub generated notes would be too
   noisy or too terse.
8. Update the PR body with the latest head SHA, verification, release impact,
   migration notes, and whether the CLI publish workflow will run.

## Merge And Release

1. Merge the PR into `main` after required checks are green.
2. Watch Actions for these workflows:
   - `.github/workflows/clawdi-release.yml` is manual-only. Run `Release Clawdi`
     only after the deployed commit should get public app/backend/web release
     notes.
   - `.github/workflows/cli-publish.yml` runs for `packages/cli/**` and the
     CLI publish workflow file, then publishes only when the local CLI version
     differs from npm.
3. For CLI releases, verify npm after the workflow succeeds:

   ```bash
   CLI_VERSION='<exact-version>'
   test "$(npm view "clawdi@$CLI_VERSION" version)" = "$CLI_VERSION"
   npm view clawdi dist-tags
   ```

   Done: the exact version exists from the verified CLI artifact while `beta`
   and `latest` are unchanged. The Hosted image repository has a separate
   release boundary. An operator supplies the exact `clawdi@<semver>` package
   spec to the Hosted image workflow. That workflow fails when the exact spec is
   missing, verifies registry integrity, signatures, and provenance, and never
   resolves `agent-v2-candidate` or any other npm dist-tag. It runs the image/CLI
   pairing smoke before publishing the image and does not call back into this
   workflow. The candidate tag is workflow-internal diagnostic metadata, not an
   operator gate.

   Hosted rollout uses that same exact package spec in the Cloud manifest. The
   runtime never resolves an npm dist-tag.

   Agent deployment v2 is not live. Keep creation and runtime-state
   reconciliation disabled until the Hosted image contract, CLI version
   `0.12.10-beta.51`, and the Cloud manifest contract are all deployed. Validate
   one fresh deployment end to end through `/v1/runtime/manifest` and SSE before
   enabling v2. Do not add compatibility fields, aliases, or fallback package
   channels.

4. For app/backend/web releases, run `Release Clawdi` manually with the
   deployed commit SHA, then verify the GitHub release exists and has
   user-facing notes. Manual versions must use `YYYY-MM-DD` or `YYYY-MM-DD-N`;
   the workflow adds the `clawdi-` prefix. If a manually provided tag already
   exists, the workflow skips release creation. If the version is omitted, the
   workflow chooses the next same-day sequence when a tag for the current UTC
   date already exists.
5. Review generated GitHub release notes for both release lines. Edit the
   release body when PR titles are too implementation-focused, a PR touched
   both release lines, generated notes include unrelated entries, or the notes
   omit user impact.

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

### Connector Post-Deploy Smoke

After a connector change, run a smoke test against the deployed public backend
for that environment with a user-level auth token. Keep environment-specific
hosts, process names, ports, and secrets in private deployment runbooks.

The smoke should verify:

- an API-key connector returns an API-key-style `auth_type`, exposes
  credential fields, and refuses the redirect `/connect` route with a
  credentials-required error;
- an OAuth connector returns an OAuth-style `auth_type` and creates a Connect
  Link;
- a no-auth connector reports a no-auth/ready auth type;
- MCP connector config returns the current bridge endpoint and `tools/list`
  succeeds for an authenticated user.

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
