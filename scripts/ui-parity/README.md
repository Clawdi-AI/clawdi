# UI parity tooling

Render the web dashboard and the mobile app against the same deterministic data
so the two can be compared side by side.

| File | Purpose |
| --- | --- |
| `fixture-api.ts` | Bun server that impersonates the Clawdi cloud API with typed fixtures. |
| `web-screenshots.ts` | Playwright phone-viewport screenshots of web routes. |
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
  stderr; that line is the signal to add a fixture. Mutations return a
  plausible success body and are not persisted.
- `GET /v1/sessions/{id}/content-events` deliberately returns `404`; the web
  client treats that as "no live stream".
- The same server also serves the hosted compute/deploy API (`/v1/me` and
  `/v2/*`), typed against `packages/shared/src/api/deploy.generated.ts`.
  Use the same origin for both API URLs; no separate compute port is needed.
  Hosted fixtures include two running deployments, Included Basic and paid
  Performance subscriptions, a Wallet balance/transactions, plans and managed models.
  Runtime infrastructure and live event streams are deliberately absent.
- During parallel verification, keep the shared `:8787` server untouched and
  start your copy with `--port 8788`. Stop only the server you started.

Hosted deployment IDs: `hdep_ParityOpenClaw`, `hdep_ParityHermes`; recovery
request IDs: `request-<deployment-id>`; operation IDs: `op-<deployment-id>`.

Stable IDs used by the default routes: agent `c1a0de00-0001-4c00-8000-000000000001`
(Claude Code), session `5e550000-0001-4000-8000-000000000001`, project
`a0f1c2d3-0002-4a00-8000-000000000002` (Acme Web App), vault slug `acme-prod`.

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
