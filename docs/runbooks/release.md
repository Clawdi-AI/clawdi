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
   build, typecheck, run the full CLI suite, pack one immutable npm tarball, and
   build the native matrix once. It installs the npm tarball and exercises the
   compiled Linux artifact through the native installer/daemon lifecycle. The
   exact-version release manifest is the sole checksum contract for native
   archives. The workflow transfers the same artifacts to the protected npm
   job, verifies them again, and publishes the npm package once
   to `beta` for a prerelease or `latest` for a stable version with
   trusted-publisher OIDC. Package-level tag overrides are rejected. The build
   job may use the configured fast runner; the protected publish job must use
   GitHub-hosted `ubuntu-latest`, because npm trusted publishing does not support
   self-hosted or third-party GitHub Actions runners. The CLI workflow does not
   call workflows in the Hosted repository or depend on Hosted repository
   settings. A rerun after npm succeeds but GitHub Release creation fails
   checks out the source commit recorded by npm provenance, rebuilds the same
   artifact, verifies its npm `dist.integrity`, skips republishing the immutable
   npm version, and completes the draft release before finalization. Recovery
   decisions come from `packages/cli/scripts/release-recovery.mjs`; the workflow
   only gathers external facts and executes the validated action.
   Native ownership is separate: installed native executables update only from
   the exact `clawdi-cli-v<version>` manifest and assets. npm/Bun installs use
   exact npm versions. Hosted remains a separate exact-version npm authority and
   never invokes native self-update. Bun's macOS artifacts are linker ad-hoc
   signed; this release line does not claim Developer ID signing, notarization,
   or browser-download Gatekeeper behavior.
7. Decide whether `CHANGELOG.md` needs a curated entry. Add one for notable
   user-facing releases, especially when GitHub generated notes would be too
   noisy or too terse.
8. Update the PR body with the latest head SHA, verification, release impact,
   migration notes, and whether the CLI publish workflow will run.

## Merge And Release

1. Merge the PR into `main` after required checks are green.
2. Watch Actions for these workflows:
   - `Backend CI` is the sole automatic backend-image change gate. Its
     `push.main.paths` filter includes every backend image/release input, and
     main concurrency may cancel an older run in favor of the newest cumulative
     commit. A push outside that path filter does not start a backend image
     release. Because a `workflow_run` workflow can access secrets and write
     tokens even when its predecessor could not, the privileged image workflow
     accepts only a successful `push` run for `main` whose
     `head_repository.full_name` is this repository. This follows GitHub's
     official [`workflow_run` privilege and untrusted-code
     warning](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows.md#workflow_run).
   - `Clawdi Image Release` uses one workflow-level production concurrency
     group with `cancel-in-progress: false` and `queue: max`. GitHub permits one
     running release plus up to 100 pending runs in that group instead of
     replacing an older pending run. Waiting runs are processed by the time each
     run starts waiting, but workflow dispatch order is not guaranteed; do not
     infer dispatch ordering or stale-rollback impossibility from the queue
     alone. After the automatic queue drains, confirm the deployed version is
     the newest successful `Backend CI` head SHA. If it is not, wait for the
     group to become idle and dispatch that newest exact ref.
   - A release that starts checks out, builds, tags, and deploys its exact
     `workflow_run.head_sha`. It must not narrow that trusted signal with a
     single-commit diff because a canceled predecessor's backend changes are
     already ancestors of the successful cumulative SHA. The exact SHA is both
     the commit-addressed OCI image tag and the Kamal deployment version; GHCR
     tags remain mutable and are not a registry immutability guarantee.
   - Manual dispatch always builds its resolved ref through the same production
     concurrency group. An older ref is an explicit rollback and can defeat the
     intended automatic release history if it waits behind automatic runs.
     Do not dispatch an older ref while an automatic release is running or
     pending. Confirm the `Clawdi Image Release` group is idle first. There is no
     separate deploy-job concurrency gate; the workflow-level gate covers build
     and deploy together. These rules follow the current official GitHub
     [`workflow_run` conclusion/data
     contract](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#running-a-workflow-based-on-the-conclusion-of-another-workflow)
     and [`queue: max` workflow concurrency
     contract](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency.md).
   - `.github/workflows/clawdi-release.yml` is manual-only. Run `Release Clawdi`
     only after the deployed commit should get public app/backend/web release
     notes.
   - `.github/workflows/cli-publish.yml` runs for `packages/cli/**` and the
     CLI publish workflow file. It publishes when the exact npm version is
     absent, or rebuilds and verifies that version to complete an unfinished
     GitHub Release.

   Done: `bun test packages/cli/tests/clawdi-image-release-workflow.test.ts`
   exits 0 and the backend image release workflow contract passes.

### Discord reserved-command cutover

The pair-code endpoint owns the safe cutover. Before it can return instructions
that mention `/clawdi_pair`, it checks a persisted reserved-command version and
reconciles only the reserved command namespace in the global scope. It lists
the existing commands, upserts and validates both `clawdi_pair` and
`clawdi_unpair`, and only then deletes the exact legacy `bot_pair` and
`bot_unpair` chat-input command IDs. This ordering avoids a destructive partial
provider update if either new-command upsert fails; it does not make the legacy
names accepted input aliases. A DELETE 404 for an exact ID from the preceding
list is an idempotent success because another reconciliation has already
removed it. Unrelated global commands are never deleted or resubmitted.
For an existing account with a configured legacy `guild_id`, the same request
performs the reserved-only reconciliation in that known guild scope while
preserving unrelated guild commands. If Discord rejects, rate-limits, or cannot
complete any other required list, upsert, or deletion, the endpoint returns an
error without creating a pair code or advancing the reserved-command version.
This prevents the pairing UI from getting ahead of the registered commands
during rollout.

No operator sync is required before users can pair. To reconcile accounts
proactively after deploying the matching backend, an operator may run the
default command sync below. Do not run it before the backend is deployed.

```bash
CHANNEL_API_URL='https://api.example.test'
CHANNEL_ACCOUNT_ID='<discord-channel-account-id>'
curl -sS -X POST \
  "$CHANNEL_API_URL/v1/admin/channels/$CHANNEL_ACCOUNT_ID/commands/sync" \
  -H "X-Admin-Key: $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{}' \
  | jq -e '.commands | map(.name) | sort == ["clawdi_pair", "clawdi_unpair"]'
```

Done: the command exits 0 for each account and the response contains exactly
the two upserted `clawdi_*` command names. This response is not the complete
Discord command set; unrelated commands in the reconciled scope remain intact.

Discord scopes are independent. If an operator previously used an explicit
`guild_id` that is not the account's configured guild, that scope is not
discoverable from account state and should be reconciled separately with
`{"guild_id":"<discord-guild-id>"}` during the controlled cleanup.

3. For CLI releases, verify npm after the workflow succeeds:

   ```bash
   CLI_VERSION='<exact-version>'
   test "$(npm view "clawdi@$CLI_VERSION" version)" = "$CLI_VERSION"
   npm view clawdi dist-tags
   ```

   Done: the exact version exists from the verified CLI artifact and the
   version-derived standard channel points to it: `beta` for a prerelease or
   `latest` for a stable release. The Hosted image repository has a separate
   release boundary. An operator supplies the exact `clawdi@<semver>` package
   spec to the Hosted image workflow, which fails when the exact spec is
   missing. For `clawdi@0.12.10-beta.57`, first run
   `hosted-runtime-image-release.yml` with `validate_only=true`,
   `runtime_image` set to the current digest-pinned image, and
   `cli_package_spec=clawdi@0.12.10-beta.57`. It verifies registry integrity,
   signatures, provenance, and the image/CLI pairing without ever resolving an
   npm dist-tag or publishing an image. Reuse the validated digest. Build a new
   image only if validate-only fails for a demonstrated image compatibility
   reason. The Hosted HOME and manifest refactor changes no Dockerfile-copied
   runtime-image input, so it does not by itself justify image churn. The
   workflow does not call back into this workflow. The `beta` tag is publication
   metadata, not an operator gate.

   Hosted rollout uses that same exact package spec in the Cloud manifest. The
   runtime never resolves an npm dist-tag.

   Hosted Codex is a CLI-owned tool-plane dependency pinned by the immutable
   Clawdi CLI release. For `0.12.10-beta.57`, verify the audited exact package
   and executable before activating Hosted:

   ```bash
   test "$(npm view @openai/codex@0.146.0 version)" = "0.146.0"
   npx --yes @openai/codex@0.146.0 --version | grep -F '0.146.0'
   ```

   A Hosted Codex version change therefore requires a new exact Clawdi CLI
   release and the same registry/pairing smoke gate; it is not an image,
   manifest, environment override, or npm dist-tag setting.

   Managed provider egress rewrites require the public
   `Bearer clawdi-egress-placeholder` authorization value as an explicit intent
   marker. Requests with a user token or no authorization header are not
   rewritten, which prevents accidental BYOK or unmanaged credential
   replacement. This is not process or security isolation: any pod process that
   deliberately sends the public marker can opt in, and resulting usage is
   charged to that deployment user's wallet.

   Agent deployment v2 is not live. Keep creation and runtime-state
   reconciliation disabled until the Hosted image contract, CLI version
   `0.12.10-beta.57`, and the Cloud manifest contract are all deployed. Hosted
   promotion must set `agent_v2_cli_package_spec` to the exact `.57` package
   while retaining the validated existing `agent_v2_runtime_image` digest; if
   that database setting is absent, write the already-validated existing
   digest. Keep `clawdi_v2_enabled=false` and preserve existing environment
   overrides. Validate
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

Managed physical WhatsApp accounts use exact-SHA Kamal accessories and an
explicit serial reconcile after the app deploy. Configure, scan, rotate, back
up, restore, or roll them back only through
[`whatsapp-baileys-sidecars.md`](whatsapp-baileys-sidecars.md). Kamal does not
update accessories as part of `kamal deploy`; the workflow's accessory reboot
and authenticated readiness loop are required release steps.

### Production values

[`config/deploy.yml`](../../config/deploy.yml) keeps the Kamal structure public
while production values stay outside the repository. CI injects them from
GitHub Actions secrets; operators keep Kamal secrets in the gitignored
`.kamal/secrets` file and export deployment parameters before running Kamal.
Self-hosters set `DEPLOY_HOST` to their own server.

The deployment workflow installs and verifies exactly Kamal `2.12.0`; the
configuration keeps `minimum_version: 2.12.0` as an independent floor. The
workflow-level GitHub concurrency queue is the scheduler layer. Kamal's
automatic remote deploy lock remains the fail-fast second layer, so deployment
commands must not add `--lock-wait`. These choices follow the audited Kamal
v2.12.0 [non-proxied health and primary-role
barrier](https://github.com/basecamp/kamal/blob/v2.12.0/lib/kamal/cli/app/boot.rb),
[Docker health polling](https://github.com/basecamp/kamal/blob/v2.12.0/lib/kamal/cli/healthcheck/poller.rb),
and [automatic deploy lock](https://github.com/basecamp/kamal/blob/v2.12.0/lib/kamal/cli/base.rb)
source.

The Kamal `web` primary role runs the image's default API process. That API
entrypoint alone runs `alembic upgrade head`, and it starts Uvicorn only after
the migration succeeds; the non-primary `channels-worker` role does not run
migrations. Kamal keeps the still-serving old API in rotation while the new
primary boots, then requires the new primary to pass the proxy `/health` gate
before it boots non-primary roles. Consequently every migration must use an
expand/contract sequence compatible with the old API during this rolling
window. A routine Kamal deploy must not separately run Alembic by hand.

The proxy `/health` gate reaches the API handler that executes database
`SELECT 1`. The image-level Docker HEALTHCHECK calls the same local path for
both roles. On the worker, `/health` returns failure until
`ChannelWorkerHealth.ready` is true and returns failure again while stopping,
so Docker cannot report the worker healthy before its worker stack is ready.
Under Docker's official [HEALTHCHECK timing
contract](https://docs.docker.com/reference/dockerfile/#healthcheck), the
30-second start period still allows migration startup. Even allowing one full
5-second check to straddle that boundary, the 5-second interval and timeout
with eight counted retries give a conservative 115-second unhealthy deadline,
strictly below the 120-second Kamal `deploy_timeout`.

The workflow does not add a public-network post-deploy request: without an
authenticated, environment-specific assertion it would be a brittle duplicate
of the deterministic proxy and container readiness gates. Run authenticated
surface smokes deliberately after those gates when the release requires them.

Before traffic is considered healthy, complete these checks:

1. Confirm required extensions and services are available:
   - PostgreSQL has `pgvector` and `pg_trgm`.
   - File store credentials point at the intended bucket/prefix.
   - `VAULT_ENCRYPTION_KEY` and `ENCRYPTION_KEY` are both set and distinct.
   - Clerk JWT configuration is present for web auth.
2. Smoke test:
   - Web dashboard loads after sign-in.
   - Backend health/API requests return 2xx.
   - CLI can authenticate and run `clawdi vault list --json`.
   - A Vault key resolves only through CLI/API-key auth, never through web auth.
3. Check logs for migration errors, 5xx spikes, auth failures, and frontend
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
