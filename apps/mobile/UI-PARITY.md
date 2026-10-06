# Mobile UI parity with Web

The mobile app is a native replica of the Web dashboard (`apps/web`), not a
separate design. When a mobile screen and its Web page disagree, the Web page
wins unless the difference is a deliberate platform adaptation listed below.

## Scope

The app covers Clawdi v2 only. Do not port Web's v1 legacy hosted surfaces
(legacy agent tiles, "Legacy" badges, legacy dashboard links). Legacy agent
ids may be read solely to keep those agents out of v2 lists.

## Sources of truth

- **Tokens**: `packages/shared/src/style/theme.css` → `theme.generated.css`
  (`bun run theme`; `scripts/theme.test.ts` fails when stale). Never add colors
  in mobile; use the same token utilities as Web (`bg-card`,
  `text-muted-foreground`, `bg-success-muted`, ...). No hex, no raw palette.
- **Design rules**: `DESIGN.md` at the repo root applies unchanged.
- **Logic and copy**: platform-agnostic view models live in
  `@clawdi/shared/view`. Reuse them; do not re-derive Web logic in mobile.
  User-facing English copy must match the Web page verbatim.

## Architecture mapping

| Web (`apps/web/src`) | Mobile (`apps/mobile`) |
| --- | --- |
| `routes/**` | `app/**`: thin Expo Router page exports and screen options |
| `pages/**` | `src/pages/**`: same relative page paths and file names |
| `components/<feature>/**` | `src/components/<feature>/**` |
| `components/ui/**` | `src/components/ui/**`: same primitive names |
| `hosted/**` | `src/hosted/**`: v2 hosted Agents, providers, channels and billing |
| `lib/**`, `hooks/**` | `src/lib/**`, `src/hooks/**` |
| Native platform integration | `src/platform/**`: lifecycle, secure storage, Clerk, RevenueCat, navigation |

Source imports use `@/*` → `src/*`; Expo Metro resolves the TypeScript alias.
The five native tabs use pathless groups over Web URLs: `/`, `/agents`,
`/sessions`, Library resources and `/settings`. Agent sections use Web's
`project-access`, `model-provider` and `channel-links` segments. Agent details
retain nested resource URLs; Skill keys use the path rather than a query-only
`detail` route, and Vault slugs resolve to a stable, account-scoped identity.
Web's `?settings=<panel>` opens `/settings/<panel>`; Clerk management lives
under `/settings/account/*`. Hosted deployments open through their Agent id.
The previous deployment inventory screen is covered by the Agents inventory.

Mobile-only tab hubs, Clerk management pages, development galleries and native
form entry pages have no Web page counterpart. They reuse feature components;
`src/pages/native/**` contains only the existing native form entry points,
under `/native/**` so forms do not reserve Web resource keys.
Web-only DOM, desktop, Stripe checkout and v1 legacy surfaces are not ported.
`src/lib/i18n/en.ts` owns mobile strings and reuses shared view copy where
available; feature-specific translation files and unused keys are removed.

## Shared Web styling

Web class strings live once in `@clawdi/shared/ui` (`packages/shared/src/ui`).
Web components import them; mobile renders the same strings through
`resolveWebClasses` (`src/lib/web-classes.ts`):

- state variants (`data-active:`, `group-data-[size=sm]/card:`, ...) resolve
  against an explicit state map; `hover:` becomes `active:`; responsive
  variants drop (the phone layout is the base layout);
- utilities React Native cannot express drop; `ring` becomes `border`;
- the result splits into view and text classes, because RN text does not
  inherit (`TextClassContext` carries text classes to nested `Text`/`Icon`).

`bun run theme` safelists every class reachable from `packages/shared/src/ui`
so Uniwind compiles them; `scripts/theme.test.ts` fails when it is stale.

Porting a Web component:

1. Move its class strings / cva variants out of the Web file into
   `packages/shared/src/ui/<web-file>.ts`; the Web component imports them and
   renders byte-identical classes.
2. Write the mobile wrapper with the same name and props, rendering those
   shared strings via `resolveWebClasses`. Add only RN-structural classes
   (e.g. `flex-row` for what DOM inline layout gives Web).
3. Reuse view models and copy from `@clawdi/shared/view`; never re-derive.

Pages follow the same rule: same JSX structure, order and copy as the Web
page; class strings shared where the page defines its own.

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
