# `apps/web/src/hosted/`

Components and helpers for the hosted agent service and hosted billing surfaces.
They render only in the hosted build (`NEXT_PUBLIC_CLAWDI_HOSTED=true`).

OSS users running their own Clawdi instance see none of this UI.

## Conventions

1. **Side-effect-free at module top level.**
   No top-level `new ApiClient()`, no top-level
   `process.env.NEXT_PUBLIC_DEPLOY_API_URL!` reads that throw.
   Initialize lazily inside hooks / event handlers / queries.

2. **Every component sets `data-hosted="true"` on its root element.**
   `apps/web/src/hosted/oss-clean.test.ts` statically checks that
   every hosted `.tsx` file has the marker — it's a regex grep, not
   a render test (apps/web has no jsdom setup; adding it for one
   invariant would be overkill). Tightens runtime debugging too:
   anything carrying `data-hosted="true"` in OSS DevTools is a leak.

3. **Imports from outside `hosted/` go through `next/dynamic`,
   gated on `IS_HOSTED` at the construction site.**
   ```tsx
   import dynamic from "next/dynamic";
   import { IS_HOSTED } from "@/lib/hosted";

   const DeployWizard = IS_HOSTED
     ? dynamic(() =>
         import("@/hosted/billing/deploy/deploy-wizard").then((m) => ({
           default: m.DeployWizard,
         })),
       )
     : null;

   // …

   {DeployWizard ? <DeployWizard /> : null}
   ```
   Why this shape: the bundler folds `IS_HOSTED ? … : null` at
   build time using the `NEXT_PUBLIC_CLAWDI_HOSTED` constant. In OSS
   builds the conditional collapses to `null`, the `dynamic(…)` call
   is unreachable, the `import()` site is eliminated, and the
   hosted chunk never ships. A bare `dynamic(() => import(…))` at
   module top level would still register the chunk in OSS builds —
   that's why the ternary matters.
   `oss-clean.test.ts` fails the build if anyone reintroduces a
   static `import … from "@/hosted/…"` outside the hosted/
   directory.

## What lives here today

- `use-hosted-agent-tiles.ts` — Lists the user's deployed agents on
  the v2 hosted runtime API, polled while any tile is in a transient
  state.
- `agents/` — Hosted agent detail, runtime controls, and manifest editing.
- `billing/` — Wallet, subscription, usage, and managed agent deployment.
- `posthog.ts` — Hosted-only PostHog init helpers (called from
  `apps/web/instrumentation-client.ts` through a compile-time hosted
  gate (`NEXT_PUBLIC_CLAWDI_HOSTED === "true"`) plus dynamic import).

Connector UI does not live here. Hosted and self-managed sessions both
read connectors from the shared `/api/connectors` route.
