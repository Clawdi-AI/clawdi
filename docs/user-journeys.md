# User journeys

Living archive of every path a user can take through the web app: the goal,
the entry points, the steps, what state moves where, and what guards it.
Update this file whenever a journey changes shape. Historical redesign
audits live in `docs/plans/`; this document describes the current product.

Severity legend for open gaps: 🔴 blocks · 🟡 friction · ⚪ nitpick.

## 1. First run

- **Goal**: get the first agent running.
- **Path**: `/` → empty state renders `OnboardingCard` → "Deploy on Clawdi"
  (hosted) or "Connect an agent on your machine" → `AddAgentDialog` →
  agent appears in the rail and on `/`.
- **State**: `ossIsEmptyState` gates the card; the rail hydrates from
  `/v1/agents` (10s polling, `refetchIntervalInBackground: false`).
- **Next-step hint**: with ≥1 agent and `projects_count === 0`, the
  dashboard Library card shows a one-line "create your first Project" link.
- **Guarded by**: e2e `query-refresh-no-flicker`, onboarding screenshots in
  the sidebar suite.

## 2. Find something (session / memory / skill / vault / project)

- **Path A (palette)**: Cmd/Ctrl+K → type → grouped hits
  (Sessions, Memories, Projects, Skills, Vaults) → Enter jumps to the
  hit's href. Backed by `/v1/search`; each searcher enforces the same
  scope rules as its direct route.
- **Path B (lists)**: every top-level list keeps its view in the URL via
  nuqs (`q`, `category`, `page`, `pageSize`, filters) — back/forward and
  deep links restore the exact list state.
- **Guards**: `sidebar-runtime-smoke` navigation grammar tests;
  backend search tests; `pages-smoke`.

## 3. Read a session

- **Path**: Sessions list (feed default; table one toggle away, in URL) →
  card → detail. Newest-first by default; direction toggle persists in
  localStorage (hydration-safe). Long sessions paginate messages.
- **Cross-links**: agent identity links back into the agent scope.
- **Guards**: `sessions` page e2e, session detail states in
  `sidebar-runtime-smoke`.

## 4. Share a session publicly

- **Path**: session detail → Share → visibility toggle → copy link
  (markdown/JSON variants too). Recipient: public link renders the shared
  page directly; a private URL hit anonymously renders `SignInToView`
  (sign-in returns to the same URL, then access-check again).
- **Guards**: `share-project-dialog-lifecycle`, public-share page tests.

## 5. Create and wire a Project

- **Path**: Library → Projects → New project → lands on the project hub
  (toast offers an "Open project" deep link when created from an agent
  context). Hub tabs: Overview / Skills / Vaults / Agents / Access.
- **Wiring**: add skills, attach vaults, link to agents, invite people —
  all from the hub. The `?from=` param preserves the return path.
- **Guards**: `project-detail.pw.ts` end to end.

## 6. Install or add a skill

- **Path**: Library → Skills → pick a Project first (fail-closed), then
  Add/Import; or an agent Workspace tab → Install skill. Legacy key-only
  URLs canonicalize to explicit-project URLs.
- **Guards**: skills flows in `sidebar-runtime-smoke`, `project-detail`.

## 7. Manage API keys (vault)

- **Path**: Library → Vaults → create → add keys (masked on write,
  copy/move/batch supported) → attach to Projects. "Share keys" opens the
  guided two-hop chain (attach → invite) with preselection.
- **Guards**: `vault-detail-identity`, vault flows in the sidebar suite.

## 8. Capture and recall a memory

- **Path**: Library → Memories (or an agent's Memories tab) → New memory →
  save; search + category filter; card or detail delete (ConfirmAction).
- **Note**: memories are account-wide; agent scopes show the shared pool.
- **Guards**: memories nested-navigation e2e.

## 9. Manage agents

- **Rail**: drag/keyboard reorder (optimistic, persists via
  `/v1/agents/order`), corner source badges (cloud/legacy), active marker.
- **Detail**: overview (status, sessions slot, resource summaries),
  sections (Sessions, Workspace Projects/Skills/Vaults, Shared
  Memories/Connectors), settings (rename with unsaved-change guard).
- **Health**: sync/daemon badge opens a remediation dialog with commands.
- **Guards**: rail interaction tests, overview hierarchy tests.

## 10. Invite people / accept invitations

- **Path**: project → share/invite → invitee gets a Notification Center
  item → accept lands in their Library; toasts confirm both directions.
- **Guards**: `share-project-dialog-lifecycle`, notification-center e2e.

## 11. Settings

- **Path**: sidebar user menu / palette "Settings" → dialog sections
  (general, profile, API keys, providers). URL-driven via `?settings=`.
  API-key secrets shown once, optimistic revokes reconciled.
- **Guards**: `api-keys-settings.pw.ts`.

## 12. Connectors / channels

- **Path**: Integrations → Connectors → catalog → connect (OAuth returns
  to the same page; state params clean themselves up). Hosted adds
  Channels/AI Providers.
- **Guards**: connector nested-navigation e2e; hosted channel suites.

## 13. Error and dead-end recovery

- Every list/detail has loading → content, error → `ApiErrorPanel` with
  retry, not-found → `DetailNotFound`, all with a visible exit (back link
  on every viewport for dead ends, breadcrumb otherwise).
- URL canonicalizers only fire while their page is still the navigation
  target (`useCommittedRouteIsLatestTarget`).

## 14. Mobile

- Rail collapses into a drawer; the same nav grammar applies. Touch
  targets on icon buttons bump to 44px under `pointer-coarse`.
- **Guards**: 320px variants across the sidebar suite.

## Known gaps

- 🔴 **Hosted e2e suite drift** (`playwright.hosted.config.ts`,
  `hosted-smoke.pw.ts`): as of 2026-08-07 it runs 89 pass / 39 fail.
  The failures cluster around deploy-acceptance navigation, wallet/plan
  price copy, channel-pairing semantics, and projection-state wording —
  i.e. the hosted surface evolved faster than the suite. Needs a
  dedicated repair pass before it can join CI.
- 🟡 Sessions search has no "N results" line (the pagination total is the
  only count).
- ⚪ The OSS e2e suite flakes on cold dev-server first paint under load;
  mitigated (single worker, route warm-up in `global-setup.ts`, 10s
  expect default) but not mathematically eliminated.
