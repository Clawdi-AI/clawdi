# Cloud UI 2.0 — UX redesign: domain map, user journeys, refactor plan

Status: proposal (2026-06-03). Phase A (tokens/primitives/casing) already landed
on `cloud-ui-redesign`. This doc is the contract for Phase B — the structural,
user-centric redesign replacing the "CRM" feel.

---

## Part 1 — Domain map (the doc to remember)

### The product in one sentence

A user connects **agents** (CLI daemons on machines) that sync **sessions**;
they curate **memories**; they organize reusable **skills** and secret
**vaults** into **projects**, which they can attach to agents and share with
colleagues (viewer-only v1).

### Entities and relationships

```
User (account root)
├── AgentEnvironment ("agent") — one per (machine × agent-type)
│     ├── default Project (kind=environment, auto-created, not shareable)
│     ├── AgentProjectBinding: primary (its own project) + context (added
│     │   workspace projects, read-only) — THIS is "add project to agent"
│     ├── uploads Sessions (batch, via env-bound ApiKey)
│     └── daemon heartbeat → live/paused/errored badge
├── Project
│     ├── kind=personal  ("Global") — 1 per account, default bucket
│     ├── kind=environment — 1 per agent, managed
│     └── kind=workspace — user-created, THE shareable unit
│           ├── contains Skills (project-scoped, synced to bound agents)
│           ├── attached Vaults (M:M via VaultProjectAttachment)
│           ├── ProjectMembership (role=viewer) ← invites + share links
│           └── bound to Agents (context bindings)
├── Vault — ACCOUNT-owned secret bundle (not project-owned!)
│     ├── VaultItems (encrypted key/value)
│     └── attached to N projects → members of those projects can READ
│         (names in dashboard, values only via CLI at runtime)
├── Session — agent conversation log; private by default
│     └── SessionPermission kind=link|user|email (viewer) → /s/{id}
├── Memory — account-scoped notes w/ embedding (NOT in projects)
├── ApiKey — CLI credential; optionally bound to one agent (blast radius)
│     └── minted via DeviceAuthorization (clawdi auth login approval)
└── Connectors (Composio OAuth, account-level) / AiProviders
```

### Semantics that the UI must teach (and currently doesn't)

1. **Vaults are account-owned; projects only *borrow* them.** Sharing keys =
   attach vault → share project. Two hops users never discover alone.
2. **Agent ≠ project, but every agent *has* a project.** "Add to agent"
   actually creates a context binding. Sessions/skills land in the agent's own
   project by default.
3. **Sharing is viewer-only** and means: see skill+key *names* in dashboard,
   resolve key *values* only through the CLI at runtime.
4. **Memories and connectors are account-global** — they have nothing to do
   with projects today.

---

## Part 2 — Personas

| Persona | Job | What they need from the UI |
|---|---|---|
| **Power operator** (Marvin) | runs many agents on many machines | glance state of fleet; find any session fast; reuse skills/keys everywhere |
| **Team lead** | provision a colleague | "give Bob the Redpill creds + skills" in one motion, confident about what Bob can see |
| **Colleague / recipient** | use what was shared | understand what they received, attach it to their agent, never feel lost |
| **New user** | connect first agent | one obvious path from empty dashboard to synced session |

---

## Part 3 — User journeys (current → pain → target)

### J1. Find and share a session
- **Current**: Sessions table → filters → row → detail → "Share ▾" popover →
  toggle Public access → copy URL. (5 steps; share affordance hidden in popover;
  .md/.json only visible after toggling.)
- **Pain**: table rows aren't scannable by content; share is two layers deep.
- **Target**: feed of **session cards** (headline summary, agent avatar, day
  grouping) → card's share icon → **one Share sheet** (toggle + URL + formats
  visible immediately). 3 steps.

### J2. Capture / recall memory
- **Current**: Memories table + inline expanding add-form; provider (mem0)
  config card randomly interrupts the page; detail page per row.
- **Pain**: memories are *notes*, rendered as CRM rows; add-form has no
  boundary; provider config is plumbing shown to everyone.
- **Target**: **notes grid** (masonry cards, category chip, source agent),
  big search on top, "New memory" opens a focused modal. Provider config moves
  to Settings → Memory. Detail = side peek instead of page swap.

### J3. Create and *understand* a project
- **Current**: Projects page = 4 stacked admin lists (custom/managed/other/
  shared); detail page = 6 dense sections; "Add to agent" buried in a dialog.
- **Pain**: users can't answer "what IS this project, what's in it, who has
  it, which agents use it" at a glance.
- **Target**: **Projects = card grid** (name, kind chip, counts: skills /
  vaults / agents / people, last activity). Agent-managed projects collapse
  into a quiet secondary row ("System projects"). **Project detail = hub**:
  identity header + 4 stat tiles (Skills, Vaults, People, Agents) that anchor
  4 sections beneath; every "add X" lives in its section header.

### J4. Share a project with a colleague
- **Current**: Share dialog with 3 tabs (People / Invitations / Links) + role
  explainer panels; invite email OR link; recipient accepts via bell.
- **Pain**: three mechanisms presented as equal; explainer prose walls;
  link URL shown once then only a prefix.
- **Target**: **one Share sheet** (same component as sessions): a people list
  with an invite input on top, a link row with on/off + copy (URL always
  retrievable), one quiet line stating what "Viewer" means. Recipient gets an
  invite card in the bell AND an empty-state explainer on the project hub
  ("Sarah shared this with you — here's what you can do").

### J5. Share a vault / API keys with a colleague
- **Current (hidden!)**: Vault page → attach vault to a workspace project →
  separately share that project. Nothing connects the two steps.
- **Target**: vault card → **"Share keys"** action that runs the whole chain
  in one guided sheet: pick/create the project → confirm attach → invite the
  person. Copy explains: "Bob can use these keys with his agent; he can't
  read or edit the values here."

### J6. Add API keys manually
- **Current**: Vault page split-pane → Create Vault dialog (slug rules) →
  select vault → Add key inline form / Import dialog.
- **Pain**: split-pane breaks on mobile; slug ceremony before value entry.
- **Target**: **vault card grid** → "New vault" (name only, slug auto) → vault
  detail page (own route, not pane) with key table + prominent paste-to-import
  (textarea accepts `KEY=value` lines directly). 2 steps to first key.

### J7. Connect an agent (install CLI)
- **Current**: Add-agent dialog with two tabs (Send-to-agent prompt vs 5-step
  manual CLI); device-auth page; no completion feedback in the dialog.
- **Pain**: choice paralysis up-front; no "it worked!" moment.
- **Target**: **one wizard**: ① pick agent type (big icon cards) → ② ONE
  command to copy (the agent-prompt remains a secondary "or paste this into
  the agent" link) → ③ live "waiting for your agent…" status that flips to a
  success card (env registered + daemon live) using the existing 10s polling.
  The win moment is designed, not implied.

### J8. Install a skill that reaches an agent
- **Current**: Skills page scoped by project picker; install; toast explains
  daemon propagation. (Already flattened in Phase A.)
- **Remaining gap**: users don't see *which agents* will receive the skill.
- **Target**: scope picker shows agent chips for the selected project; install
  toast names them. Skill detail gets a "Runs on" row.

---

## Part 4 — UX refactor plan

### Principles

1. **Object-centric, not admin-centric**: every entity gets a *card* with a
   recognizable identity (icon/avatar, name, 2-3 live stats, one primary
   action). Tables remain only where data is truly a log (sessions table →
   feed cards; vault keys stay tabular).
2. **One Share model**: a single `ShareSheet` component (people + link + role
   meaning) reused for project and session; vault sharing is a guided chain on
   top of it.
3. **Progressive disclosure**: explainer prose dies; one quiet line per
   surface + a "Learn more" link. System/managed objects collapse by default.
4. **Designed win-moments**: agent connect, first share, first skill install
   each end in an explicit success state.

### Page-by-page plan (impact order)

| # | Page | Change |
|---|---|---|
| B1 | **Projects list** | card grid (counts via existing skills/vaults/envs queries); "System projects" collapsed row; New project card |
| B2 | **Project detail** | hub layout: identity header, 4 stat tiles, sectioned content, per-section add actions; "Add to agent" promoted to header |
| B3 | **Vaults** | card grid + dedicated `/vault/[slug]` detail route (kill split-pane); paste-to-import; "Share keys" guided chain |
| B4 | **Memories** | notes-style card grid + modal composer; provider config → Settings |
| B5 | **Sessions** | feed cards w/ day groups (desktop too); density toggle for power users; Share sheet |
| B6 | **Overview** | greeting header, agent fleet cards (status dot, last seen, sparkline), recent activity feed |
| B7 | **ShareSheet** | unify project + session sharing; always-retrievable link URL |
| B8 | **Connect-agent wizard** | 3-step with live success detection |

Each B-step = one reviewable commit, screenshot-verified against the live data.

### Route changes

- `+ /vault/[slug]` (vault detail page; split-pane removed)
- everything else keeps its URL — only the surfaces change.

---

## Part 5 — UI style for the card system

On top of DESIGN.md tokens (unchanged):

- **Big cards**: `rounded-xl border bg-card p-5`, hover `border-foreground/20`
  + `translate-y-[-1px]` (150ms), entire card clickable with stretched link;
  actions in a top-right quiet row.
- **Card anatomy**: identity row (icon/avatar 36-40px, name `text-base
  font-semibold tracking-tight`, kind chip) → stat row (`text-xs
  text-muted-foreground tabular-nums`, icon-led pairs) → footer (last
  activity, owner).
- **Grids**: cards `grid gap-4 sm:grid-cols-2 xl:grid-cols-3`; notes masonry
  via CSS columns; feed cards full-width `max-w-3xl`.
- **Stat tiles** (project hub): number `text-2xl font-semibold tabular-nums`,
  label `text-xs text-muted-foreground`, clickable → section anchor.
- **Greeting** (overview): `text-2xl font-semibold tracking-tight`
  "Good evening, Marvin" + one-line fleet summary; time-of-day, no emoji.
- Density stays Linear-ish *inside* cards; the page gains air *between* cards
  (`gap-4/5`, section `space-y-6`).

---

## Part 6 — Sources

Synthesized from full backend model/route survey + frontend flow survey
(2026-06-03, this branch). Entity semantics verified against
`backend/app/models/*` and `app/core/project.py`; flows traced through
`apps/web/src/app/(dashboard)/*` and `packages/cli/src/commands/auth.ts`.
