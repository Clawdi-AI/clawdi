# UI 2.0 — taste audit (redesign-skill + minimalist-skill rubric)

> HISTORICAL - UI taste audit from the 2026-06 redesign pass. Use
> [`../frontend-development.md`](../frontend-development.md) for current web
> verification and `apps/web/src/` for current UI state.

Surveyed 2026-06-03 against `Leonxlnx/taste-skill` (redesign-skill §Design
Audit + minimalist-skill §Protocol), on the post-B1–B8 build with full prod
data. Compliant areas omitted; findings ordered by severity.

## Round 1 — fix now

| # | Finding | Rubric | Fix |
|---|---|---|---|
| 1 | **Agent detail page is still pure CRM**: boxed section-in-tabs chrome, a sessions table whose Agent column repeats the page's own agent on every row, double date columns | "remove generic patterns", density without hierarchy | Flatten tabs (no DashboardSection chrome); sessions tab uses the human feed; redundant column gone |
| 2 | **Forms-first sections**: project hub always shows the install-skill + create-vault forms; vault detail always shows the add-key row — input boxes before content | progressive disclosure; "modals/forms for everything" inverted | Collapse each form behind a small `+` action in its section header |
| 3 | **Overview agent wall**: 15 near-identical tiles, active and dormant agents indistinguishable at a glance, no cap | "no hierarchy", equal-card monotony | Sort active-first, show 6, "Show all (N)" disclosure |
| 4 | **Feed line-length**: session feed cards stretch ~1150px — far past comfortable scanning width | constrain content to ~max-w-4xl | Cap feed width |
| 5 | Title Case stragglers: "Saved Here", "Used Here", "From Another Project", "Used Elsewhere", "Project Access", several toasts | sentence case rule | Sweep |
| 6 | **Memory category chips are all the same gray** — category carries zero visual signal | minimalist: muted pastel tags for semantic meaning | Map categories to the semantic muted pairs (fact=neutral, preference=info, pattern=success, decision=warning, context=brand) |

## Round 2 — candidates (not in this pass)

- Overview right rail: Resources card still explainer-prose-heavy; "Add
  another agent" duplicates the sidebar CTA. Candidate: collapse to compact
  counts + single CTA.
- Automated sessions (cron/heartbeat) dominate the feed — consider a quieter
  compact row style or an "automated" filter chip once there's a reliable
  signal (e.g. summary prefix heuristics are too fragile).
- Skill rows on hub show slug duplicated under identical name; trailing
  external-link icon is ambiguous — candidate: chevron + hover affordance.
- Stat tiles could take a small icon + hover arrow to read as links.
- Icon set stays lucide deliberately (handoff decision) despite both rubrics
  flagging it as the AI default — global 1.75 stroke pin is the mitigation.
- Serif display faces (minimalist §3) deliberately skipped: this is a data
  product, Geist-only keeps the Vercel-adjacent identity.

## Verified compliant

Geist + tabular-nums; warm monochrome + single orange accent; 1px hairlines,
shadows ≤0.05; radius band 6–14px, no pills on containers; hover/active/focus
states with 150ms transform/opacity; designed empty/loading/error states; no
emoji, no Lorem, no AI-cliché copy, no `window.alert`, no `100vh`, no
`z-9999`; sentence case (post-sweeps); `text-wrap: balance`; max-width
container at 96rem; semantic status tokens only.
