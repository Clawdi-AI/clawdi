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
- Only the cloud API is served. Hosted surfaces (deploy/compute API) are out of
  scope: leave `VITE_CLAWDI_HOSTED` unset on web and
  `EXPO_PUBLIC_CLAWDI_COMPUTE_API_URL` unset on mobile (both are optional).

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
VITE_CLAWDI_API_URL=http://127.0.0.1:8787 \
VITE_CLAWDI_HOSTED=false \
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
EXPO_PUBLIC_CLAWDI_API_URL=http://10.0.2.2:8787   # emulator → host loopback
EXPO_PUBLIC_DEV_AUTH_BYPASS=1                      # dev-only auth bypass (mobile side)
```

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
