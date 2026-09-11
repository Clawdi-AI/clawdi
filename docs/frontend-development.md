# Frontend development

Guide for contributors working on `apps/web/`. The web app is a TanStack Start
dashboard built with React 19, TanStack Router, Tailwind v4, shadcn/ui, TanStack
Query, Zustand, and Clerk.

For typed cloud-api queries, cache keys, refresh semantics, and documented
TanStack Query exceptions, see [`openapi-react-query.md`](openapi-react-query.md).

## Local web loop

Use the canonical local-stack runbook in
[`AGENTS.md`](../AGENTS.md#local-end-to-end) when you need backend + dashboard +
CLI running together. For app-only work, start the web dev server from the
repository root:

```bash
bun run --cwd apps/web dev
```

Open `http://localhost:3000`.

For local browser testing without Clerk, keep `apps/web/.env.local` aligned
with the AGENTS runbook:

```dotenv
# apps/web/.env.local
VITE_CLAWDI_API_URL=http://localhost:8000
VITE_DEV_AUTH_BYPASS=true
VITE_DEV_AUTH_TOKEN=dev-bypass
```

## Verification

This is the canonical web verification set. Run it before sending web changes
for review, swapping the targeted test path for the file or directory touched by
the change:

```bash
bun run --cwd apps/web typecheck
bun run --cwd apps/web test src/hosted/oss-clean.test.ts
bunx biome check apps/web/src
bun run --cwd apps/web build:oss
```

`typecheck` runs `tsr generate` before `tsc --noEmit`, so TanStack Router's
generated route tree stays current. The public package `test` command routes
through the Docker-backed clean runner; `test:internal` is reserved for that
runner and CI.

The clean runner also builds the hosted Vercel production bundle and executes
its server entry with auth bypass off and synthetic Clerk keys. It checks
sign-in/sign-up HTML and protected-route redirects without external requests.
Client CI runs the same `test:ssr:internal` check. This catches server chunk
initialization failures that the Vite dev-server E2E suite cannot detect.

For broader changes, run the full web test suite:

```bash
bun run --cwd apps/web test
```

`apps/web/bunfig.toml` preloads `test-setup.ts`, which sets
`VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy_for_unit_tests` when tests import the
validated env module. If you bypass that Bun config, seed
`VITE_CLERK_PUBLISHABLE_KEY` yourself.

### Official OpenClaw browser verification

Run `bash scripts/test-openclaw-native.sh` for the pinned official gateway and
Control UI in a disposable 4-CPU/4-GiB Docker container. The product scenario
checks bootstrap authentication, retained iframe/WebSocket identity across
sections, native device reuse after revisits/reload, and explicit reconnect.
The latency scenario alternates three pairs of `dashboard --help` plus
`dashboard --json` versus direct JSON after one warmup per command. It records
CLI phase durations and fresh Chromium navigation to native `hello-ok`.

This measures local official CLI/browser behavior with plugins disabled; it
does not measure a remote control plane, production ingress or customer devices.
Hosted API responses in the product scenario are fixtures. Timing output omits
issued credentials and URLs; browser traces, screenshots and video are disabled.
Do not infer latency from the number of credential requests alone.

Done: both native tests pass, each of the six latency samples reports one
owner-authorized `hello-ok`, and the runner removes its container and image.

## Route admission

Protected routes use Clerk request middleware and a Start server function calling
`auth()` for both SSR and SPA admission, with `cache-control: no-store`. This adds
a server round trip to protected navigation. Clerk's default SPA navigation is
unchanged: its session cookie is updated before navigation, while its client
session resource is published after navigation completes.

`ProtectedAuthBoundary` supplies account-data readiness without replacing the
layout. The actual dashboard frame and navigation remain visible; private page
content, account actions, notifications, prefetches, and hosted sensors wait for
the native SessionResource and live auth identity to match server admission.
SSR does not invent a browser SessionResource. Non-dashboard protected pages
keep their own layouts. Same ready identity navigation retains mounted pages,
iframes, drafts, and caches. Identity loss/change clears private regions and
resets account-owned layout state.

`AuthRouterBridge` scopes QueryClient and account-suspension observations to the
live user/session, retires protected preloads, and revalidates server admission
on settled identity changes. The initial baseline is the Router's restored
`beforeLoad` identity: matching server admission needs no extra invalidation,
while a different first browser identity or sign-out still revalidates. It does
not invalidate routes while Clerk is in its
transitive unloaded state. Token getters bind to the native SessionResource and
reject absent tokens or a changed active session instead of sending anonymous
requests or acquiring another session's credentials. Late suspension responses
and query/mutation cache callbacks retain their originating account scope.
API, Files grants, runtime, and stream authorization remain server boundaries.
An account-admission 401 offers explicit reauthentication; other failures remain
recoverable without signing the user out.

These boundaries follow Clerk's [server/client auth guidance](https://clerk.com/docs/tanstack-react-start/guides/users/reading),
[native session readiness](https://clerk.com/docs/tanstack-react-start/reference/hooks/use-session.md),
and [nullable session tokens](https://clerk.com/docs/tanstack-react-start/reference/objects/session.md).
TanStack's [route guards](https://raw.githubusercontent.com/TanStack/router/main/docs/router/guide/authenticated-routes.md)
control navigation, not API authorization. Account-scoped caches and private-region
[React keys](https://react.dev/learn/preserving-and-resetting-state) isolate business
data and drafts; they do not manage Clerk activation. The scope's conditional
[render-time state update](https://react.dev/reference/react/useState#storing-information-from-previous-renders)
prevents children from committing against the previous account's cache.
The admission query keeps [Query's `Infinity` stale time](https://raw.githubusercontent.com/TanStack/query/main/docs/framework/react/guides/important-defaults.md)
and disables focus retries after failures; API authorization remains per request.

Inside an isolated Docker browser-test environment with dependencies and
Chromium installed, run the SDK-event contract suite:

```bash
bun run --cwd apps/web e2e --config=playwright.auth.config.ts
```

Done: the lifecycle suite passes without Clerk credentials. Its simulated SDK
resource and cookie events exercise the production dashboard layout and Router, including the activation
ordering, SSR resource handover, null tokens, and late old-account responses.
They do not authenticate against a live Clerk tenant. Set
`VITE_CLAWDI_HOSTED=true` and filter to `--grep "native SPA activation"` to also
exercise hosted notifications and access sensors.

## OSS build boundary

`bun run --cwd apps/web build:oss` is defined as:

```bash
VITE_CLAWDI_HOSTED=false VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy vite build
```

That verifies the self-hosted bundle path without relying on hosted `.env`
values. It does not remove source files from the repository; it relies on
compile-time gates so OSS builds do not include hosted-only UI chunks.

The hosted boundary is documented in `apps/web/src/hosted/README.md` and
guarded by `apps/web/src/hosted/oss-clean.test.ts`. The current invariants are:

- Hosted-only components live under `apps/web/src/hosted/`.
- Hosted route entrypoints construct lazy imports only when
  `import.meta.env.VITE_CLAWDI_HOSTED === "true"`.
- Hosted product routes render through `<HostedProductGate>`.
- `posthog-js` and `@xterm/*` imports stay under hosted-only code paths.
- Hosted `.tsx` roots set `data-hosted="true"`; `hosted/v2` roots also set
  `data-v2="true"`.

In OSS builds, hosted deployment, billing, wallet, subscription, hosted-only AI
provider, hosted-only channel, terminal, control UI, and hosted analytics
surfaces must remain unreachable from the client graph.

## User-visible copy

There is no repo-wide i18n system in `apps/web` today: no translation
dependencies, locale directories, or `useTranslation` layer are present. Keep
new user-visible copy in English and colocated with the UI, matching existing
copy style. If a future change introduces an i18n system, route new product copy
through that system instead of adding another hardcoded string layer.

## Connector account management

Connector management uses the same account-wide API in the library and Agent
detail views. Show only active, enabled accounts in rows, counts, and connected-app
lists without deleting other provider records. Accounts use flat divided rows. Display aliases alongside provider identity
or a connection ID, and allow an empty alias to clear it. Alias input is bounded
to 256 characters by Clawdi, not by a documented Composio format restriction.

Use the standard OAuth or credential connection flow to add another account.
It creates a new connection; it does not repair an old connection in place.
Existing aliases remain reserved until explicitly cleared, changed, or deleted
with their account. Do not automatically remove an old account to reuse its alias.

## Generated API types

The web app imports API types from `@clawdi/shared/api`, which re-exports
`packages/shared/src/api/api.generated.ts`. Do not edit the generated file by
hand. Backend schema changes must follow the workflow in
[`backend-development.md`](backend-development.md#generated-api-client).
