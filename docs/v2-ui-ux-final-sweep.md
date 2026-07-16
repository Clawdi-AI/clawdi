# V2 Hosted (Clawdi Cloud) UI/UX Final Sweep — 2026-07-07

Final exhaustive UI/UX review of the Clawdi Cloud (v2 hosted) surfaces on latest
`main` (`c0559fb5`), ahead of the gated-beta launch. This is a fresh, no-surface-
presumed-reviewed sweep: recent merges (#329–#332) changed user-facing surfaces
after the last full visual pass.

- **Method:** the web app was run locally in hosted mode (`VITE_CLAWDI_HOSTED=true`,
  dev-auth-bypass) and driven with Playwright against **stubbed** deploy-api
  (`/v2`, `/me`) and cloud-api (`/v1`) responses — the same host-stub pattern as
  `apps/web/e2e/hosted-smoke.pw.ts` — so every surface and state (empty, loading,
  error, populated, gated) renders deterministically. 40 surfaces × light+dark
  captured. Screenshots live at `~/clawdi-ui-screenshots/v2-final-sweep/`
  (referenced by filename below; **not committed** per repo policy).
- **Contract:** `DESIGN.md` (Collections section is binding). Code cross-checks in
  `apps/web/src/hosted/**`.
- **Constraints honoured:** read-only review, no redesign/fixes committed, no
  production or live-cluster operations, local dev only, no secrets in this report.

## Executive Verdict

**Ship-ready for gated beta, with fast-follows. No launch-blockers found.**

Every required user intent has a complete, discoverable, honest path. The deploy
wizard's channel step is correctly reframed to "deploy first, then link"
(#331), the managed default reads `gpt-5.5`, gating behaves correctly across all
three personas (v2 user / no-v2-with-deployment / no-v2-clean), and the two list
surfaces that matter most for the redesign (Channels, Model Providers) are fully
on the collection framework. No `window.alert`, `Oops!`, bare full-page spinners,
raw palette colors, hex, `shadow-md`+, or `rounded-full` containers were found on
any hosted surface.

The residual issues are quality/polish, led by one **systemic cosmetic defect**
(a Base UI `Select` label regression leaking internal ids/sentinels to users on
several v2 surfaces) and one **correctness risk worth verifying** (the #696
managed-rebind may leave the AI tab showing stale "Bound" BYOK providers until a
manual reload).

## Per-surface verdict

| Surface | Verdict | Notes |
|---|---|---|
| Deploy wizard — Free (direct create) | **OK** | Managed default `gpt-5.5`; free-slot-used → auto-Performance; plans-error state designed. |
| Deploy wizard — Performance (Stripe hand-off) | **OK** | Term switcher, per-agent subscription copy; checkout redirect via `action_url`/`checkout_url`. |
| Deploy wizard — channel step removal (#331) | **OK** | Credential inputs gone; reframed to "Channels · optional / Link after deploy" with correct copy. No stale "set up at deploy" copy anywhere. |
| Deploy wizard — model/provider (managed/BYOK/multi) | **ISSUE (fast-follow)** | `Select` shows `__managed__` raw sentinel (F1). Otherwise correct: managed=wallet, BYOK, multi-provider, custom model id. |
| Agent detail — OpenClaw (overview/console/terminal/sessions/skills/ai/channels/settings) | **OK** | Dashboard link `Open OpenClaw Control UI` (token in href only); lifecycle status-gated; designed empty/loading/error. |
| Agent detail — Hermes | **OK** | `Open Hermes Dashboard`; single-runtime (no switcher, correct). |
| Agent detail — AI tab / rebind (#696) | **ISSUE (fast-follow)** | Possible stale "Bound" pool after managed rebind (F2); `Select` shows raw provider id (F1); "Claude models" copy vs `gpt-5.5` default (F7). |
| Agent detail — lifecycle actions | **ISSUE (polish)** | Restart confirms on Overview but not in Settings (F6). Stop/Delete confirms present and correct. |
| Terminal / Codex add-on | **OK (observe)** | Terminal is a real shell (ttyd), designed disconnected/error states. Codex is surfaced as an **AI provider** (ChatGPT OAuth), not a terminal add-on — confirm this matches the intended gated-beta model (F16). |
| Channels — post-deploy native linking | **OK** | Discoverable from the agent's **Channel Links** tab; gated behind provisioning; connect + link flows complete, not dead-ended. |
| Channels — global `/channels` | **OK** | Exemplary collection framework (FilterChips, SectionLabels, semantic health badges, EmptyStates). |
| Channels — agent-detail tab consistency | **ISSUE (polish)** | Hand-rolls header/rows instead of SectionLabel/EntityCard (F8); Console empty-state mis-points to channels (F5); HealthTab raw JSON dump (F9). |
| AI providers — list/create/edit/delete | **OK** | Full framework; managed default vs BYOK; `modelPlaceholder` = `gpt-5.5`; Codex "Sign in with ChatGPT" flow. `Select` auth shows `api_key` raw (F1). |
| Wallet — balance/top-up/ledger/auto-reload/x402 | **OK** | USD hero + credits; inline Stripe Elements top-up; designed states. Minor: ledger "usage" lowercase (F12); auto-reload min-hint styling (F14). |
| Usage summary (B3) | **ISSUE (fast-follow)** | Shows literal `period_start–period_end` window (honest), but totals read as cumulative and the chart aria-label asserts a `by_day == total` equality that the backend may not satisfy (F3). |
| Subscription / "Compute" plan page | **OK** | Model-accurate (one-compute-one-agent, per-agent Performance sub, BYOK bypass). "TEE" jargon on Free card (F11); `billing-plan`→"Compute" id/title drift (F10). |
| Upgrade Free→Performance | **OK** | Plan page routes to `/deploy`; real Stripe checkout happens in the wizard. |
| Checkout cancel/return | **ISSUE (fast-follow)** | Success inferred from deployment marker; **no cancel-specific state** — a canceled return shows the same generic "status refreshed" toast (F4). |
| Gating — no-`can_use_v2` (with existing deployment) | **OK** | Existing Cloud management preserved (#329); Channels/Model Providers nav hidden; `/deploy` redirects to dashboard. |
| Gating — no-`can_use_v2` (clean) | **OK** | No cloud surfaces; connected-agent onboarding shown. |
| Empty states (deployments/providers/channels/wallet/usage) | **OK** | All use `EmptyState` with a getting-started action; no bare placeholders. |
| Error states (deploy/providers/channels/wallet 5xx) | **OK** | All route to `ApiErrorPanel` with retry; no bare spinners or raw errors. |
| Light + dark theming | **OK** | Dark is charcoal (not pure black), warm-gray hairlines, single orange accent preserved. |

## UX-completeness matrix

Every required user intent → is there a complete, discoverable path?

| User intent | Complete? | Discoverable? | Evidence |
|---|---|---|---|
| Deploy a Free agent (direct create) | Yes | Yes | `01-deploy-free-default`; `deploy-wizard.tsx:571-586` |
| Deploy a Performance agent (Stripe checkout) | Yes | Yes | `02-deploy-performance`; `deploy-wizard.tsx:547-568` |
| Choose managed model (default `gpt-5.5`) | Yes | Yes | `01`; `model-binding.ts:10` |
| Use BYOK / multi-provider at deploy | Yes | Yes | `03-deploy-byok-providers`; `deploy-wizard.tsx:465-515` |
| Understand "link channel after deploy" | Yes | Yes | `01` (Channels · optional); `deploy-wizard.tsx:743-775` |
| Open OpenClaw dashboard | Yes | Yes | `20-agent-openclaw-overview`; `runtimes.ts:59-65` |
| Open Hermes dashboard | Yes | Yes | `21-agent-hermes-overview` |
| Stop / start / restart / delete an agent | Yes | Yes | `20-...-settings`; `deployment-status.ts:139-188` |
| Open a real terminal shell | Yes | Yes | `20-...-terminal`; `hosted-terminal-panel.tsx` |
| Link a native channel to a deployed agent | Yes | Yes | `20-...-channels`; agent **Channel Links** tab |
| Connect a new bot (Telegram/Discord/WhatsApp) | Yes | Yes | `32-channels-connect-dialog` |
| Create / edit / delete an AI provider | Yes | Yes | `41-aiproviders-populated`, `42-...-add-dialog` |
| Rebind agent BYOK↔managed | Yes (see F2) | Yes | `21-agent-hermes-ai`; `hosted-agent-detail.tsx:1226-1285` |
| Top up wallet | Yes | Yes | `50-wallet`; inline Stripe Elements |
| See balance / usage | Yes | Partial | Wallet+Usage live only in the Settings dialog / command palette — **no direct sidebar nav** (F13-adjacent) |
| Upgrade Free→Performance | Yes | Yes | `56-subscription-plan` → `/deploy` |
| Recover from a canceled checkout | **Partial** | Partial | No cancel-specific copy (F4) |
| Manage existing Cloud agent without `can_use_v2` | Yes | Yes | `60-gating-nov2-with-deployment` (#329) |
| Be blocked from new deploys without `can_use_v2` | Yes | Yes | `61-gating-nov2-deploy-route` (redirects to dashboard) |

## Ranked findings

Severity: **launch-blocker** > **fast-follow** > **polish**.

### F1 — `Select` trigger leaks the raw value instead of the label (systemic) — fast-follow

`apps/web/src/components/ui/select.tsx:20-28` wraps Base UI `Select.Value` with no
`children` render function, and no call site passes an `items` map to
`Select.Root`. Base UI's `Select.Value` resolves the display label from the
`Root`'s `items`/registered items (`@base-ui/react` `SelectValue.js:48-58` →
`resolveSelectedLabel(value, items, itemToStringLabel)`); with none provided, the
collapsed trigger renders the **raw selected value** on initial render whenever
the value differs from the visible option text. Confirmed on four v2 surfaces:

- Deploy wizard → Primary provider shows **`__managed__`** (`01`, `03`) — worst
  case: an internal sentinel on the primary deploy surface.
- Agent AI tab → Primary provider shows **`my-openai`** (raw provider_id) (`21-agent-hermes-ai`).
- Settings → Language shows **`default`** (lowercase) instead of "Default" (`20-...-settings`).
- Add-provider → Authentication shows **`api_key`** instead of "API key" (`42-...-add-dialog`).

Proposed fix: pass an `items` value→label map to `Select.Root` (the official
shadcn-for-Base-UI pattern), or give `SelectValue` a `children` function at the
affected call sites. Cosmetic (selects function correctly) but reads as unfinished
on core flows.

### F2 — Managed rebind (#696) can leave stale "Bound" BYOK providers in the AI tab — fast-follow (verify)

`hosted-agent-detail.tsx:1226-1285` builds the rebind body correctly (managed-only →
`provider_ids: ["clawdi-v2"]`, `auth_kind: "managed"`, no bootstrap), but
`useSetAgentAiProvider` (`deployment-hooks.ts:124-143`) only calls
`invalidateDeploymentSnapshots` once on success — unlike `useDeploymentLifecycle`
and `useSetAgentLanguageTimezone`, it does **not** schedule a settling refresh.
Deployments only background-poll while status is transitional
(`hooks.ts` → `shouldPollDeployments`), and a live rebind keeps the agent
`running`. The tab derives the pool from `config_info.ai_provider_bindings[runtime]`
(`:1123`). If that binding is eventually-consistent — which the "Updating the
runtime…" copy implies — the single immediate refetch can read the pre-rebind
binding and then never re-poll, so the cleared BYOK providers keep showing as
**Bound** until the user navigates away and back. This directly contradicts #696's
cleared-pool intent and the "applies live — no restart" promise. Verify backend
settle timing; if non-instant, add a `scheduleDeploymentSettlingRefresh` to the
rebind mutation.

### F3 — Usage totals vs "reporting window" vs chart don't reconcile (B3) — fast-follow

`usage/usage-page.tsx` renders the literal `period_start – period_end` as a
"reporting window" (honest; it does **not** falsely say "this month"). But: (a) the
totals cards are labeled "AI Credits used" / "Requests" from `total_credits` /
`total_requests` (the `total_*` prefix reads cumulative), (b) the static copy
"Wallet credits do not reset" reinforces a lifetime framing, and (c) the chart
aria-label (`:50`) hard-asserts that the `by_day` series **sums to** `total_credits`.
In the captured state (`54-usage`) the header says "Jul 1 – Jul 31" while the daily
chart spans only the 14 returned `by_day` points — window, chart span, and total
visibly fail to reconcile, and the repo's own `mock_deploy_api.py` returns a
`total` that doesn't equal its `by_day` sum. If the backend ever fills `total_*`
with lifetime figures, the aria-label becomes a false equality claim and sighted
users see bars that don't add up to the stated total. Fix on the frontend:
scope/relabel the totals to the window (or label them "all-time" and separate the
window total), make the chart span the stated window, and stop asserting
`by_day == total` in the aria-label.

### F4 — No canceled-checkout state; success is inferred — fast-follow

Checkout return handling (`hooks.ts:40-64`, consumed by `deploy-wizard.tsx:332-349`)
recognizes success markers (`session_id`, `deployment_id`, …) and, absent a
deployment id, falls back to a neutral toast "Checkout status refreshed / We
checked your deployments, subscription, and wallet." There is **no** parsing of a
Stripe `cancel_url` return and **no** explicit success confirmation. A user who
cancels the Stripe hand-off and returns sees the same generic message (or nothing)
as a partial success — no "Payment canceled / you weren't charged" copy exists
anywhere in the billing surfaces. Add an explicit cancel return state and a
positive success confirmation.

### F5 — Console "No Runtime UI URL yet" points users to link a channel — polish

`hosted-agent-detail.tsx:757-762`: when a running runtime hasn't published its
browser-UI endpoint, the empty state says "…Reach it by linking a channel from
Channels." Linking a channel has nothing to do with the runtime's browser-UI
endpoint; this conflates two unrelated features and sends users down the wrong
path. Rewrite (e.g. "The runtime hasn't published its browser UI yet — check back
shortly or open the Terminal.").

### F6 — Restart action confirms in one place, not the other — polish

Overview's `RestartComputeAction` (`hosted-agent-detail.tsx:259-285`) shows a
confirm dialog ("Restart compute?"), but the Settings → Lifecycle **Restart**
button (`:2293-2307`) fires immediately with no confirm. Same action, two
behaviors. Pick one (Stop and Delete already confirm consistently).

### F7 — "Claude models" managed copy vs `gpt-5.5` default — polish

Agent AI-tab managed card reads "Clawdi-managed **Claude** models, billed from your
wallet" (`hosted-agent-detail.tsx:1306`), but the managed default primary model is
`gpt-5.5` (`model-binding.ts:10`, `openai_chat` api_mode). The global providers
page's managed card avoids this ("No setup required · Wallet billed",
`41-aiproviders-populated`). Either the copy or the default model is wrong —
confirm with product and align.

### F8 — Agent-detail Channels tab off the collection framework — polish

The agent's **Channel Links** tab (`hosted-agent-detail.tsx:1513-1760`) hand-rolls
`<div className="text-sm font-medium">Linked channels</div>` and a bare
`rounded-lg border p-3` row instead of `SectionLabel` + `ENTITY_CARD_BASE`, unlike
the polished global `/channels` surface. It does correctly use `EmptyState`,
`ApiErrorPanel`, `Skeleton`, and `TokenReveal` (`20-agent-openclaw-channels`), so
this is a consistency gap, not a functional one.

### F9 — HealthTab renders a raw JSON dump — polish

`channel-detail-page.tsx:1001-1008` renders `native_transport` as
`<pre>{JSON.stringify(...)}</pre>` — dev-grade UI on a product surface. Format it
into labeled fields or hide it behind a "details" affordance.

### F10 — Vocabulary / naming drift — polish

Same concepts have multiple names: "Channels" vs route label "Channel Links"
(`agent-routes.ts:54`) vs nav-meta "Messaging links" (`hosted-agent-detail.tsx:219`);
settings section id `billing-plan` vs page title "Compute"; runtime UI labels
asymmetric ("OpenClaw Control UI" vs "Hermes Dashboard"); and "compute" /
"hosted agent" / "deployment" / "agent" used interchangeably across settings and
lifecycle copy. Pick canonical terms.

### F11 — "TEE" jargon on the Free plan card — polish

`plan-comparison.tsx` Free card lists "Always-on hosted runtime + TEE" (`56-subscription-plan`).
TEE (Trusted Execution Environment) is internal infra jargon and, per the product's
own framing, incidental rather than a user-facing selling point. Drop it or restate
in user terms.

### F12 — Ledger "usage" operation renders lowercase raw — polish

Wallet activity table (`50-wallet`) shows "usage" (lowercase) next to Title-Cased
"Top-up" — the operation-label map (`ledger-table.tsx:35-46`) misses the raw
`usage` operation. Add the mapping ("Usage").

### F13 — "Sync pending" on a running Cloud agent — polish (verify)

Agent tiles and the overview status tile show "Sync pending" beneath a Running
hosted agent (`11-agents-populated`, `20-agent-openclaw-overview`). This is the
local-daemon sync status (`daemon-status.tsx:170-174`) bleeding onto pure-cloud
agents, where it reads as "not fully set up" despite the agent running. Confirm
the intended copy for cloud-only agents (e.g. suppress or relabel).

### F14 — Auto-reload min-hint styling on a valid value — polish (verify)

Wallet auto-reload shows "Minimum $1." under a valid `$5` "When below" input
(`50-wallet`), in error-ish styling. Verify whether the hint is always shown vs
only on invalid input; if always-on, mute it so it doesn't read as an active error.

### F15 — Dev-mode hydration warnings on nav active-state — polish (verify)

The dev server logs React hydration mismatch warnings on the sidebar active-link
state (`data-status`/`aria-current`). These are dev-only and did not produce any
user-visible error, but confirm they don't surface in the prod `build:oss` output.

### F16 — Codex is modeled as an AI provider, not a terminal add-on — observe

The terminal is a generic shell; Codex is surfaced as a BYOK AI provider ("Sign in
with ChatGPT", provider id `openai-codex`) in the AI tab, and legacy Codex-as-runtime
is explicitly filtered out. If the intended gated-beta model is Codex-as-provider,
the UI is self-consistent; if a distinct "Codex terminal add-on" is expected, it is
not built. Confirm intent — no code change implied if provider-model is intended.

## What was verified clean (no action)

- Deploy channel-credential step **removed** (#331); reframed copy correct; no
  stale "set up channel at deploy" strings exist (grep-clean across the codebase).
- Managed default model = `gpt-5.5` (`model-binding.ts:10`, tested).
- Gating (`cloudDeploymentManagementGate`, #329) correct for all three personas.
- Single-runtime model (OpenClaw XOR Hermes) enforced; no half-built runtime switch.
- Dashboard-link tokens never rendered as text (href/iframe `src` only).
- Collection framework used on `/channels` and Model Providers (ListToolbar,
  SectionLabel, FilterChip, ApiErrorPanel, EmptyState, entity/hero cards).
- No banned patterns: emoji-as-UI-icon, `window.alert`, "Oops!"/exclamation error
  copy, bare full-page spinners, raw palette color classes, hex-in-tsx,
  `shadow-md`+, `rounded-full` containers, `h-screen`/`100vh`.
- Light + dark both first-class; dark is charcoal, warm-gray axis, single accent.

## Method notes / limitations

- Backends were stubbed at the HTTP host boundary; runtime browser-UI iframes and
  the terminal WebSocket point at fixture URLs and therefore render their
  disconnected/empty chrome (expected — the surrounding UI is what was reviewed).
- Cloud env ids must be UUIDs (`agent-identity.ts:13`); fixtures use UUIDs so the
  provisioning-gated tabs resolve correctly.
- The only browser console errors observed were the intentional 5xx error-state
  fixtures and the fixture terminal WebSocket failure. B3's backend-side scoping of
  `total_*` cannot be confirmed from this repo (frontend-only); F3 characterizes the
  frontend labeling risk.
