# Web composites on native

The shared recipes in `@clawdi/shared/ui` are the styling source. Web imports
those recipes unchanged. Native wrappers use `resolveWebClasses` (or the
`WebView` / `WebText` helpers) and add only native layout structure. After
editing recipes, run `bun run --cwd apps/mobile theme` and commit
`apps/mobile/web-classes.generated.css`.

- Wrap literal button/badge content in `Text`. `WebView` and `Content` preserve
  text inheritance for nested components; React Native does not cascade it.
- `EntityCard*`, `HeroCard`, and `EntityChoiceCard` keep Web's variants and
  anatomy. Grids become single-column stacks. `link.to` is an Expo Router
  `Href`; legacy `$param` placeholders, query parameters, and hashes are
  encoded before navigation. Whole-card links sit behind their content so
  actions remain independently pressable.
- `identityFor` and brand ID lists are re-exported from `@clawdi/shared/view`.
  `IconChip` resolves identity colors directly from shared theme variables,
  including when those runtime classes are outside the static UI safelist.
- Brand SVGs are generated from the exact LobeHub exports used by Web. Run
  `bun apps/mobile/src/platform/generate-brand-assets.mjs` from the repository root
  to regenerate them. Channels use the same public PNG URLs as Web. Failed
  images fall back to the same monogram/device treatment.
- `Tabs` uses string values; `TabsList` supports `default` and `line` (native
  default is `line`). `ToggleGroup` uses Web's string-array value contract and
  `multiple` prop. `Switch` keeps native geometry with shared theme tints.
- `Select` and `DropdownMenu` accept direct Item/Group/Fragment descriptor
  children. System menus own popup geometry, typography, separators and
  scrolling. Custom components that hide descriptors are not evaluated;
  pass an item's plain `label` when its children are not plain text. Trigger
  appearance uses shared Web recipes. `render` accepts a native element.
  On iOS, menu open/close observation is unavailable; selection still works.
- `Dialog`, `Sheet`, and `AlertDialog` use native `Modal` with shared surfaces.
  Portal/Overlay slots are compatibility slots: Content owns those layers.
  A trigger/close `render` accepts a native Pressable/Button and uses `onPress`.
  Alert dialogs dismiss through their Cancel button or controlled `open`;
  an Action button does not close automatically. `ConfirmAction` keeps async
  actions visible, fences stale completions with the existing action gate,
  and shows safe inline errors on rejection.
- `ApiErrorPanel` understands shared API/network errors. Domain callers may
  provide the same `normalizer` interface as Web. Auth expiry routes to sign-in
  or calls `onReauthenticate`; Desktop reconnect is omitted. `ErrorState` is a
  compatibility adapter for screens that have not adopted `ApiErrorPanel` yet.
- `TimeTooltip` keeps the caller's relative-time text without hover content.
  `TruncatedText` uses native ellipsis and accessibility labels.
- `Markdown` retains the native external-link/image consent flow, with Web's
  typography and code/table recipes. Code is selectable for native copy;
  the desktop copy button and Source toolbar are omitted. `highlightQuery`
  matches Web; `query` remains a compatibility alias. `MarkdownBody` is the
  stateless renderer for previews and the gallery.

`/dev/ui` renders the primitives and composites with realistic sample data.
Its route returns a redirect before mounting the gallery when `__DEV__` is
false. It performs no mutations or tenant operations.
