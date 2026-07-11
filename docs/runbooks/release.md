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
   For the managed `agent-v2` channel, the release workflow must build and pack
   one immutable artifact, pass it through the reusable Hosted paired smoke,
   and publish that exact tarball once to `agent-v2` with npm trusted-publisher
   OIDC. There is no candidate tag or dist-tag promotion step.
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
   npm view clawdi version
   npm view clawdi dist-tags
   ```

   Done: `agent-v2` points directly to the paired-smoke-approved exact version
   while `beta` and `latest` are unchanged. Before merge/release, the focused
   smoke-only Hosted reusable-workflow PR must be on Hosted `main`, and the
   private Hosted repository Actions access must be set to `organization`; its
   current `none` setting prevents the reusable workflow call. Hosted #780 is
   not this prerequisite because its runtime behavior must deploy after Cloud
   #387 owns the hosted manifest channel. Do not work around this with
   long-lived credentials or duplicated private smoke code.

   Safe rollout order: smoke-only Hosted workflow PR -> organization Actions
   access -> merge this CLI PR and publish `.50` -> controlled short
   maintenance window. During that window, pause agent-v2 creation and all
   Hosted runtime-state writers/reconciliation, deploy Cloud #387, immediately
   deploy Hosted #780, then force or reconcile affected prelaunch pods so they
   receive the final bootstrap environment. Verify runtime-state writes,
   hosted manifest fetch, and runtime services before resuming creation and
   writers. Brief runtime unavailability is possible and expected: pre-#780
   pods do not have `CLAWDI_RUNTIME_AUTH_ENV`, so pods that self-update to `.50`
   after Cloud #387 starts serving `agent-v2` can fail closed. This is not a
   rolling cross-service deployment. Cloud #387 removes or rejects admin
   `clawdi_cli` while pre-#780 Hosted still sends it; do not add a temporary
   accepted-but-ignored compatibility field.

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
