# CLI development

Guide for contributors hacking on `packages/cli/`. Commands below are run from the repo root unless noted.

## Running the CLI locally

Four ways to exercise the CLI, ordered from fastest inner loop to
closest-to-end-user:

| When you want to… | Use |
| --- | --- |
| Iterate on a command with instant reload | `bun run packages/cli/src/index.ts <args>` |
| Verify the bundled output + bin wrapper | `bun --cwd packages/cli run build` then `node packages/cli/bin/clawdi.mjs <args>` |
| Exercise a globally-installed CLI from source | `bun link` (see below) |
| Simulate an `npm publish` | `bun pm pack` (see below) |

Native release builds use one catalog-backed layout:
`dist-native/<target>/{clawdi,skills/,egress-addon/}`. The supported targets are
Linux x64/arm64 for glibc and musl, plus macOS x64/arm64. Build and exercise the
host target with the same internal lifecycle command used by ephemeral CI:

```bash
bun run --cwd packages/cli build:native
bun run --cwd packages/cli test:native-linux-lifecycle:internal
```

The lifecycle command exercises the Linux x64 release layout. `build:native`
itself builds the current host target. The macOS Bun executables are linker
ad-hoc signed. This repository does not
claim Developer ID signing, notarization, or browser-download Gatekeeper
compatibility.

Read-only local commands (`skill init`, `config *`, `status --json` while
unauthenticated) work without a backend. Anything that hits the API
(`auth login`, `setup`, `push`, `pull`, `doctor`, `skill install/list/rm`,
`memory *`, `vault *`, `run`) targets `$CLAWDI_API_URL`, which defaults to
the baked-in production URL for release builds and `http://localhost:8000`
for dev builds (`bun run dev` / `build:dev`).

## MCP forwarding deadlines

The stdio proxy gives `tools/call` a 390-second HTTP deadline, including response
body consumption. Backend Composio MCP execution has a 360-second total deadline:
its upstream read allows 300 seconds, with 60 seconds for initialization and
transport overhead. Cold session creation adds at most 10 seconds, leaving
20 seconds for the Clawdi round trip. The session-only high-level SDK uses a
5-second transport timeout and no automatic retries. A separate 10-second total
creation deadline discards late results from the synchronous SDK worker, which
cannot be forcibly cancelled. Authentication precedes forwarding and retains its
existing short network budgets.

The stdio proxy gives discovery and other MCP methods a 30-second forwarding
deadline; this is not a server-side cap for every remote MCP endpoint. Backend
Composio discovery has a 25-second total deadline, including cold session creation
and any reload after invalidation. Listing drains all cursor pages in a single
initialized client within 15 seconds and at most 100 pages, leaving 5 seconds
for the Clawdi round trip. Invalid/repeated cursors fail without caching a
partial catalog. Tool schemas, annotations and tool metadata survive aggregation;
the complete list has no upstream cursor. The legacy endpoint retains first-page
result metadata, since page metadata has no standardized merge semantics.

The locked JavaScript MCP SDK 1.30 defaults **outgoing client requests** to 60
seconds; this does not impose a timer on incoming stdio server handlers. MCP
clients invoking slow tools through the forwarding path described above must
set their own request timeout to at least 420 seconds (for SDK clients, pass
`{ timeout: 420_000 }` as the `callTool` request options). Clawdi cannot override
another client's deadline.

Managed OpenClaw MCP entries explicitly set only `requestTimeoutMs: 420000`,
using that slow-tool caller budget. OpenClaw 2026.9.3 uses the explicit request
budget for both the complete paginated tool catalog and subsequent requests;
without it, catalog discovery defaults to 1500 ms even though requests default to 60
seconds. There is no independent catalog timeout setting, so an unresponsive
catalog can wait up to 420 seconds. Initialization retains the native default
(30 seconds in OpenClaw 2026.9.3); no connection timeout override is written.
Hermes keeps its existing native settings.

The official contracts are [catalog timeout selection](https://github.com/openclaw/openclaw/blob/1391f7cd2d40ab5bbcf2f5f831d3a64f520e72d7/src/agents/agent-bundle-mcp-runtime.ts#L156-L177),
[transport defaults](https://github.com/openclaw/openclaw/blob/1391f7cd2d40ab5bbcf2f5f831d3a64f520e72d7/src/agents/mcp-transport-config.ts#L62-L104),
and [CLI seconds-to-milliseconds configuration](https://github.com/openclaw/openclaw/blob/1391f7cd2d40ab5bbcf2f5f831d3a64f520e72d7/src/cli/mcp-cli.ts#L1275-L1293).
The request timeout field is also supported by the audited July 1
[schema](https://github.com/openclaw/openclaw/blob/2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4/src/config/zod-schema.ts#L386-L409)
and [catalog override](https://github.com/openclaw/openclaw/blob/2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4/src/agents/agent-bundle-mcp-runtime.ts#L285-L305).
That older runtime applies the catalog timeout per page; 2026.9.3 bounds the
complete pagination operation.

Timeout or transport loss does not confirm cancellation or failure of an external
side effect. The proxy never automatically retries tool calls. Check the provider
outcome before retrying a call that may have changed external state.

## Link (`bun link`) — simulated global install

```bash
cd packages/cli
bun run build          # bin/clawdi.mjs imports ../dist/index.js
bun link               # register clawdi for linking

# In any other directory
bun link clawdi
which clawdi           # ~/.bun/install/global/.../clawdi
clawdi --version
```

Re-run `bun run build` after every source change — the bin wrapper always
executes the compiled bundle.

Clean up:

```bash
bun unlink clawdi    # in the other directory
cd packages/cli && bun unlink   # in the package
```

## Pack (`bun pm pack`) — simulated publish

Catches bugs that only show up in the tarball an npm user actually
installs (missing `files` entries, absent `LICENSE`, stale `dist/`,
workspace deps leaking into `dependencies`, …):

```bash
cd packages/cli
bun run build
bun pm pack                                  # → clawdi-<package-version>.tgz
tar -tzf clawdi-*.tgz | head                 # inspect contents
bun install -g ./clawdi-*.tgz
clawdi --version
bun uninstall -g clawdi
rm clawdi-*.tgz
```

## Install into a dockerized agent

End-to-end smoke: install the packed CLI *inside* a real agent image,
chat with the agent so it produces real session data, then have clawdi
read it back. Catches install-time issues (missing runtime deps, Bun /
libc compatibility, workspace deps leaking into `dependencies`) and
adapter-versus-real-data drift that the fixture tests can't.

Example with Hermes (`nousresearch/hermes-agent`). Prerequisite:
`OPENROUTER_API_KEY` in your shell — Hermes's default provider.

```bash
# 0. Pack the CLI on the host.
cd packages/cli
bun run build
bun pm pack                # → clawdi-<package-version>.tgz

# 1. Start the container. The upstream ENTRYPOINT bootstraps
#    $HERMES_HOME and launches the Hermes TUI as PID 1 — we leave it
#    idle (never `docker attach`) and chat via fresh `docker exec`
#    sessions instead, so Ctrl-C can never kill the container.
#    Two -e flags below are upstream workarounds, not clawdi config:
#      OPENROUTER_API_KEY — Hermes's default LLM provider
#      PATH               — upstream ships the `hermes` shim in
#                           /opt/hermes/.venv/bin, which isn't on the
#                           default PATH; without this, entrypoint.sh's
#                           `exec hermes` fails and the container dies
#    Linux only: add --add-host=host.docker.internal:host-gateway
docker run -dit --name hermes \
  -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  -e PATH=/opt/hermes/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  nousresearch/hermes-agent

# 2. Chat with Hermes so state.db accumulates real sessions. Each
#    exec opens a fresh hermes instance sharing /opt/data/state.db;
#    Ctrl-C / quit exits only this session, PID 1 keeps the container
#    alive so state persists.
docker exec -it hermes hermes

# 3. Copy tarball in, install Bun + CLI.
docker cp clawdi-*.tgz hermes:/tmp/
docker exec hermes bash -lc '
  apt-get update -qq && apt-get install -y -qq curl unzip
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  echo "export PATH=\$HOME/.bun/bin:\$PATH" >> ~/.bashrc
  bun install -g /tmp/clawdi-*.tgz
'

# 4. Verify. `host.docker.internal` resolves to your host (auto on
#    Docker Desktop). `HERMES_HOME=/opt/data` is baked into the image
#    as an ENV, so the adapter finds the SQLite automatically.
docker exec hermes bash -lc '
  clawdi config set apiUrl http://host.docker.internal:8000
  clawdi doctor                                 # Agent: Hermes should be ✓
  clawdi push --agent hermes --all --dry-run    # expect the session count you just chatted
'

# 5. Cleanup.
docker rm -f hermes
rm clawdi-*.tgz
```

Two image-specific wrinkles worth knowing:

- **`HERMES_HOME=/opt/data`** is baked into the image (not `~/.hermes`).
  clawdi's `getHermesHome()` reads `$HERMES_HOME` first, so the adapter
  picks up the right path without extra config.
- **The `hermes` shim lives in `/opt/hermes/.venv/bin/`**, not
  `/usr/local/bin/`. That's an upstream Dockerfile oversight — the
  `-e PATH=...` above is a workaround; a proper fix would be an
  `ENV PATH=/opt/hermes/.venv/bin:$PATH` in the upstream Dockerfile.

Without an API key, `hermes` still launches but can't respond; you'd
validate installation and adapter `detect()` but not session parsing.

## Running the backend

Full-pipe commands need the Clawdi backend on `:8000`. Use the canonical local
stack runbook in [`AGENTS.md`](../AGENTS.md#local-end-to-end) for Postgres,
backend, dashboard, local key minting, and cleanup.

Once it's up, a canonical smoke loop:

```bash
clawdi auth login     # Clerk OAuth Authorization Code + PKCE
clawdi setup          # register this agent + install the built-in skill
clawdi doctor         # all ✓ means the full pipe is wired up
clawdi push --dry-run # preview what push would upload
```

`clawdi auth login` is the canonical human login for both Cloud and Hosted. It
stores the current short-lived access token and Clerk refresh grant in the
existing private atomic CLI state file (0700 directory, 0600 file), refreshes
before expiry, and rotates the persisted refresh value when Clerk returns one.
The verified login is bound to the canonical Cloud and Hosted API origins that
were active when the grant was created. The CLI checks the exact request origin
before adding an Authorization header; changing either endpoint requires a new
login. Process-injected `CLAWDI_AUTH_TOKEN` credentials retain production Cloud
compatibility, while custom Cloud endpoints must also set the explicit
`CLAWDI_AUTH_TOKEN_ORIGIN` binding.
`clawdi auth logout` asks the Cloud backend to revoke the refresh grant before
removing local state. The legacy `--manual` API-key path remains Cloud-only.
The Clerk Public OAuth Application must allow `openid`, `profile`, `email`, and
`offline_access`; the last scope is required for the persisted refresh grant.
At the Clerk instance level, `oauth_jwt_access_tokens` must be enabled through
the Backend API. This setting may not appear on the OAuth Application screen.
Cloud and Hosted verify the resulting RS256 access JWT and deliberately reject
opaque tokens.
Cloud reads its public-client identifiers from the strictly registered global
`clerk_cli_oauth` App Setting. Cloud and Hosted are configured independently;
there is no automatic synchronization or shared secret reference between them.

On SSH, run `clawdi auth login --no-open`, open the printed URL locally, then
paste the complete failed loopback callback URL into the masked terminal
prompt. Clerk does not advertise RFC 8628 device authorization. A non-TTY flow
can save the pending PKCE transaction and later run `clawdi auth complete` with
the callback URL on stdin; the authorization code is never accepted as a flag.

The Hosted deploy wizard shares its defaults, validation, request builder,
compute/payment selection, and deployment-request projection with the Web
Deploy Wizard:

```bash
clawdi deploy
clawdi deploy --runtime hermes --provider managed --model <id> \
  --compute basic --request-id <uuid> --yes --json
# Native saved provider (credentials only):
clawdi deploy --provider <native-provider-id> \
  --compute basic --request-id <uuid> --yes --json
# Custom saved provider:
clawdi deploy --provider <custom-provider-id> --model <id> \
  --compute basic --request-id <uuid> --yes --json
clawdi deploy --compute performance --term 12 --payment wallet \
  --request-id <uuid> --yes --json
clawdi deploy --compute performance --payment card --request-id <uuid> --yes --json
```

Included Basic deploys create directly. Wallet deploys require an exact quote
and explicit confirmation. Card deploys open Hosted Checkout and reuse the
stable request ID for recovery; the CLI never accepts provider/card secrets in
flags. Every non-interactive deploy requires `--yes` and a caller-supplied
`--request-id`; paid deploys also require `--payment`. Use `--json` for
deterministic automation and reuse the same request ID after an ambiguous
create or checkout response.
`--provider` also accepts an exact Cloud saved-provider id. The CLI reads only
secret-free provider metadata and sends a provider binding/bootstrap; it never
accepts or prints the saved credential. Native saved providers do not prompt
for or require a model: choose models inside
the Agent. Legacy `--model` is accepted with a stderr warning and omitted from
the binding, preserving existing model choices. Custom saved providers require
`--model` unless they have one unambiguous default. Provider IDs come from Cloud
AI Providers, not the local `ai-provider list` catalog.

## Cloud context and remote Skills

These commands use the configured Cloud API and require login. `session list`
continues to read local history; `session search`, `read`, and `export` use Cloud
session UUIDs. Export writes owner Markdown to stdout and never creates a link.
`--json` exports owner metadata and messages instead.

```bash
clawdi session search "workspace setup" --json
clawdi session read <cloud-session-id> --json
clawdi session export <cloud-session-id> > session.md
clawdi session share <cloud-session-id> --yes --json
clawdi session share <cloud-session-id> --through <position> --yes --json
clawdi session share <cloud-session-id> --response <position> --yes --json
clawdi session shares <cloud-session-id> --json
clawdi session unshare <share-id> --yes
clawdi session unshare <legacy-link-id> --legacy --yes
clawdi memory update <full-memory-id> "Prefer tabs" --json
```

Sharing publishes an immutable whole-session snapshot by default. Scoped shares
use the canonical `position` returned by `session read --json`; these positions
may have gaps from hidden/tool events, so never enumerate the filtered messages.
`--response` requires an assistant message. Publication and revocation prompt
unless `--yes` is supplied; automation requires it. `shares` includes both active
snapshot and legacy live links, with `--page` and `--limit` pagination. Revoke
uses the exact inventory link ID; `--legacy` selects a legacy link explicitly
and retrying it cannot revoke a newly created replacement. Sharing requires
OAuth CLI or a fully unbound account key; scoped and Agent-bound keys are denied.
Memory update requires `memories:write`, retains metadata through the configured
provider service, and rejects likely secrets on both client and server.

```bash
clawdi agent skills list <agent-id> --json
clawdi agent skills read <agent-id> <skill-key>
clawdi agent skills install <agent-id> --github owner/repo --path skills/review
clawdi agent skills install <agent-id> --library <skill-id>
clawdi agent skills rm <agent-id> <skill-key>
```

Remote targets are stable Cloud Agent UUIDs. Local `skill --agent <type>` keeps
its existing meaning. Library operations use Cloud references and preserve the
source Skill. Linked Project and bundled Skills are read-only here. GitHub
operations use Hosted's native source validation and capability gate, with the
canonical OAuth CLI login. Unsupported runtimes/capabilities fail explicitly;
no local installation is substituted. `list` includes desired state, observed
convergence and failed removals; failed status sets exit code 1. `read` prints
instructions on a terminal and structured detail with `--json` or a pipe.

Accepted requests are not proof of runtime application. GitHub writes carry a
fresh resource version and a generated or caller-supplied `--request-id`. After
an ambiguous response, inspect inventory. Exact replay must reuse **both** the
original `--request-id` and `--resource-version` printed in the result/error;
the Hosted fingerprint includes that version. Version conflicts require
reviewing current state before submitting a new request.

Against local Cloud/Hosted APIs with suitable fixtures, verify that
`session read --json` exposes canonical positions, owner exports create no
links, revoked links disappear from `shares`, and `agent skills list` reports
actual convergence. Run the focused hermetic regressions:

```bash
bash scripts/test.sh cli tests/commands/deploy.test.ts tests/commands/session.test.ts tests/commands/agent-skills.test.ts
bash scripts/test.sh backend tests/test_cli_oauth_auth.py tests/test_session_shares.py
```

Done: both commands exit 0. The backend tests cover real OAuth/API-key gates,
exact legacy revocation, hidden/tool position gaps and Memory metadata/ownership.

## Typecheck / test / build

```bash
bun install
bun run --cwd packages/cli typecheck   # tsc --noEmit
bun run --cwd packages/cli test        # Docker-isolated CLI suite
bun run --cwd packages/cli build       # produces dist/
```

## Testing

The public package `test` command runs through the clean Docker runner with a
fake `HOME`; pass a test path or Bun test filter after the command for a focused
run. `test:internal` is reserved for the Docker runner and CI and must not be
used as a normal host-local entrypoint. Most tests use synthetic agent homes.
Hosted Hermes Skill tests use unmodified native modules from a fixed upstream
fork commit in a disposable Python fixture. The Docker runner provisions it
only for those test files, their containing runtime group, name-filtered runs,
or the full suite; it never uses or changes a user's Hermes install. The
fixture source and venv are removed when the runner exits.

On a Linux Docker host, verify native systemd command deadlines and crash-loop
readiness through the official suite:

```bash
bash scripts/test.sh runtime-systemd
```

This uses a disposable systemd container and filtered checkout inputs. It is
also run by the privileged systemd CI workflow before the official installer
suite. Done: the command exits 0 and reports the native no-job auto-restart
regression passing; no operator configuration or live runtime is used.

For daemon end-to-end and manual browser verification, see
[`clawdi-daemon-test-guide.md`](clawdi-daemon-test-guide.md).

### Layers

| Layer | What it covers | Lives in |
| --- | --- | --- |
| Unit | Pure libs: `api-client` retry/errors, `config`, `sanitize`, `frontmatter`, `source-parser`, `tty`, `version` | `tests/*.test.ts` |
| Adapter regression | Per-agent `collectSessions` / `collectSkills` / `writeSkillArchive` against pre-built fixture `$HOME`s | `tests/adapters/*.test.ts` |
| Command regression | `push` / `pull` / `doctor` / `update` / `skill init` with `globalThis.fetch` mocked; assert golden payloads and filesystem state | `tests/commands/*.test.ts` |
| Process smoke | Spawn `bun src/index.ts <args>` — catches bundle / import-level breakage the in-process tests can't see | `tests/smoke.test.ts` |
| Process e2e | Spawn the real CLI process against a local mock API; covers vault `read`, `inject`, `run --env-file`, and P0 credential profile import/materialize without touching real credentials | `tests/e2e/*.test.ts` |
| Release checklist | Manual; see below | — |

### Fixtures

Synthetic `$HOME` directories for each agent live under
`tests/fixtures/{claude-code,codex,hermes,openclaw,pi}/`. They're regenerated by
one script:

```bash
bun scripts/generate-fixtures.ts
```

Each fixture mirrors the real agent's on-disk layout with enough structure
to exercise every parser branch (tokens, message roles, multiple sessions,
`projectFilter`), and every fixture includes a `skills/node_modules/…` (and
equivalent) sentinel so the adapter tests assert `SKIP_DIRS` actually
filters. The root `.gitignore` has explicit negation rules that keep these
sentinels committed despite `node_modules/` being globally ignored.

Shape:

- `claude-code/` — JSONL with 5 entries (user/assistant messages + usage blocks); `skills/demo` + `skills/node_modules` (SKIP_DIRS sentinel)
- `codex/` — single rollout JSONL under `sessions/YYYY/MM/DD/`: `session_meta` + `turn_context` + `response_item` messages + `event_msg` token_count; `skills/demo` + `skills/.system` (dot-prefix skip) + `skills/node_modules` (SKIP_DIRS)
- `hermes/` — modern upstream-shaped SQLite `state.db` with stable message ids,
  tools, structured attachments/results, compaction and display lifecycle rows;
  `skills/core/demo` (nested) + `skills/node_modules/bad` (verifies SKIP_DIRS
  applies during recursion, not just top-level)
- `openclaw/` — `sessions.json` index + `<id>.jsonl` transcript (with a `model_change` event); `skills/demo` + `skills/node_modules` (SKIP_DIRS)
- `pi/` — official JSONL v1-v4 records covering active-leaf branching,
  compaction retained tails, visible tools, attachment metadata, and
  owner-private thinking with visible-only message projection; Pi has no Skills
  fixture because it is sessions-only

OpenCode's adapter test creates the consumed subset of the pinned upstream
SQLite schema in a temporary directory. That fixture is intentionally generated
per test so the same test can mutate the database and verify queue-time
backing-store re-reads without committing a binary database copy.

Fixtures are committed (not regenerated on every test run). Regenerate only
when an upstream agent's on-disk format changes and a test breaks.

### Running tests

```bash
bun run --cwd packages/cli test                                # full Docker-isolated suite
bun run --cwd packages/cli test:e2e                            # Docker-isolated process E2E
bun run --cwd packages/cli test -- tests/adapters/             # focused adapter layer
bun run --cwd packages/cli test -- tests/commands/push.test.ts # focused command regression
scripts/vault-e2e.sh                                           # real backend + Postgres smoke
bun run --cwd packages/cli test:watch:local                    # opt-in host-local watch
```

## Releasing

Use `docs/runbooks/release.md` for the full app/backend/web/CLI release
checklist. This section covers the CLI/npm release line in detail.

Publishing is automated. `.github/workflows/cli-publish.yml` watches `main`
for changes to `packages/cli/package.json`, so a release run starts only when
the package identity changes. It builds the artifact from its own `GITHUB_SHA`.
An absent exact npm version is
published; an existing version is never republished and must have the same
`dist.integrity` as the artifact built by this run.

Managed agent-v2 releases are repository-autonomous. The CLI workflow builds,
typechecks, runs the full CLI suite, packs one immutable npm tarball, and builds
the native target matrix once. It verifies the npm package after installation
and runs the compiled Linux artifact through the installer/daemon lifecycle.
The exact-version native manifest is the checksum contract for all native
assets. The workflow transfers the same artifacts to the protected npm job and
publishes the npm tarball exactly once to the
standard npm channel derived from the package version: prereleases use `beta`
and stable releases use `latest`. Package-level tag overrides are rejected.
The build/test job may use the configured fast runner, but the protected
publish job is fixed to GitHub-hosted `ubuntu-latest`: npm trusted publishing
does not support self-hosted or third-party GitHub Actions runners. The publish
job uses Node 24 and npm 12.0.2, satisfying npm 12's minimum Node 24.15
requirement. After a fresh `npm publish --provenance` succeeds, that command plus the exact registry
version and matching `dist.integrity` authorizes GitHub Release completion; the
job does not wait for the eventually consistent registry attestation read API.
If release work remains and the immutable npm version already exists, the
workflow never republishes it and only accepts an exact integrity match. The
GitHub Release and tag must target that run's `GITHUB_SHA`; another commit while
completion is required fails closed.

The CLI workflow neither calls nor checks out the Hosted repository. An operator
verifies the exact package publication, then explicitly supplies the exact
`clawdi@<semver>` package spec to the separate Hosted image workflow. That
workflow fails closed when the exact input is missing, verifies registry
integrity, signatures, and provenance, never resolves an npm dist-tag, and runs
its image/CLI pairing smoke before publishing the image. The `beta` tag is npm
publication metadata for prereleases, not an operator gate or rollout
authority. The CLI workflow does not coordinate with the Hosted repository.
Cloud-owned Hosted manifests select `clawdi@<exact-semver>` only. The runtime
installs that exact public version directly and never calls `npm view` for
Hosted desired state.

Agent deployment v2 became publicly enabled on 2026-08-12 while v1 remained
enabled. Treat its runtime contract as a released surface: roll out additive
manifest capabilities consumer first, preserve compatibility with deployed
exact CLI versions, and verify runtime-state writes, canonical
`/v1/runtime/manifest` fetches, SSE invalidation, and runtime services during
each controlled rollout. Do not repurpose or remove released fields without an
explicit compatibility path.

The monorepo has two GitHub Release lines:

- `clawdi-cli-vX.Y.Z` for the published npm package and native distribution.
  The CLI publish workflow creates this release after npm publish succeeds and
  attaches `install.sh`, the exact native manifest, and its checksum-bound
  target archives.
- `clawdi-YYYY-MM-DD` for Clawdi app/backend/web changes. Additional releases
  on the same UTC day append `-2`, `-3`, and so on. The suffix is a same-day
  release sequence, not a semver patch number.
  `.github/workflows/clawdi-release.yml` is manual-only and should be run with
  a specific version/commit after a production deploy that needs public release
  notes.

Use the GitHub release body as the published release notes and keep notable
entries mirrored in `CHANGELOG.md`. GitHub's generated notes are categorized by
`.github/release.yml`; only PRs with release-note labels such as `feature`,
`fix`, `security`, or `documentation` are included. Add `skip-changelog` to
explicitly suppress a PR that would otherwise appear. Generated notes are a
draft, not a final product surface: review and edit them when a PR touched both
release lines, a title is implementation-focused, or user impact needs clearer
wording. Keep release notes user-facing: include notable features, behavior
changes, fixes, deprecations, removals, security notes, and user actions; omit
migrations, CI, deployment steps, refactors, generated files, and other
implementation-only details.

Old preview releases can be deleted when their binaries and install links
are no longer needed. Prefer leaving them as prereleases while they are
still useful for reproducing old preview environments.

### Bootstrap (one-time, before the workflow can do anything)

npm's trusted-publisher OIDC requires the package to already exist on the
registry before it'll accept a GitHub Action as a publisher. So the very
first version has to be published manually:

```bash
cd packages/cli
npm login                    # use a maintainer account that owns the org
bun run build                # produces dist/
NPM_TAG=$(node -e "const p=require('./package.json'); console.log(p.version.includes('-') ? 'beta' : 'latest')")
npm publish --access public --tag "$NPM_TAG"  # plain publish, no --provenance
```

After the first publish, configure trusted publisher (next section); subsequent
releases are automatic.

### To ship a new version (after bootstrap)

1. Bump `version` in `packages/cli/package.json` (follow semver).
2. Merge to `main`.
3. The workflow builds, typechecks, runs the full CLI suite, packs and installs
   one artifact, verifies its SHA-256 in both jobs, then publishes that tarball
   from GitHub-hosted `ubuntu-latest` with
   `npm publish <tarball> --access public --provenance --ignore-scripts --tag <resolved-tag>`.
   A successful fresh publish is completed using that command result plus the
   exact registry version and `dist.integrity`; it does not depend on immediate
   visibility of the registry attestation query endpoint.
   If npm already has the exact version, the workflow never republishes it and
   compares the current run's tarball directly with npm `dist.integrity`.
   Integrity drift requires a version bump or a rerun of the original workflow;
   the workflow never checks out a source commit inferred from registry data.
4. The workflow creates or completes `clawdi-cli-v<version>` as a draft,
   uploads the verified binary assets, then finalizes the release with changelog
   notes.
5. Watch the Actions tab; on green,
   `npm view clawdi@<exact-version> version` reflects the new number. A
   prerelease updates `beta`; a stable release updates `latest`.

Stop here for this release workflow. Hosted rollout selects the approved exact
version through its Cloud manifest. The `beta` tag is publication metadata;
production and Hosted never resolve an npm dist-tag.

A manual run is available under `workflow_dispatch` if the auto-run needs a
nudge. If npm succeeded but GitHub Release creation failed, rerun that original
workflow run so `GITHUB_SHA` and the artifact remain identical.

### Smoke checks before bumping the version

These don't block the release, but catch adapter-level regressions that
unit tests miss. Run on a machine with the real agents installed:

- `clawdi setup --yes` — registers every detected agent + installs the
  bundled `clawdi` skill + wires up MCP where possible
- `clawdi doctor` — expects all ✓
- `clawdi push --agent claude_code --dry-run` — session count looks right
- `clawdi push --agent codex --dry-run`
- `clawdi push --agent hermes --dry-run` (warns about no project filter)
- `clawdi push --agent openclaw --dry-run`
- `clawdi teardown --agent claude_code --yes` then re-run
  `clawdi setup --agent claude_code --yes` — verifies the inverse cleanly
  removes the env file + bundled skill + MCP entry, and that re-setup
  restores everything
- `clawdi mcp` launched from a real Claude Code `.mcp.json`; call
  `memory_search` and see a response

### Trusted publisher (OIDC)

The workflow publishes without an `NPM_TOKEN` secret. It uses npm's
[trusted publisher](https://docs.npmjs.com/trusted-publishers) flow via
the `id-token: write` permission + `environment: npm` gate. Configure
this one-time on npmjs.com:

1. `Access` tab of the `clawdi` package → `Trusted Publisher`
2. Select GitHub Actions, enter `Clawdi-AI/clawdi`, workflow
   `cli-publish.yml`, environment `npm`
3. Save. Subsequent pushes to `main` with a version bump auto-publish.

The OIDC publish job must remain on a GitHub-hosted runner. Do not replace its
`ubuntu-latest` runner with `vars.CI_RUNNER`, Blacksmith, or another self-hosted
runner. OIDC is used only to publish the non-production candidate in this
workflow; production selection is outside this PR.

## Vault requests and local dotenv bindings

Strict-v2 runtimes can read their own Workspace and explicitly linked Projects still
readable by the owner. `project_current_get` returns that Workspace; writes, new
Vaults, and requests are restricted to it. Legacy Agent-bound keys retain their narrower
bound-Project read scope.

Honor the user-selected Vault or existing local binding first. Otherwise inspect visible
`vault_list` / `vault_get` metadata and reuse a Vault matching the task's purpose and
intended access. Create under the current Workspace only if none is appropriate and the
task authorizes creation. Ask for the exact target when ambiguity affects purpose or
access. Linked Vaults may be synced read-only; never request/upsert outside the write
boundary or create duplicates to sidestep access.

Use MCP `vault_request_create` to request up to 32 new or updated Vault fields in one
owned Vault/Project attachment. Names follow ordinary Vault validation, including dots
and hyphens; duplicates after trimming are rejected. Show the returned URL unchanged.
Its fragment contains a `v2_` capability with 256 random bits, hashed at rest and valid
for one hour by default (five minutes to one day configurable). Viewing does not consume
it; saving all requested fields and user-added extras in one successful transaction does.
The page keeps requested names fixed and lets users add, rename, or remove extras, up to
32 total. Import .env accepts pasted or UTF-8 file text (4 MiB maximum), preserves name
case/dots/hyphens, and requires preview then Apply before the single Save. Preview identifies
entered values to replace and existing Vault fields to update; existing values are never
shown. Imports reject malformed lines, duplicates, empty/NUL values, and values over 65536
characters. Double quotes decode `\n`, `\r`, `\t`, `\"`, and `\\`; single quotes are literal.
Variables and commands are never expanded; JSON and multiline quoted assignments are not
accepted on this page.

Creation captures ciphertext fingerprints for the whole section, with explicit nulls for
absent required names. `POST /v1/vault/requests/inspect` accepts optional chosen `fields`
and returns only those names in `update_fields`, never unrelated names or fingerprints.
Supply requires the original subset, validates every chosen field against creation state
under the Vault lock, and rejects extras reserved by another live request. Optional fields
are chosen by the user after creation; creation does not accept `extra_fields`. Supplied
status persists `extra_fields`, lists all saved `fields`, and includes all exact references.

Changes to any requested field conflict with the entire batch; unrelated edits do not.
A conflicted request can be replaced immediately, while true pending overlap is rejected.
`vault_request_status` and recent requests return metadata and exact references, never
secret values or local commands. After expiry or conflict, reassess the authorized fields
before requesting again; never delete a key to request an update.

The request migration expires every pre-cutover pending link, preserving saved values and
history. Request snapshots are mandatory on new inserts. Deploy the current backend and
page together; users with expired links need a fresh request. Downgrade also expires
all unsupplied links and folds saved extras into historical `fields`, retaining their
references and creation baselines for old readers and a subsequent upgrade.

After supply in a managed runtime or configured connected macOS/Linux Agent, verify `vault_request_status` and inspect only
`.clawdi/vaults/index.json` under the native workspace. Match the Vault ID, section and field
names, and require local `content_version >= status.content_version` before claiming delivery.
The API requires `content_version`. Incomplete owned cache metadata must refresh before
delivery can be confirmed, even when the field names already exist.
This is the existing Vault content counter; opaque `revision` remains a cache/visibility
identity and must not be compared across Agents. Existing runtime watch delivers readable
Workspace/linked-Project Vaults into separate generated section JSON files. Load the
selected file inside the authorized process/SDK without exposing values to model context
just to save them. Do not invoke the tenant CLI or edit generated files. See
[Runtime Vault files](managed-runtime.md#runtime-vault-files) for permissions, revocation,
fallback and isolated verification. Connected setup uses `--agent <type> --vault-workspace <path>` and stores the binding in
the existing Agent registration; `--yes` alone never guesses a target. See the
[skill workflow](../packages/cli/skills/clawdi/SKILL.md#save-and-refresh-credentials-locally).

The standalone CLI also supports explicit absolute local dotenv files:

```bash
clawdi vault materialize --vault <vault-uuid> --project <project-uuid> --out /absolute/project/.env
clawdi vault pull --out /absolute/project/.env
```

The first synchronization records the canonical API URL, authenticated account, exact Project/Vault
UUIDs, field identities/references, and local assignment fingerprints in a comment in
that same file. Optional `--section <name>` narrows the binding; `--section ''` selects
unsectioned keys. Field names must be valid, distinct environment identifiers; duplicate
names across sections require a section selection or explicit renaming in Vault.

Later synchronizations refresh existing keys, discover new ones, and remove remotely deleted keys
only when their previously managed assignments are unchanged locally. Unrelated lines,
comments, and variables are preserved. User-edited managed assignments, removed metadata,
new-key collisions, replaced field identities, and changed account/API/source context fail
closed. Restore the original managed assignment/metadata or choose a fresh target; there
is no force mode, daemon, background sync, or automatic upload of local changes.

The file is atomically replaced with POSIX permissions `0600`, together with its binding
(use WSL on Windows).
Targets in a Git repository must already be untracked and ignored; parent directories
must not be symlinks or writable by other users. A per-target lock rejects overlapping
pulls; after a crashed process, remove its `.clawdi-lock` only after confirming it stopped.
The file uses literal dotenv quoting (including multiline values), not a shell script:
load it with a dotenv reader, rather than `source`. Values that cannot round-trip safely
through dotenv quoting are rejected instead of modified. No secret values appear in
materialization responses or logs.

Remote MCP retains `vault_resolve` for authorized single or batch reference reads;
it does not expose whole-Vault file materialization.
`vault_item_upsert` and `vault_item_delete` cover
explicit batch import/write/removal; they do not imply reverse synchronization.

Done: `scripts/test.sh cli src/lib/vault-env.test.ts` verifies file bindings, permissions,
conflicts, and preservation of unrelated lines. `scripts/test.sh backend tests/test_vault_requests.py`
verifies request supply/status and the REST material endpoint against isolated PostgreSQL.

Deployment requires migration `c92e8b3d104f`, the updated API/client/web, and a `WEB_ORIGIN`
that points to the public dashboard. Deploy the API before clients and refresh MCP tool
lists and packaged skills.
