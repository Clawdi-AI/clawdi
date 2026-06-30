# Cloud UI 2.0 — Baseline survey (Phase 0)

Surveyed on branch `cloud-ui-redesign` (off main @ b54b7d0), local dev at
`http://localhost:3001` (web) + `:8001` (backend, DB clone `clawdi_cloud_ui2`).
Screenshots: `/tmp/ui2b/{light,dark}-{desktop,mobile}/*.png` (15 pages × 4 combos).

**Direction update (Marvin, 2026-06-03): light-first, not dark-first.** Linear/Vercel
crispness applies to the light theme as the default; dark stays supported via toggle.

## Route map

| Route | Purpose | Size |
|---|---|---|
| `/` | Overview: agents, activity heatmap, recent sessions, onboarding | — |
| `/sessions`, `/sessions/[id]` | Session list (data table) / transcript detail | 538L detail |
| `/projects`, `/projects/[id]` | Projects list / project detail | 534L / **1112L** |
| `/agents`, `/agents/[id]` | Agent environments list / detail | 768L detail |
| `/skills`, `/skills/[key]` | Skills install + marketplace / detail | 645L / 534L |
| `/memories`, `/memories/[id]` | Memory list / detail | 492L |
| `/connectors`, `/connectors/[name]` | Composio integrations | 599L detail |
| `/vault` | Secrets management | **1517L** |
| `/sign-in`, `/sign-up` | Clerk auth | — |
| `/s/[id]`, `/share/[token]` | Public share pages | 423L |
| `/cli-authorize` | Device auth | — |

## What's already good (don't redo)

- **Geist Sans + Geist Mono already wired** through shared theme CSS variables (`--font-sans`/`--font-mono`).
- Tokens are OKLCH CSS vars in `packages/shared/src/style/theme.css`, consumed by Tailwind v4 `@theme` — single source of truth, easy to overhaul.
- **Zero hardcoded hex** in tsx. Only ~15 Tailwind palette-utility violations (mostly `daemon-status.tsx`).
- Lucide icons only, no mixed sets. No emoji-as-icons found in code. No `window.alert`. No `100vh` (uses `svh`).
- Solid shadcn base: 37 components, customized sidebar (collapsible icon-mode, ⌘B, cookie persistence), DataTable with loading/empty built in, Empty/Skeleton/Spinner/Kbd exist, sonner themed.
- Custom class-based theme provider, light+dark both render.

## Problems found (visual, vs design directives)

1. **Radius way too soft**: `--radius: 1rem` (16px) base; primary CTA ("Add Agent"), Share button, and filter chips are full pills. Directive: 6–12px band, no pills on buttons/cards.
2. **Decoration soup / card nesting**: vault, skills, projects pages nest card-in-card-in-card, every section header has an icon-in-rounded-box ornament + explainer paragraph. Hierarchy should come from type + hairlines, not boxes.
3. **Low density**: oversized page titles, explainer sentence under every heading, generous padding everywhere — marketing rhythm, not Linear data-product rhythm. Topbar (48px) holds only a breadcrumb + inbox icon.
4. **Title Case everywhere**: "Session History", "Project Scope", "Installed Skills", ALL-CAPS "SUGGESTED SKILLS". Directive: sentence case.
5. **No semantic status tokens**: live/error/paused colors are ad-hoc `emerald/amber/rose-500` utilities (13 hits in `dashboard/daemon-status.tsx:113-123,443-444`, plus `connector-card.tsx`, `vault/page.tsx`, `share-controls.tsx`). `--destructive` is currently **near-black**, not a red.
6. **Warm-beige base**: light bg `oklch(0.9818 0.0054 95)` reads cream/beige; cards barely differ from bg; borders low-contrast rather than crisp hairlines.
7. **Shadows**: default shadcn shadow stack (up to 0.25 opacity at 2xl) — should be near-zero, hierarchy via borders.
8. **Chart tokens include purple** (`--chart-2/4` at hue ~290–298) — off-brand vs monochrome+orange.
9. **Session titles leak raw tags**: `<ide_opened_file>…</ide_opened_file>` shown verbatim in list + detail title (sanitize at display).
10. **Monster files**: `vault/page.tsx` 1517L, `projects/[id]/page.tsx` 1112L, `share-project-dialog.tsx` 926L, `agents/[id]/page.tsx` 768L, `daemon-status.tsx` 648L — slice while restyling.
11. No central icon re-export (per-file lucide imports, no pinned size/stroke).
12. Sidebar footer shows avatar+name fine, but counts in nav are absent; no tabular-nums discipline on token/message counts in tables.

## State handling (code survey)

- Loading: Skeleton + Spinner + DataTable `isLoading`. Empty: `Empty*` family used unevenly (some pages use plain centered text instead). Errors: ad-hoc amber boxes; toast via sonner direct calls (no unique-ID helper, no retry CTA pattern).
- Connectors page depends on Composio API — with invalid key it 500s; needs a designed inline error state (currently spinner/blank risk).

## Local dev notes (for reproducibility)

- Worktree `.env`s enable `VITE_DEV_AUTH_BYPASS` (web) + `DEV_AUTH_BYPASS` / `DEV_AUTH_CLERK_ID=<marvin>` (backend) — local-only, backend refuses outside `ENVIRONMENT=development`.
- DB: `clawdi_cloud_ui2` cloned from `clawdi_cloud`; the source DB's alembic stamp (`d7e3f8a4c1b2`, bench-fixes line) didn't match its real schema — re-stamped clone at `672acd66fc7d`, ran `alembic upgrade head`, then patched genuine drift (`sessions.content_hash`, `content_uploaded_at`, `device_authorizations` table). Marvin's original DB untouched.
- Run: `uv run uvicorn app.main:app --port 8001` (backend/), `bun run dev -- -p 3001` (apps/web/).

## Phase plan validation

Survey confirms the handoff phase list with these adjustments:
- Phase 1 font work is a no-op (Geist already in); focus = tokens + DESIGN.md. **Light-first** per Marvin's override; system default stays.
- Phase 4 impact order: overview → sessions list/detail → skills → projects list/detail → vault → agents → memories → connectors → share/cli-authorize.
- Phase 4 must also: sanitize tag-leaking session titles, de-nest section "cards", sentence-case all headers.
- Phase 5 scope is small (~15 hits, 5 files) — fold the daemon-status refactor into the StatusBadge primitive (Phase 2) and sweep the rest.
