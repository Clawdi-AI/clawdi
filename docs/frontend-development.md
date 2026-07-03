# Frontend development

Guide for contributors working on `apps/web/`. The web app is a TanStack Start
dashboard built with React 19, TanStack Router, Tailwind v4, shadcn/ui, TanStack
Query, Zustand, and Clerk.

## Local web loop

Install workspace dependencies from the repository root:

```bash
bun install
```

Run the backend first if you need real data. For local browser testing without
Clerk, pair the backend dev auth bypass with these web values:

```dotenv
# apps/web/.env.local
VITE_CLAWDI_API_URL=http://localhost:8000
VITE_DEV_AUTH_BYPASS=true
VITE_DEV_AUTH_TOKEN=dev-bypass
```

Then start the web app:

```bash
bun run --cwd apps/web dev
```

Open `http://localhost:3000`.

## Verification

Use the workspace package manager declared in `package.json`:

```bash
bun run --cwd apps/web typecheck
bun run --cwd apps/web test
bun run --cwd apps/web build:oss
bunx biome check apps/web/src
```

`typecheck` runs `tsr generate` before `tsc --noEmit`, so TanStack Router's
generated route tree stays current.

For targeted tests, pass the file or directory to the package script:

```bash
bun run --cwd apps/web test src/hosted/oss-clean.test.ts
bun run --cwd apps/web test src/hosted/posthog.test.ts
```

`apps/web/bunfig.toml` preloads `test-setup.ts`, which sets
`VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy_for_unit_tests` when tests import the
validated env module. If you bypass that Bun config, seed
`VITE_CLERK_PUBLISHABLE_KEY` yourself.

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

## Generated API types

The web app imports API types from `@clawdi/shared/api`, which re-exports
`packages/shared/src/api/api.generated.ts`. Do not edit the generated file by
hand. Backend schema changes must follow the workflow in
[`backend-development.md`](backend-development.md#generated-api-client).
