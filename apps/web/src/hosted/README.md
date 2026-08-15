# `apps/web/src/hosted/`

Components and helpers for the hosted agent service and hosted billing surfaces.
They render only in the hosted build (`VITE_CLAWDI_HOSTED=true`).

OSS users running their own Clawdi instance see none of this UI.
Hosted-only rollout names such as v1/v2 stay under this directory; the OSS
dashboard should not grow public v1/v2 product concepts.

## Conventions

1. **Side-effect-free at module top level.**
   No top-level `new ApiClient()`, no top-level
   `VITE_CLAWDI_DEPLOY_API_URL!` reads that throw.
   Initialize lazily inside hooks / event handlers / queries.

2. **Every component sets `data-hosted="true"` on its root element.**
   `apps/web/src/hosted/oss-clean.test.ts` statically checks that
   every hosted `.tsx` file has the marker — it's a regex grep, not
   a render test (apps/web has no jsdom setup; adding it for one
   invariant would be overkill). Tightens runtime debugging too:
   anything carrying `data-hosted="true"` in OSS DevTools is a leak.

3. **UI imports from outside `hosted/` use `React.lazy`, gated on a local
   `IS_HOSTED_BUILD` constant at the construction site.**
   ```tsx
   import { lazy, Suspense } from "react";

   const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

   const DeployWizard = IS_HOSTED_BUILD
     ? lazy(() =>
         import("@/hosted/billing/deploy/deploy-wizard").then((m) => ({
           default: m.DeployWizard,
         })),
       )
     : null;

   // …

   {DeployWizard ? (
     <Suspense fallback={null}>
       <DeployWizard />
     </Suspense>
   ) : null}
   ```
   Why this shape: Vite folds `IS_HOSTED ? … : null` at build time
   using the `VITE_CLAWDI_HOSTED` constant. In OSS builds the
   conditional collapses to `null`, so the dynamic import site is not
   part of the client graph. A bare `lazy(() => import(…))` at
   module top level would still register the chunk in OSS builds —
   that's why the ternary matters. `oss-clean.test.ts` fails the build
   if anyone reintroduces a static `import … from "@/hosted/…"` outside
   the hosted/ directory. Hosted product routes use the shared inert
   `HostedProductRoute` composition shell, which loads the access gate first;
   denied users never load the product page chunk.

4. **The pre-telemetry Wallet return bootstrap is the narrow non-UI
   exception.** It uses the same compile-time ternary with a dynamic importer,
   and only imports the hosted lifecycle when return parameters are present.
   Shared code owns synchronous URL scrubbing and server response security
   headers; parsing, validation, pending state, and Stripe coordination stay in
   `hosted/billing/wallet/stripe-return.ts`.

Outside this directory, shared code may retain only compile-time composition
points, inert context/projection contracts required by the stable shell, generic
loading/layout fallbacks, and security policy that must run before telemetry.

## What lives here today

- `use-hosted-agent-tiles.ts` — Lists the user's deployed agents on
  the Cloud deploy API, polled while any tile is in a transient
  state.
- `agents/` — Hosted agent detail, runtime controls, and AI-provider configuration.
- `billing/` — Wallet, subscription, usage, and managed agent deployment.
- `access/` — Deploy API access query/model/request logic, the hosted access
  sensor, legacy dashboard URL resolution, and the per-user product gate. The
  shared shell receives only a stable inert projection through context.
- `v2/` — Hosted-only Cloud capabilities such as channel management and AI
  provider configuration.
- `analytics-client.tsx` and `analytics-identity.logic.ts` — Hosted-only
  analytics identity bridge and implementation.
- `posthog.ts` — Hosted-only PostHog init helpers (called from
  `apps/web/instrumentation-client.ts` through a compile-time hosted
  gate (`VITE_CLAWDI_HOSTED === "true"`) plus dynamic import).
- `mava.ts` and `mava-live-chat-menu-item.tsx` — Hosted-only authenticated-user
  identity and Live chat bridge for the Mava SDK loaded and configured by the
  hosted deployment. They never load or configure the SDK.
- `agents/hosted-terminal.css` — xterm CSS loaded only with the hosted terminal
  chunk.

Connector UI does not live here. Hosted and connected sessions both
read connectors from the shared `/v1/connectors` route.
