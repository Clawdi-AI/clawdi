# Frontend dependency upgrade audit (2026-07-31)

## Scope

This upgrade covers direct dependencies in `apps/web/package.json`, the root
workspace tools, and root catalog entries consumed by the web app. The
standalone `tools/openapi-typescript` environment is included in the audit
because it owns generated API client output.

CLI-only dependencies in `packages/cli` and runtime-only dependencies in
`packages/whatsapp-baileys-sidecar` are separate product surfaces and are not
part of this frontend change.

The audit used Bun 1.3.14 against the public npm registry:

```bash
bun outdated -r --force --no-cache --no-progress
bun pm view <package>@<version> --json
```

After the upgrade, the recursive workspace audit reports no outdated root or
web dependency. It only reports the explicitly out-of-scope CLI and sidecar
packages described above.

## Coupled compatibility cohorts

Registry manifests published by each package owner provide the peer metadata
below.

| Cohort | Selected versions | Registry peer evidence |
| --- | --- | --- |
| Clerk, TanStack, and React | `@clerk/tanstack-react-start` 1.4.25, `@tanstack/react-start` 1.168.34, `@tanstack/react-router` 1.170.18, React and React DOM 19.2.8 | Clerk accepts React/DOM `~19.2.3` and TanStack Start/Router `^1.157.0`; React DOM requires React `^19.2.8`; TanStack Start accepts React/DOM 18 or 19 and Vite `>=7.0.0`. |
| React types | `@types/react` 19.2.18, `@types/react-dom` 19.2.4 | React DOM types require React types `^19.2.0`. |
| Stripe browser SDKs | `@stripe/react-stripe-js` 6.8.0, `@stripe/stripe-js` 9.12.1 | React Stripe requires Stripe.js `>=9.5.0 <10.0.0` and React/DOM `>=16.8.0 <20.0.0`. |
| Vite and React plugin | Vite 8.2.0, `@vitejs/plugin-react` 6.0.5 | The React plugin requires Vite `^8.0.0`. |
| Tailwind | `tailwindcss`, `@tailwindcss/postcss`, and `@tailwindcss/vite` 4.3.3 | The Vite adapter accepts Vite `^5.2.0 || ^6 || ^7 || ^8`. |

No override, resolution, or package patch was added for these upgrades. The
repository's pre-existing security overrides were not changed.

## Non-stable or non-latest-looking selections

### Nitro 3 beta is the registry latest release

`bun pm view nitro dist-tags --json` returned:

```json
{
  "latest": "3.0.260610-beta"
}
```

The `nitro@3.0.260610-beta` manifest declares Vite `^7 || ^8`, so it is
compatible with Vite 8.2.0. The web app therefore keeps
`^3.0.260610-beta`; there is no stable release to upgrade to and no downgrade.

### The generated-client tool remains on TypeScript 5.9.3

The standalone generator already uses the latest `openapi-typescript`, 7.13.0.
Its published manifest declares this peer range:

```json
{
  "typescript": "^5.x"
}
```

The public registry reports TypeScript 7.0.2 as `latest`, while
`bun pm view typescript@5 version --json` returns 5.9.3. Therefore
`tools/openapi-typescript/package.json` intentionally remains on TypeScript
5.9.3, the latest officially peer-compatible release. Moving that isolated
tool to TypeScript 7 would violate the current generator contract.
