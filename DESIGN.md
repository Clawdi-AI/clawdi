# Clawdi Cloud design system (UI 2.0)

Linear/Vercel-style: dense, crisp, **light-first**, monochrome warm-gray with
**one accent — Clawdi orange**. Tokens live in
`packages/shared/src/style/theme.css`; this file is the contract for how to
use them. When a PR and this document disagree, fix one of them.

## Principles

1. **One accent.** Orange (`--primary`) is the only saturated brand color.
   Status colors are muted semantic tokens — never raw palette utilities
   (`green-500`, `amber-400`, …) and never hex in components.
2. **Hierarchy from type and hairlines, not boxes.** Prefer a heading +
   1px `border-border` separator over a nested card. Card-in-card is a smell.
   **Objects get cards; only logs and settings get rows.** Projects, vaults,
   skills, memories, keys render as (compact) cards in responsive grids;
   tables/rows are reserved for time-ordered logs (sessions table view) and
   configuration lists.
3. **Dense but breathing.** This is a data product: Linear density, not
   marketing whitespace. Tables and lists earn their vertical space.
4. **Shadows are near-nonexistent.** `shadow-xs`/`shadow-sm` only (≤0.05
   tinted opacity). `shadow-md` and up are banned in app UI.
5. **Clear casing rules.** Page titles use Title Case. Dialog titles use
   sentence case. ALL-CAPS is reserved for tiny `text-2xs tracking-wider`
   meta labels.
6. **No pills on containers.** Radius band is 6–14px (`rounded-sm` … `rounded-xl`).
   `rounded-full` is allowed only for avatars, status dots, and tiny count badges.
7. **Never break the data.** Numbers, IDs, hashes, paths: `font-mono` or
   `tabular-nums`. A count that jiggles on update is a bug.
8. **Designed states.** Skeletons shaped like the real content; empty states
   with one getting-started action; inline errors with retry. No bare
   spinners on whole pages, no `window.alert`, no "Oops!", no exclamation
   marks, active voice.
9. **Emoji are object avatars, not UI icons.** Controls and nav use lucide
   only (central re-export pins size/stroke). But every *object* the user
   owns — project, vault — wears a deterministic emoji + vivid identity
   color (`lib/identity.ts`), so a hundred objects never share one folder
   icon. Identity tiles are the sanctioned splash of color on cards.

## Tokens

### Surfaces (light)

| Token | Value | Use |
|---|---|---|
| `--background` | near-white, faint warm tint | page |
| `--card` / `--popover` | surface white | cards, menus — lift via `border`, not shadow |
| `--muted` / `--secondary` | warm gray 95.5% | inset wells, secondary buttons |
| `--accent` | warm gray 94.5% | hover/selected backgrounds |
| `--border` | warm gray 91% | hairlines everywhere |
| `--input` | warm gray 87% | form-control borders |

Dark mirrors the same scale on charcoal (`--background` ≈ 17.5% L, never pure
black). Both themes share the warm-gray axis (OKLCH hue ~95, chroma ≤ 0.006).

### Status

Each semantic has a solid + `*-foreground` pair (filled chips/dots) and a
`*-muted` + `*-muted-foreground` pair (tinted chips, banners, inline text):

- `success` — live/connected/synced
- `warning` — degraded/errored-but-recoverable/attention
- `destructive` — failures, destructive actions (it is a real red now)
- `info` — neutral notices

Use via Tailwind: `bg-success-muted text-success-muted-foreground`,
`bg-destructive text-destructive-foreground`, etc. The `StatusBadge`
primitive (Phase 2) wraps the common cases — prefer it over hand-rolled chips.

### Radius

`--radius: 0.625rem` → `rounded-sm` 6px (badges, kbd), `rounded-md` 8px
(buttons, inputs), `rounded-lg` 10px (cards), `rounded-xl` 14px (modals,
top-level shells).

### Type scale

Geist Sans (UI) + Geist Mono (data), self-hosted through Fontsource CSS imports
in the Vite entry stylesheet.

| Role | Classes |
|---|---|
| Page title | `text-xl font-semibold tracking-tight` |
| Section heading | `text-sm font-semibold` |
| Body | `text-sm` (default), `leading-relaxed` for prose |
| Meta/labels | `text-xs text-muted-foreground` |
| Dense meta/count labels | `text-2xs` (11px), uppercase labels allowed |
| Micro counters/axis labels | `text-3xs` (10px), only where space is constrained |
| Data (counts, IDs, paths, tokens) | `font-mono text-xs` or `tabular-nums` |

Large display headings (share pages, auth): `tracking-tight` (−0.02 to
−0.04em), `leading-[1.1]`, `text-wrap: balance` (applied globally to h1–h4).
Weights: use 500/600 for hierarchy; 400 body; avoid 700+.

### Component conventions

- Card tiers: entity cards are `rounded-lg p-4`; hero cards are
  `rounded-xl p-5`. Do not add new card tiers without updating this contract.
- Empty states use `EmptyState` only. `variant="page"` (default) is for a
  page or tab whose main region is empty: flat, centered, generous height, and
  an icon tile. `variant="inset"` is for an empty sub-region inside existing
  page/card/dialog chrome: solid border, `bg-muted/30`, compact padding, and
  no large icon. Do not add appearance axes like bordered/fillHeight/iconVariant
  or hand-roll dashed centered text placeholders.
- Hover idioms: clickable rows/cards use `hover:bg-muted/50`; hero-card lift
  uses `hover:-translate-y-px hover:border-foreground/20`.
- Tinted panels: subtle inset wells use `bg-muted/30`. Reserve
  `bg-muted/50` for hover fills and selected/active fills.
- Icon glyph scale: badge `size-3`, meta `size-3.5`, button `size-4`,
  tile `size-5`.
- Destructive actions: primary destructive actions use
  `variant="destructive"`. Menu or inline rows use ghost treatment plus
  `text-destructive`.
- Semantic colors: status and source colors use semantic tokens (`success`,
  `warning`, `destructive`, `info`) rather than raw palette utilities. Raw
  amber/sky status classes are banned.
- Font weights: card titles use `font-medium`; section headings use
  `font-semibold`.

### Motion

150–250ms, `transform`/`opacity` only. Buttons: hover background shift +
`active:scale-[0.98]` + visible `focus-visible` ring. Respect
`prefers-reduced-motion` (tw-animate-css handles this for its presets).

## Collections

Collection surfaces use one framework. Page-specific content can vary; the
toolbar chassis, group headers, error surface, card tier, and grid rhythm do
not.

### Item anatomies

- **Entity item** (`ENTITY_CARD_BASE`, `rounded-lg p-4`): `[leading icon] [title
  + titleAdornment] / [meta line]` with optional trailing status or actions.
  Use for operational objects: agents, channels, providers, connectors,
  session rows, linked agents, and devices.
- **Hero item** (`HERO_CARD_BASE`, `rounded-xl p-5`): `[top icon tile] / [title
  + badges] / [description] / [stats footer meta row]`. Use for top-level
  resource grids: projects, vaults, skills, and memories. The footer is always
  an `EntityMeta`-style middot row; keep page-specific facts, not page-specific
  footer layouts.

### Grid rhythm

- Entity grids use `ENTITY_GRID_CLASS`: `grid gap-2 sm:grid-cols-2
  xl:grid-cols-3`.
- Hero grids use `HERO_GRID_CLASS`: `grid gap-4 sm:grid-cols-2
  xl:grid-cols-3`.
- Masonry content can keep masonry columns, but each card still follows the
  hero tier padding, radius, hover, and footer conventions.

### Toolbar

Use `ListToolbar` for collection controls. Slot order is always:

1. `search` — `SearchInput`.
2. `filters` — `FilterChip` rows, selects, or `ToggleGroup`s.
3. `actions` — view switchers, selects, and command buttons.

The toolbar is a single flex row that wraps on small screens. Do not place list
search, filters, or view switches in `PageHeader.actions`.

### Group Headers And Errors

- `SectionLabel` is the only group header inside lists. Use its `leading` slot
  for identity icons and `count` for totals.
- `ApiErrorPanel` is the only API error surface on collection list/detail
  pages. Wire `onRetry` to the failing query's `refetch` when a query produced
  the error.

### Identity palette

`--identity-1..8` (bg+fg pairs, light and dark): vivid flat hues assigned by
name hash for object avatars. These plus the semantic status set are the only
multi-hue colors; never use them for controls or status.

## Decisions log

- 2026-06-03 — Light-first (Marvin override of the earlier dark-first plan);
  `defaultTheme="system"` retained, dark stays a first-class toggle.
- 2026-06-03 — Keep lucide-react as the only icon set; central re-export
  instead of a library migration.
- 2026-06-30 — TanStack Start migration moved Geist to Fontsource CSS imports,
  preserving self-hosted fonts without framework-specific font helpers or
  runtime Google requests.
- 2026-06-03 — shadcn `components/ui/*`: token/variant/recipe edits allowed,
  no structural/API rewrites.
- 2026-06-03 — `--destructive` changed from near-black to a true red;
  status colors moved from `emerald/amber/rose-*` utilities to semantic tokens.
- 2026-06-03 — Art direction shifted "modern, flat, vivid" (Marvin): emoji +
  vivid identity colors for object avatars (projects, vaults), tinted stat
  tiles, pastel memory-category chips. Revises the earlier blanket
  no-emoji rule — emoji allowed as object identity only.
- 2026-06-04 — Curation is a first-class mode (Marvin: "most skills/keys live
  in system projects and the default vault; the real move is search → batch
  select → move into a customized project/vault → share"). Skills defaults to
  the All-projects view grouped by source, busiest first; both skills and
  vault keys get search + select mode + a floating `BulkActionBar`. Key
  values never reach the browser: batch copy/move runs through the
  server-side `POST /api/vault/{slug}/items/copy` (decrypt + re-encrypt on
  the server) — the one deliberate backend addition of the redesign.
- 2026-06-05 — Copy-vs-reference vocabulary (Kingsley's review): the domain
  mixes reference semantics (vault→Project attach, Project sharing — one
  object, live everywhere) with true-copy semantics (skill→Project send,
  key→vault copy — independent duplicates that diverge). The UI must say
  which world an action lives in AT the action: reference verbs are
  Add/Share and state "changes apply everywhere"; duplication verbs are
  Copy/Move and state "won't sync after this". Every copy dialog also
  offers the reference alternative when that's likely the real goal
  ("Add this vault to the Project instead").

## Banned (CI-greppable)

Emoji in UI strings outside object-identity tiles · `Lorem` · `Elevate/Seamless/Unleash/Next-Gen/Delve`
copy · three-equal-card feature rows · `z-index: 9999` · inline color styles ·
hex colors in tsx · `(text|bg|border|ring|from|to)-(red|green|blue|amber|yellow|emerald|rose|purple|indigo|sky|zinc|slate|gray|neutral|stone)-[0-9]{3}` ·
`h-screen`/`100vh` (use `dvh`/`svh`) · `shadow-md` and above · `rounded-full`
on buttons/cards/containers.
