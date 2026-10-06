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
form routes live under their parent resource URL and use native Stack sheets
(see Native patterns below).
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

## Native patterns

SDK contracts were checked against installed Expo 57.0.26, Expo Router 57.0.24,
`@expo/ui` 57.0.21 and `react-native-screens` 4.26.2. Use public exports
(`expo-router/native-stack`, `expo-router/react-navigation`).

**Headers and actions** — `src/platform/navigation/native-header.tsx`,
`header-actions{,.android}.tsx`, `signed-in-layout.tsx`. Each tab contains a
native Stack. Root screens enable `headerLargeTitleEnabled` (the SDK 57 name
for the deprecated `headerLargeTitle`). Titles use Web copy, shared color
tokens and Geist. `PageHeader` and `SettingsPanelHeader` keep descriptions,
identity/status/adornments; native stacks own titles and back controls.
`PageHeader` accepts `headerActions` and `headerMenu` descriptors directly.
Prefer action descriptors: iOS uses native `Stack.Toolbar`, Android uses
Compose buttons/menus via its documented `asChild` slot. Existing Web action
JSX can use `contentActions` during migration; menus remain native `MenuView`.

```tsx
const actions = [{ id: "shared", label: copy.sharedLinks,
  onPress: () => router.push("/sessions/shared") }];
return <><NativeHeader title={copy.title} actions={actions}
  menu={{ label: t("sessionFilters.options"), items: menuItems }} />
  <PageHeader title={copy.title} description={copy.description} /></>;
```

**Search** — `useHeaderSearch` in `native-header.tsx`; pilot:
`src/pages/dashboard/sessions/page.tsx`. Keep the existing validation,
debounce, filters and account-scoped query. The hook syncs native text edits
and programmatic resets; do not retain an in-content `SearchInput`.

```tsx
const search = useHeaderSearch({ value: query, onChange: setQuery,
  placeholder: copy.searchPlaceholder, maxLength: SEARCH_QUERY_MAX_LENGTH });
return <><Stack.Screen options={{ headerSearchBarOptions: search }} />
  <NativeHeader title={copy.title} />
  <NativeList data={rows} renderItem={renderRow} /></>;
```

**Route sheets** — `sheet-options.ts`, `sheet-layout.tsx`, `use-sheet.ts`,
`src/components/ui/sheet-page.tsx`. Routes stay under the Web parent URL:
`/projects/invitations`, `/projects/[id]/sharing`, `/skills/new`,
`/skills/[key]/archive`, `/channels/whatsapp`. `/skills/archive` is the
unkeyed archive-upload form. There are no `/native/*` routes/page duplicates.
The URL-transparent `(sheets)` group sits above NativeTabs in the root Stack,
so tabs remain beneath the modal. Its inner native Stack supplies the header:
Android formSheet itself does not create an AppBarLayout. Configure presentation
in `root-layout.tsx` before opening; Android accepts at most three sorted detents.
Content is an ordinary page, never an additional Dialog/Modal.
Use `SheetPage` for title/cancel/scroll;
forms with an existing dirty-state guard own their `NativeHeader` instead.

```tsx
// app/(sheets)/projects/[id]/sharing.tsx
export { default } from "@/pages/dashboard/projects/[id]/sharing/page";
// root-layout.tsx: outer sheet; (sheets)/_layout.tsx: native Stack
<Stack.Screen name="(sheets)" options={formSheetOptions} />;
// Other form routes follow the same thin-file pattern.
```

```tsx
// src/pages/dashboard/projects/[id]/sharing/page.tsx
export { ProjectSharingScreen as default }
  from "@/components/sharing/share-project-dialog";
// The feature renders its Web form in route content:
<SheetPage title={title} fallback="/projects" busy={action.busy}>{form}</SheetPage>;
```

```tsx
const sheet = useSheet<boolean>({ fallback: "/projects", busy: action.busy,
  onResult: () => cache.invalidateQueries({ queryKey: accountQueryKey(scope) }) });
const finish = async () => { try { await sheet.close(true); }
  catch (error) { setError(error); } };
return <SheetPage title={title} fallback="/projects" busy={action.busy} sheet={sheet}>{form}</SheetPage>;
```

`close(result)` awaits the result handler, then dismisses to the existing
parent (or replaces with `fallback` for a cold deep link). Rejection keeps the
sheet open; callers render `ApiErrorPanel`. Pass the same hook instance as
`<SheetPage sheet={sheet} ...>` when a form closes with a result, so its busy
guard has one owner. `close(result)` explicitly permits successful completion
while cancel/swipe stays locked during the mutation. Swipe/back dismissal uses the
native Stack; `busy` blocks removal. Preserve foreground/account fences,
durable attempt journals and dirty-state `usePreventRemove` guards. Do not
pass secrets or callbacks through route parameters. Pairing dismissal keeps
the existing server-side expiration/cancellation semantics.

**Confirmation** — `src/components/ui/confirm-action.tsx`,
`src/platform/native-confirmation.ts`. String yes/no prompts use `Alert.alert`
with destructive style. The controller locks duplicate taps, fences stale
completions and re-presents the same prompt with safe failure copy on rejection.
Rich content/secondary actions use `rich-confirm-action.tsx`'s native sheet;
forms use route sheets. Guarded callbacks must return their Promise and reject
on failure; use `useAuthAction.runOrThrow` when using that action wrapper.

```tsx
<ConfirmAction open={open} onOpenChange={setOpen}
  title={copy.removeTitle} description={copy.removeDescription}
  destructive confirmLabel={copy.remove}
  onConfirm={() => action.runOrThrow(async current => {
    await remove(); if (current()) await invalidate(); })} />;
```

Data sheets use `SheetPage scroll={false}` so `NativeList` owns scrolling and
refresh. Put the sheet description and form controls in the list header; the
native sheet keeps the same close/error and busy-dismiss guards.

**Lists** — `src/components/ui/native-list.tsx`. One FlatList owns scrolling,
RefreshControl and `onEndReached`. Keep Web sections, filters, empty/error/
skeleton components in `header`, `empty`, `footer`; reuse entity recipes for
cells. Never nest a long list in a ScrollView. Overview recent sessions,
Sessions and Library use this pattern; bounded settings/forms use ScrollView.

```tsx
<NativeList data={rows} keyExtractor={row => row.id} renderItem={renderRow}
  refreshing={query.isRefetching} onRefresh={() => void query.refetch()}
  hasMore={query.hasNextPage} loadingMore={query.isFetching}
  onLoadMore={() => void fetchNextPage()} header={toolbar} empty={emptyState}
  footer={query.isFetchingNextPage ? skeleton : errorPanel} />;
```

**Segments and insets** — `src/platform/navigation/segmented-control.tsx`
uses SDK 57's native community segmented control on iOS and Compose
segmented buttons with shared colors/Geist on Android for settings navigation.
NativeTabs retains its default content-inset behavior (including Android's
bottom safe area). `SafeAreaScreen` leaves top/bottom ownership to a visible
stack header; native scroll views use `contentInsetAdjustmentBehavior="automatic"`
so iOS large titles/search coordinate with scrolling. Do not add a second
hand-drawn title or unconditional top/bottom SafeAreaView.

```tsx
const options = items.map(item => ({ value: item.id, label: item.label }));
return <NativeSegments value={active} options={options}
  disabled={busy} onChange={value => {
    const item = items.find(item => item.id === value);
    if (item && item.id !== active) router.push(item.href); }} />;
```

Done: `bun run --cwd apps/mobile typecheck`, `bun run --cwd apps/mobile test`,
`bunx biome ci .` and Android export exit 0. Capture light/dark pilots against
the shared fixture and exercise header search, sheet swipe dismissal, native
confirmation and pull-to-refresh; iOS large-title behavior requires iOS runtime
verification in addition to the checked SDK contract.
