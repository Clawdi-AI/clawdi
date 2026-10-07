# UI parity tooling

Render the web dashboard and the mobile app against the same deterministic data
so the two can be compared side by side.

| File | Purpose |
| --- | --- |
| `fixture-api.ts` | Bun server that impersonates the Clawdi cloud API with typed fixtures. |
| `web-screenshots.ts` | Playwright phone-viewport screenshots of web routes. |
| `web-fixture-states.ts` | Assert fixture-backed Web flows and capture light/dark form states. |
| `android-screenshot.sh` | Open a `clawdi://` deep link on a running emulator and screenshot it. |

All output goes to `/tmp/clawdi-ui-parity/` by default.

## 1. Fixture API

```bash
bun scripts/ui-parity/fixture-api.ts            # 0.0.0.0:8787
bun scripts/ui-parity/fixture-api.ts --port 9000 --host 127.0.0.1
```

- Any `Authorization: Bearer <token>` is accepted (the web dev bypass sends
  `dev-bypass`). CORS reflects the request origin.
- Fixtures are typed against `packages/shared/src/api/api.generated.ts`; after
  regenerating the API types, run the typecheck below to catch drift.
- Timestamps are relative to "now" and are shifted on every response, so the
  data stays recent (two agents always read as live) however long the server
  runs.
- Unknown routes return `404` JSON and log `UNHANDLED <method> <path>` to
  stderr; that line is the signal to add a fixture. Most mutations return a
  plausible success body. Flows that render a read-after-write result retain
  metadata in memory until the server stops (see below).
- `GET /v1/sessions/{id}/content-events` deliberately returns `404`; the web
  client treats that as "no live stream".
- The same server also serves the hosted compute/deploy API (`/v1/me` and
  `/v2/*`), typed against `packages/shared/src/api/deploy.generated.ts`.
  Use the same origin for both API URLs; no separate compute port is needed.
  Hosted fixtures include the original two running deployments, four additional
  deployment states, Included Basic and paid Performance subscriptions, a Wallet
  balance/transactions, AI usage, plans and managed models.
  Runtime infrastructure and live event streams are deliberately absent.
- During parallel verification, keep the shared `:8787` server untouched and
  start your copy with `--port 8791`. Stop only the server you started.

Hosted deployment IDs: `hdep_ParityOpenClaw`, `hdep_ParityHermes`; recovery
request IDs: `request-<deployment-id>`; operation IDs: `op-<deployment-id>`.

Stable IDs used by the default routes: agent `c1a0de00-0001-4c00-8000-000000000001`
(Claude Code), session `5e550000-0001-4000-8000-000000000001`, project
`a0f1c2d3-0002-4a00-8000-000000000002` (Acme Web App), vault slug `acme-prod`.

Agent profiles: Claude Code has the default profile, `work`, removed `personal`
and an idle `staging` profile with no sessions (profile ids
`9f0f0000-0001-4000-8000-c1a0de00000N`, N=1–4); Research Hermes has the default
profile and `research`. `GET /v1/sessions?profile_key=` filters by profile.

### Form and flow states

Use an isolated fixture process for mutation checks. Existing project, agent,
session, vault, API-key and running-deployment IDs remain unchanged.

```bash
bun scripts/ui-parity/fixture-api.ts --port 8791 --host 127.0.0.1
```

Public links use a reserved HTTPS test origin and project tokens have exactly
43 URL-safe characters, matching the native input guards. Native join/supply
clients extract the token and send it to the configured fixture API. For local
Web preview, open the returned pathname/hash on your Web dev server (the
screenshot script does this); the reserved HTTPS host is not a deployed site.

Additional CLI flags:

| Flag | Default | Purpose |
| --- | --- | --- |
| `--share-origin` | `https://fixture.clawdi.test` | HTTPS public-link origin accepted by Web/mobile sharing guards. The reserved test host performs no authentication or hosting. |
| `--memory-provider` | `builtin` | Start with `builtin` or `mem0`. |
| `--mem0-configured` | `false` | `true` renders configured Mem0; `false` renders its key form when Mem0 is selected. |
| `--whatsapp-state` | `ready` | State returned by new/retried/repaired sessions: `generating`, `ready`, `scanned`, `connected`, `expired`, `canceled`, or `error`. |

Settings PATCH persists the provider and configured/unconfigured toggle.
Submitted Mem0 values are discarded; GET returns only a fixed synthetic marker
in `mem0_api_key` (plus `mem0_api_key_configured`) for the existing clients.

| Flow | Fixture / stable ID / Web entry |
| --- | --- |
| Received invitations | `GET /v1/me/invitations`: Partner Research (`1a710000-0002-4000-8000-000000000002`) and Platform Operations (`1a710000-0003-4000-8000-000000000003`). Web notification bell exposes Accept/Decline. Accepted Partner Research/Platform Operations joins the project inventory with IDs `a0f1c2d3-0006-4a00-8000-000000000006` / `a0f1c2d3-0007-4a00-8000-000000000007`. |
| Member invitation | Acme Web App has pending `sam@acme.dev`, ID `1a710000-0001-4000-8000-000000000001`. Project → Access → Manage sharing exposes cancellation. |
| Project invite link | Acme link `51aee000-0001-4000-8000-000000000001`, label Design review. Preview/join token `fixture_project_acme_0000000000000000000000`, Web `/share/fixture_project_acme_0000000000000000000000`. Creation returns a one-time URL/token; revocation invalidates preview. |
| API keys | Settings → API Keys lists two legacy full-access keys with revoke. Creation is retired: `POST /v1/auth/keys` answers 410 like the backend. |
| Vault prefix groups | `acme-prod` adds two actual key names each under `stripe/` and `sentry/` in its default section, making Split into vaults… reachable. Original keys stay unchanged. |
| Vault supply | Request `5ecae000-0001-4000-8000-000000000001` requests DEPLOY_TOKEN and DATABASE_URL, with DATABASE_URL marked Update. Token `v2_fixture_acme_000000000000000000000000000000`; Web `/vault-request#<token>`. Inspect/supply accept unauthenticated token requests, matching the public API. Supply retains receipt metadata only. |
| Channels | Original Telegram/Discord accounts now have owner capabilities in bot-pool; three paired-chat rows match their original link counts. Link Agent, Pair, Unlink, paired-chat Unpair, and Publish commands are reachable. Telegram's QR payload matches its deep link. Additional unlinked Telegram bot `c4a00000-0004-4000-8000-000000000004` (@acme_review_bot) exposes Replace link when choosing OpenClaw. |
| WhatsApp | Repairable Custom bot `c4a00000-0003-4000-8000-000000000003`. Readiness is available; create returns QR-ready by default. Pairing-code returns synthetic `1234-5678`; cancel clears QR/code; retry/repair returns a fresh QR state. Repeating a create request ID recovers the same session. Linking the disconnected account returns the real `whatsapp_repair_required` conflict to expose Web repair; starting with `--whatsapp-state connected` also updates account readiness. |
| Plugins | Catalog `fixture-notes` (Project Notes) and `fixture-review` (Code Review). Project Notes starts installed on OpenClaw. Its Plugins section exposes Install and Remove confirmations. |
| Connector credentials | Stripe and Airtable auth-fields return API_KEY with a required secret `api_key` field. Credentials connect returns an active synthetic account and discards submitted values. |
| OAuth result | Provider accept/device-start/device-poll return a synthetic ChatGPT device flow and ready OpenAI result. The verification URL is the exact official `https://auth.openai.com/codex/device` URL required by the native guard. The screenshot script never opens it; no external authorization occurs and the code is synthetic. |
| Connected Agent disconnect | Additional agent `c1a0de00-0005-4c00-8000-000000000005`, Disconnect Demo, has `explicit_identity=false` and no hosted ownership. This enables the existing mobile disconnect gate; Web's platform capability remains unchanged. |
| Session shares | Default session has snapshot `5a4e0000-0001-4000-8000-000000000001` and live permission `9ea10000-0001-4000-8000-000000000001`. Share dialog/inventory can render existing links and revoke/replace them. Public detail/message endpoints serve both share kinds. |

Fixed WhatsApp session IDs are
`fa000000-000N-4000-8000-00000000000N`: N=1 ready, 2 generating,
3 scanned, 4 connected, 5 expired, 6 canceled, 7 error.
`GET /v1/channels/whatsapp/onboarding/sessions/{id}?state=<state>` offers a
read-only QR-state override.
`GET /v1/channels/whatsapp/onboarding/readiness?available=false` returns the
temporarily-unavailable readiness variant. Use the CLI state flag to exercise
these variants through the actual create flow.

Additional hosted rows:

| Deployment | Agent ID | Subscription / state |
| --- | --- | --- |
| `hdep_ParityStopped` | `4e2e5000-0005-4c00-8000-000000000005` | `csub_ParityStopped`; stopped, active paid Performance |
| `hdep_ParityFailed` | `4e2e5000-0006-4c00-8000-000000000006` | `csub_ParityFailed`; failed with RuntimeStartFailed condition, cancellation scheduled at period end |
| `hdep_ParityStarting` | `4e2e5000-0007-4c00-8000-000000000007` | `csub_ParityStarting`; starting, operation still pending |
| `hdep_ParityDunning` | `4e2e5000-0008-4c00-8000-000000000008` | `csub_ParityDunning`; stopped, past_due, wallet top-up recovery |

Each has detail, workspace-skills, `request-<deployment-id>` recovery lookup,
`op-<deployment-id>` operation and deployment-filtered subscription responses.
Open its Agent route for status/action presentation; Settings → Billing shows
the overdue subscription.

State retained per process: invitations, project links, API-key revocations,
Mem0 settings, vault request receipts, WhatsApp sessions/request IDs, channel
links/bindings, plugin desired state, connector account metadata and session
shares/permissions. Restart the isolated process to restore the seeds.
Other mutations keep the generic success fallback; concrete mutation routes
always precede that fallback.

Real Clerk profile/security/account forms require a real Clerk session and
cannot be enabled by cloud fixture data. Synthetic OAuth completion does not
verify external authorization. Mobile UI verification still requires an APK
built with this isolated fixture origin; no APK or shared fixture is changed
by these scripts. The Web phone viewport currently compresses the Split
dialog's prefix labels; destination inputs and group counts remain visible.

## 2. Web screenshots

```bash
cd apps/web
VITE_DEV_AUTH_BYPASS=true \
VITE_DEV_AUTH_TOKEN=dev-bypass \
VITE_DEV_AUTH_NAME="Avery Chen" \
VITE_DEV_AUTH_EMAIL=avery@clawdi.dev \
VITE_CLAWDI_API_URL=http://127.0.0.1:8788 \
VITE_CLAWDI_HOSTED=true \
VITE_CLAWDI_DEPLOY_API_URL=http://127.0.0.1:8788 \
bun run dev -- --host 127.0.0.1 --port 3200 --strictPort
```

`VITE_DEV_AUTH_NAME`/`EMAIL` make the web identity match the fixture
`/v1/auth/me` user. Then, from the repo root:

```bash
bun scripts/ui-parity/web-screenshots.ts                  # light theme, default routes
bun scripts/ui-parity/web-screenshots.ts --theme dark --out /tmp/clawdi-ui-parity/web-dark
bun scripts/ui-parity/web-screenshots.ts --routes "agents=/agents,api-keys=/?settings=api-keys"
```

Captures use a 390×844 viewport, `deviceScaleFactor: 3`, touch and mobile
emulation. Page routes are full-page; settings dialogs are viewport-sized. API
responses with status ≥ 400 are listed next to each capture. Use
`--base-url` for another dev server and `--settle-ms` to wait longer after
network idle.

### Verify the previously data-blocked Web flows

Start Web with the same dev-bypass/hosted environment variables above, both
API URLs set to `http://127.0.0.1:8791`, and port `3217`. Start a fresh
fixture on port `8791`, then run:

```bash
bun scripts/ui-parity/web-fixture-states.ts
# Focused rerun, with separate output:
bun scripts/ui-parity/web-fixture-states.ts --only vault-split,connector,channel-pair \
  --out /tmp/clawdi-ui-parity/web-fixture-states/focused
```

Options: `--base-url`, `--api-url`, `--out`, `--only` (comma-separated
case suffixes). Assertions exercise real Web controls and synthetic mutations,
including one-time results, Mem0 toggling, plugin installation/removal,
WhatsApp QR/code, paired-chat confirmation, command publication, synthetic OAuth
code/completion and vault receipt. It scrolls each target into the viewport before
capturing, including the overdue subscription lower in the Compute dialog.
The script closes Chromium, restores builtin/unconfigured Mem0, and
writes screenshots plus `manifest.json` under the output directory. Modal
captures use the viewport; pages use full-page captures. A failed assertion or
unexpected fixture API error makes the command fail. Stop your Web and fixture
processes after checking the screenshots.

## 3. Android screenshots

Mobile reads its cloud API base URL from `EXPO_PUBLIC_CLAWDI_API_URL`
(`apps/mobile/app.config.js` → `extra.clawdi.cloudApiUrl`, parsed in
`apps/mobile/src/config/runtime-config.ts`). Point it at the fixture server:

```bash
EXPO_PUBLIC_CLAWDI_API_URL=http://10.0.2.2:8788   # emulator → host loopback
EXPO_PUBLIC_CLAWDI_COMPUTE_API_URL=http://10.0.2.2:8788 # hosted compute/deploy fixtures
EXPO_PUBLIC_DEV_AUTH_BYPASS=1                      # dev-only auth bypass (mobile side)
```

The installed native APK reads API URLs from the build-time Expo config
(`extra.clawdi`), not from a Metro-only environment override. Setting the
compute environment variable only when starting Metro does not enable hosted
screens in an APK built without it. Have the build owner produce the preview
APK with both URLs above and `EXPO_PUBLIC_DEV_AUTH_BYPASS=1`, then install it
on your assigned emulator; UI parity agents must not rebuild the APK.

Alternatively run `adb reverse tcp:8787 tcp:8787` and use
`http://127.0.0.1:8787`. Development auth bypass runs the real mobile screens,
providers and API clients without a Clerk publishable key. Its default name/email
are `Avery Chen` and `avery@clawdi.dev`, matching the fixture and web reference; optionally override
`EXPO_PUBLIC_DEV_AUTH_NAME`, `EXPO_PUBLIC_DEV_AUTH_EMAIL` or
`EXPO_PUBLIC_DEV_AUTH_TOKEN` (default `dev-bypass`). Production builds cannot
enable bypass. Clerk-only account management shows an EmptyState in this mode.

With the emulator already running and the app installed (preview package
`com.clawdi.preview`):

```bash
scripts/ui-parity/android-screenshot.sh dashboard /
scripts/ui-parity/android-screenshot.sh agents /agents
scripts/ui-parity/android-screenshot.sh agent-detail /agents/c1a0de00-0001-4c00-8000-000000000001
scripts/ui-parity/android-screenshot.sh sessions /sessions --settle 5
```

The preview APK uses React Native's dev menu rather than `expo-dev-client`.
If the development-client deep link does not change the server, open the RN dev
menu (`adb -s emulator-5556 shell input keyevent 82`), choose **Change Bundle
Location**, enter `10.0.2.2:8082`, and apply. Verify Metro logs show **Android
Bundled** from your worktree before capturing; the native config remains baked
into the APK.

The bundle address is temporary in this APK: a force-stop/cold launch restores
the default port. Keep the app running while capturing, and repeat the dev-menu
selection after a cold launch. When the keyboard opens, use the current position
of **Apply Changes**; its button moves above the keyboard.

The script uses `adb` from `~/.cache/clawdi/android-preview/sdk/platform-tools`
(override with `ANDROID_SDK_ROOT`), opens `clawdi://<path>`, and writes
`/tmp/clawdi-ui-parity/android/<name>.png`. It fails if no device is attached;
it never starts emulators or installs builds. Use `--package` for another
application ID and `--serial` when several devices are attached.

## Checks

```bash
(cd scripts/ui-parity && ../../node_modules/.bin/tsc -p tsconfig.json)
node_modules/.bin/biome check scripts/ui-parity
```
