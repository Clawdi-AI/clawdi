# V2 Hosted Web UI Flow Audit - 2026-07-07

Scope: `apps/web/src/hosted` in this worktree, with backend contract cross-checks
against `/home/kingsley/clawdi-hosted/backend/app`. No production or
infrastructure operations were performed.

## Executive Verdict

Is the v2 hosted UI flow complete and consistent across the full user flow?
**NO.**

The normal `can_use_v2=true` path is mostly implemented: deploy wizard,
single-runtime deployment detail, terminal, provider rebind, lifecycle controls,
wallet, plans, top-up, and usage all exist and call real backend endpoints.

The launch blocker is capability modeling. The frontend has only one Cloud
Agents gate, `canUseCloudAgents`, derived directly from `/me.capabilities.can_use_v2`.
That disables both new deployment creation and existing deployment management.
The backend contract now treats these differently: create is v2-gated, but
list/get/update/delete/lifecycle/rebind/terminal are existing deployment
management paths. When rollout disables new deploys, existing users can lose the
management UI.

## Ranked Findings

### 1. BROKEN - Rollback gating hides existing Clawdi Cloud management

Flow step: Discover/gating.

The frontend maps only `can_use_v2` to `canUseCloudAgents`:

- `apps/web/src/lib/hosted-product-access-model.ts:1` defines only
  `can_use_v1` and `can_use_v2`.
- `apps/web/src/lib/hosted-product-access-model.ts:20` maps
  `can_use_v2 === true` to `canUseCloudAgents`.
- `apps/web/src/components/hosted-product-gate.tsx:18` requires
  `access.canUseCloudAgents` for hosted product routes.
- `apps/web/src/pages/dashboard/deploy/page.tsx:20` wraps the deploy route in
  `HostedProductGate`, which is correct for new deploy.
- `apps/web/src/pages/dashboard/agents/agent-detail-client.tsx:32` renders the
  hosted agent detail only when `canUseCloudAgents` is true; otherwise it falls
  back to connected-agent detail.
- `apps/web/src/pages/dashboard/agents/page.tsx:49` sets
  `hostedAgentsEnabled` from `canUseCloudAgents`; line `71` passes that as
  `showCloudDeployments`.
- `apps/web/src/hosted/agents/ownership-sensor.ts:69` disables deployment
  ownership reads when `canUseCloudAgents` is false.
- `apps/web/src/components/settings-dialog.tsx:121` hides billing settings when
  `canUseCloudAgents` is false.

Backend evidence:

- `/home/kingsley/clawdi-hosted/backend/app/v1/routes/users.py:46` resolves
  product access, but line `47` returns only `can_use_v1/can_use_v2` in `/me`.
- `/home/kingsley/clawdi-hosted/backend/app/v2/hosted/service.py:1628` creates
  deployments and line `1635` requires v2 access.
- `/home/kingsley/clawdi-hosted/backend/app/v2/hosted/service.py:1964` lists
  deployments without `_require_v2_access`.
- `/home/kingsley/clawdi-hosted/backend/app/v2/hosted/service.py:2002` gets one
  deployment without `_require_v2_access`.
- `/home/kingsley/clawdi-hosted/backend/app/v2/hosted/service.py:2021` deletes
  without `_require_v2_access`.
- `/home/kingsley/clawdi-hosted/backend/app/v2/hosted/service.py:2283` updates
  deployment runtime/name without `_require_v2_access`.
- `/home/kingsley/clawdi-hosted/backend/app/v2/hosted/service.py:2518` rebinds
  AI provider without `_require_v2_access`.

Impact: With `clawdi_v2_enabled=false`, an existing Clawdi Cloud user can be
shown v1/connected UI instead of the Clawdi Cloud deployment list/detail. They
cannot reliably start, stop, delete, rebind provider, open terminal, or manage a
Performance subscription from the web UI.

Required fix: split frontend capability semantics. For example:

- `canCreateCloudAgents` gates `/deploy`, New Agent -> Deploy, channels/provider
  creation surfaces that are only for new Cloud creation.
- `canManageCloudAgents` gates deployment list/detail, lifecycle, terminal,
  provider rebind, delete, and per-agent billing management.

If the backend contract is still only `/me.capabilities.can_use_v2`, add
separate fields or a deployments-present management grant. Then add regression
tests for "create disabled, existing management visible".

### 2. GAP - Runtime switch exists in backend but not in frontend

Flow step: Agent/deployment detail.

The backend exposes deployment runtime updates:

- `/home/kingsley/clawdi-hosted/backend/app/v2/routes.py:259` registers
  `PATCH /v2/deployments/{deployment_id}`.
- `/home/kingsley/clawdi-hosted/backend/app/v2/api_schemas.py:98` defines
  `V2UpdateDeploymentRequest`, with `runtime` at line `103`.
- `/home/kingsley/clawdi-hosted/backend/app/v2/hosted/service.py:2296` reads
  `requested_runtime`, line `2318` writes it to config, and line `2357`
  reconciles runtime infra when changed.

The web client has no matching generic deployment update method:

- `apps/web/src/hosted/billing/billing-client.ts:128` starts deployment methods
  with list/create.
- `apps/web/src/hosted/billing/billing-client.ts:143` patches per-agent
  settings only.
- `apps/web/src/hosted/billing/billing-client.ts:156` patches per-agent
  AI provider binding only.
- `apps/web/src/hosted/billing/billing-client.ts:187` deletes a deployment; the
  client returns at line `193` without a `PATCH /v2/deployments/{deployment_id}`
  wrapper.
- `apps/web/src/hosted/agents/hosted-agent-detail.tsx:1764` renders settings for
  agent settings, language/timezone, and compute settings only; there is no
  runtime switch section.

Impact: If runtime switch is part of the owner-expected flow, users cannot
perform it from the UI despite backend support. This is a product gap, not a
normal-path deploy blocker if runtime switching is intentionally hidden.

Required fix: either add a runtime switch control with loading/error/disabled
states and a `PATCH /v2/deployments/{deployment_id}` client method, or document
that runtime switching is not launch-surfaced and hide it from the flow.

### 3. GAP - Existing Playwright smoke does not cover the full hosted flow

Flow step: Cross-screen consistency and regression safety.

Current Playwright coverage is shallow:

- `apps/web/e2e/hosted-smoke.pw.ts:11` hard-codes
  `{ can_use_v1: false, can_use_v2: true }`.
- `apps/web/e2e/hosted-smoke.pw.ts:24` stubs all deploy API routes broadly, with
  only `/me`, `/v2/subscription/plans`, and `/v2/deployments` specifically
  modeled at lines `26-28`.
- `apps/web/e2e/hosted-smoke.pw.ts:64` tests the deploy wizard language select.
- `apps/web/e2e/hosted-smoke.pw.ts:83` tests command palette open.
- `apps/web/e2e/hosted-smoke.pw.ts:96` tests channel connect dialog open.

Missing browser coverage:

- `can_use_v2=false` with existing deployments still visible/manageable.
- Deploy wizard request payload for runtime XOR, compute plan, provider pool,
  primary model, and checkout path.
- Agent detail overview/console/terminal/provider/lifecycle/delete.
- Billing wallet, top-up, usage empty/loading/error.

Impact: The exact rollback regression in finding 1 would not be caught by the
current smoke tests.

Required fix: add one Playwright scenario for "new deploy disabled, existing
Cloud deployment management available" and one happy-path wizard/detail scenario
with mocked endpoints and asserted request bodies.

### 4. POLISH - Deploy route skeleton still implies a three-runtime picker

Flow step: Deploy wizard consistency.

The real wizard is now single-select over two runtimes:

- `apps/web/src/hosted/billing/deploy/deploy-wizard.tsx:275` stores one
  `HostedRuntime`.
- `apps/web/src/hosted/billing/deploy/deploy-wizard.tsx:653` renders runtime
  choice tiles.
- `apps/web/src/hosted/billing/deploy/deploy-wizard.tsx:655` selects OpenClaw.
- `apps/web/src/hosted/billing/deploy/deploy-wizard.tsx:664` selects Hermes.
- `apps/web/src/hosted/billing/deploy/deploy-request.ts:26` serializes one
  `config.runtime`; line `34` sends one top-level `runtime`.

But the route skeleton still renders three tiles for the first section:

- `apps/web/src/pages/dashboard/deploy/page.tsx:42` uses `sm:grid-cols-3`.
- `apps/web/src/pages/dashboard/deploy/page.tsx:44` renders 3 skeleton tiles.

Impact: Minor visual inconsistency during lazy loading. It does not break
submission.

Fix: make the first skeleton section two columns/two tiles.

## Flow Matrix

| Flow step | Status | Evidence |
|---|---|---|
| 1. Discover/gating | **BROKEN** | v2-off users can see v1, but existing v2 deployment management is also hidden because every Cloud deployment surface depends on `canUseCloudAgents`; see finding 1. |
| 2. Deploy wizard | **COMPLETE, with polish** | Runtime is single-select (`deploy-wizard.tsx:275`, `:655`, `:664`); request sends one runtime (`deploy-request.ts:26`, `:34`); Free/Performance compute is present (`deploy-wizard.tsx:784`); Performance checkout and Free deploy are wired (`deploy-wizard.tsx:549`, `:579`); provider pool and primary model are wired (`deploy-wizard.tsx:467`, `:494`, `:731`). Skeleton still shows three runtime tiles. |
| 3. Agent/deployment detail | **GAP** | One selected runtime detail is rendered (`agent-home.tsx:110`, `hosted-agent-detail.tsx:320`); status cards exist (`hosted-agent-detail.tsx:682`); console/watch URL exists (`hosted-agent-detail.tsx:725`, `:769`, `:822`); terminal is wired (`billing-client.ts:163`, `hosted-agent-detail.tsx:886`); provider rebind is wired (`deployment-hooks.ts:123`, `hosted-agent-detail.tsx:1226`); lifecycle/delete exists (`hosted-agent-detail.tsx:2288`, `:2351`). Runtime switch is missing from the frontend. |
| 4. Billing/wallet surfaces | **COMPLETE for normal v2-on; GAP under rollback** | Wallet calls `/v2/wallet`, ledger, top-up, auto-reload (`billing-client.ts:92`, `:95`, `:101`, `:107`); plans/checkout/portal/cancel/resume/usage are wired (`billing-client.ts:109`, `:112`, `:118`, `:120`, `:122`, `:123`); wallet loading/error/content exists (`wallet-page.tsx:34`, `:43`, `:58`); top-up validates and calls mutation (`top-up-dialog.tsx:57`, `:92`); usage loading/error/empty/content exists (`usage-page.tsx:22`, `:31`, `:55`, `:68`). Under rollback, billing settings hide with `canUseCloudAgents=false`. |
| 5. Cross-screen consistency | **GAP/POLISH** | UI mostly follows `DESIGN.md`: designed states are expected at `DESIGN.md:30`, page width at `DESIGN.md:97`, collection/card framework at `DESIGN.md:132`. Hosted roots have invariant tests (`oss-clean.test.ts:208`). Visible copy mostly says Clawdi Cloud rather than V2; internal `v2` names remain in code/tests/docs. The main consistency gap is capability semantics, not visual style. |

## Must Fix Before Launch

1. Split frontend gates for "can create new Clawdi Cloud deployments" and "can
   manage existing Clawdi Cloud deployments"; coordinate with backend `/me`
   fields if needed.
2. Ensure agent list/detail, terminal, lifecycle, provider rebind, delete, and
   per-agent billing remain visible for existing deployment owners when new
   deploy is disabled.
3. Add a regression test for rollback/off existing-deployment management.
4. Decide runtime switch product stance. If surfaced, implement the UI/client
   for `PATCH /v2/deployments/{deployment_id}`; if not surfaced, remove it from
   launch flow expectations.

## Polish / Follow-Up

1. Fix the deploy route skeleton from three runtime tiles to two.
2. Broaden Playwright smoke to assert deploy payloads, checkout redirect,
   detail lifecycle/provider/terminal states, and wallet/usage empty/error
   states.
3. Clean visible "hosted agent/deployment" copy if product wants all user-facing
   naming to say "Clawdi Cloud agent" consistently. No blocking visible "V2"
   taxonomy was found in the audited app surfaces.

## Verification

Commands run from `/home/kingsley/.paseo/worktrees/2hybfhpy/v2-ui-audit`:

```bash
bun run --cwd apps/web typecheck
VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy bun test apps/web/src/hosted apps/web/src/lib/hosted-product-access.test.ts
```

Results:

- Typecheck passed.
- Hosted Bun tests passed: 138 pass, 0 fail.
- Playwright was not run. Existing Playwright smoke was read and found to cover
  only deploy select rendering, command palette, and channel dialog open states.
