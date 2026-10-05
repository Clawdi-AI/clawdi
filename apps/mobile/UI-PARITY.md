# Mobile UI parity with Web

The mobile app is a native replica of the Web dashboard (`apps/web`), not a
separate design. When a mobile screen and its Web page disagree, the Web page
wins unless the difference is a deliberate platform adaptation listed below.

## Sources of truth

- **Tokens**: `packages/shared/src/style/theme.css` → `theme.generated.css`
  (`bun run theme`; `scripts/theme.test.ts` fails when stale). Never add colors
  in mobile; use the same token utilities as Web (`bg-card`,
  `text-muted-foreground`, `bg-success-muted`, ...). No hex, no raw palette.
- **Design rules**: `DESIGN.md` at the repo root applies unchanged.
- **Logic and copy**: platform-agnostic view models live in
  `@clawdi/shared/view`. Reuse them; do not re-derive Web logic in mobile.
  User-facing English copy must match the Web page verbatim.

## Components

`src/ui/*` mirrors `apps/web/src/components/ui/*` with the same names, props
and variant classes: `Card*`, `Button`, `Badge`, `StatusBadge`/`StatusDot`,
`Separator`, `Skeleton`, `Alert`, `EmptyState`, `Input`/`Label`, `Avatar`,
`Icon`. App-level Web components (`page-header`, `section-label`,
`entity-card`, ...) are ported under `src/ui/` with the Web file name.

Porting a Web component or page:

1. Keep the JSX structure, order, copy and class names. Translate only what
   React Native cannot express:
   - `div`/`section` → `AppView`; text nodes → `Text` (every string must be
     inside `Text`).
   - Text styles do not cascade in RN. Containers that style text on Web
     provide `TextClassContext` (see `Button`, `Card`, `Badge`).
   - Default flex direction is `column`; add `flex-row` where Web relies on
     `flex` being a row.
   - `grid` → flex rows/wraps; `space-y-N` → `gap-N`; `hover:` → `active:`;
     `ring-*` → `border`; drop `focus-visible:`, `group-*`, `has-*`, `[&_svg]`.
   - Responsive prefixes: use the base (mobile) value. The phone layout of the
     Web page at 390px is the reference.
   - Icons: `<Icon as={LucideName} className="size-4 text-muted-foreground" />`
     with the same lucide icon as Web.
   - Links → `expo-router` navigation; dialogs/sheets/menus → native
     equivalents (`Alert`, native menus, `@expo/ui`, modal routes).
2. Put every string through the mobile i18n file, copying the Web English text.
3. Lists use `FlatList`; screens use `ScrollView` + `RefreshControl` like the
   existing read screens.

## Platform adaptations (allowed differences)

- The Web sidebar becomes native bottom tabs (`NativeTabs`). Secondary Web
  sidebar entries are reached from the tab roots.
- Web dialogs become native modal screens or action sheets.
- Hover-only affordances become press/long-press.
- Safe areas: content starts below the status bar.

## Verifying

Run the fixture API in `scripts/ui-parity/` and compare Web (390px viewport)
and Android screenshots of the same route on the same data. A screen is done
when the two screenshots show the same sections, order, copy, density and
colors.
