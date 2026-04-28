# `apps/web/src/hosted/`

Components and helpers that render only on the hosted instance
(`cloud.clawdi.ai`, where `NEXT_PUBLIC_CLAWDI_HOSTED=true`).

OSS users running their own clawdi-cloud see none of this UI.

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

   const DeployTrigger = IS_HOSTED
     ? dynamic(() =>
         import("@/hosted/deploy-trigger").then((m) => ({ default: m.DeployTrigger })),
       )
     : null;

   // …

   {DeployTrigger ? <DeployTrigger /> : null}
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

- `clawdi-api.ts` — Typed cross-origin client for clawdi.ai's deploy
  API (port 50021), keyed off the user's Clerk JWT.
- `use-hosted-agent-tiles.ts` — Lists the user's deployed agents on
  clawdi.ai, polled while any tile is in a transient state.
- `deploy-trigger.tsx` — Sidebar entry that opens the Deploy flow.

The connector flow used to live here too (`use-hosted-connectors.ts`)
but was removed once cloud-api adopted Clerk-id-based Composio
entities — both deploy modes now read connectors from the same
`/api/connectors` route. See `docs/plans/cloud-clawdi-integration.md`
for the migration rationale.

Future additions (later phases, not yet built):

- `welcome-card.tsx` — First-day onboarding card with starter skills
  preview
- `deploy-agent-dialog.tsx` — In-app Deploy dialog
