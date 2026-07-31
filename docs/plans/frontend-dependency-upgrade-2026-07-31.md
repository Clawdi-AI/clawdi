# Frontend dependency upgrade audit (2026-07-31)

## Scope

This upgrade covers direct dependencies in `apps/web/package.json`, root
workspace tools, and root catalog entries consumed by the web app. CLI-only
and WhatsApp sidecar dependency upgrades are out of scope. The Biome upgrade's
deterministic formatting changes are included so the repository-wide check
continues to pass.

The audit used Bun 1.3.14 and package-owner manifests from the public npm
registry:

```bash
bun outdated -r --force --no-cache --no-progress
npm view <package>@<version> version dist-tags peerDependencies peerDependenciesMeta engines --json
```

The app does not currently declare assistant-ui or i18n packages. This change
does not introduce a new runtime or translation architecture merely to create
an upgrade cohort.

## Compatibility cohorts

| Cohort | Selected versions | Published peer evidence |
| --- | --- | --- |
| Clerk, TanStack, React | `@clerk/tanstack-react-start` 1.4.26, `@tanstack/react-start` 1.168.34, `@tanstack/react-router` 1.170.18, React and React DOM 19.2.8 | Clerk accepts React/DOM `~19.2.3` and TanStack Start/Router `^1.157.0`; React DOM requires React `^19.2.8`; TanStack Start accepts React/DOM 18 or 19 and Vite `>=7.0.0`. |
| React types | `@types/react` 19.2.18, `@types/react-dom` 19.2.4 | React DOM types require React types `^19.2.0`. |
| Stripe browser SDKs | `@stripe/react-stripe-js` 6.8.0, `@stripe/stripe-js` 9.12.1 | React Stripe requires Stripe.js `>=9.5.0 <10.0.0` and React/DOM `>=16.8.0 <20.0.0`. |
| Vite | Vite 8.2.0, `@vitejs/plugin-react` 6.0.5 | The React plugin requires Vite `^8.0.0`. |
| Tailwind | `tailwindcss`, `@tailwindcss/postcss`, and `@tailwindcss/vite` 4.3.3 | The Vite adapter accepts Vite `^5.2.0 || ^6 || ^7 || ^8`. |

No override, resolution, package patch, compatibility shim, or generated type
projection is added. Existing security overrides remain unchanged.

## Intentional selections

`nitro@3.0.260610-beta` remains selected because npm's `latest` dist-tag is
exactly `3.0.260610-beta`; its published peer range accepts Vite `^7 || ^8`.

The isolated `tools/openapi-typescript` environment remains on
`openapi-typescript@7.13.0` and TypeScript 5.9.3. The generator publishes the
peer range `typescript:^5.x`, and 5.9.3 is the latest TypeScript 5 release.
The workspace compiler remains on the existing TypeScript 7.0.2; it does not
replace the isolated generator compiler.

## Generated clients

Neither generator dependency changed. The backend drift check generates into a
temporary path from the local FastAPI schema, and the deploy drift check
generates into a temporary path from its configured schema. Generated clients
must not be overwritten from an older live schema to manufacture a clean
check.
