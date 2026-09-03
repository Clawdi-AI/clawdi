# shadcn Base UI audit

Audit date: 2026-09-03

## Reproduce

The comparison is intentionally read-only; never pass `--overwrite` against the
customized files.

```bash
bunx --no-cache --bun shadcn@4.20.1 add --cwd apps/web button --dry-run --diff src/components/ui/button.tsx
```

Done: the command resolves the `base-vega` registry item and prints only a diff.

## Pinned evidence

- Repo selection: `apps/web/components.json` uses `base-vega`, neutral, CSS
  variables, and Lucide.
- shadcn CLI/registry: `4.20.1`, official tag commit
  [`71e50952fbb7eda2c992660d36cd58671a2edf42`](https://github.com/shadcn-ui/ui/tree/71e50952fbb7eda2c992660d36cd58671a2edf42),
  with Base registry sources under
  [`apps/v4/registry/bases/base/ui`](https://github.com/shadcn-ui/ui/tree/71e50952fbb7eda2c992660d36cd58671a2edf42/apps/v4/registry/bases/base/ui).
  The rendered style variant was queried from the official
  `https://ui.shadcn.com/r/styles/base-vega/<component>.json` endpoints.
- All 32 registry-owned source files have identical upstream blobs between the
  previous audit commit and the `4.20.1` tag; all 32 rendered `base-vega`
  endpoints returned successfully on the audit date.
- Base UI: `@base-ui/react 1.7.0`, tag `v1.7.0`, commit
  [`254f4744f0a241c20697b9eeab33402f4469a081`](https://github.com/mui/base-ui/tree/254f4744f0a241c20697b9eeab33402f4469a081).
- Installed supporting versions: Tailwind CSS `4.3.3`, CVA `0.7.1`, and
  Lucide React `1.39.0` (from `bun.lock`).

## Classification

`exact-current` means behavior, slots, state attributes, accessibility, and
style tokens match the rendered registry; import ordering, semicolons, and the
irrelevant RSC `"use client"` directive are ignored.

| Classification | Components | Notes |
| --- | --- | --- |
| exact-current | avatar, breadcrumb, card, checkbox, command, dropdown-menu, empty, input, input-group, kbd, label, popover, radio-group, select, separator, sheet, skeleton, spinner, switch, table, tabs, textarea, toggle, toggle-group, tooltip | No upstream source change since the previous audit. |
| locally customized but upstream-compatible | alert, alert-dialog, badge, button, dialog, sidebar, sonner | Clawdi retains long-token containment, viewport bounds, toast overflow guards, coarse-pointer button sizing, semantic badge guidance, mobile sidebar sizing, and removal of the unused random-width sidebar skeleton. Upstream slots and Base UI APIs remain intact. |
| genuinely outdated | none | The current registry has no useful fix or API update to apply. |
| unsafe/behavioral divergence | none | No unsupported Base UI or Radix-only API was found. |
| not registry-owned | confirm-action, data-table, data-table-column-header, data-table-faceted-filter, data-table-pagination, data-table-toolbar, search-input, status-badge | Clawdi composition/product helpers; audited for their use of local primitives but not registry-overwrite candidates. |

## High-risk primitive review

- Dialog, AlertDialog, and Sheet use Base UI `Root`, `Portal`, `Backdrop`,
  `Popup`, `Trigger`, and `Close` shapes. Dialog/AlertDialog root props include
  `onOpenChangeComplete`; Base UI invokes the opening callback from
  [`DialogPopup.tsx`](https://github.com/mui/base-ui/blob/254f4744f0a241c20697b9eeab33402f4469a081/packages/react/src/dialog/popup/DialogPopup.tsx#L51)
  and verifies close completion after exit animation in
  [`DialogRoot.test.tsx`](https://github.com/mui/base-ui/blob/254f4744f0a241c20697b9eeab33402f4469a081/packages/react/src/dialog/root/DialogRoot.test.tsx#L1195).
- Exit-presence behavior is driven by Base UI's `data-ending-style` state
  attribute, defined in
  [`stateAttributesMapping.ts`](https://github.com/mui/base-ui/blob/254f4744f0a241c20697b9eeab33402f4469a081/packages/react/src/internals/stateAttributesMapping.ts#L12).
  Local animation selectors use Base UI's `data-open`/`data-closed` attributes
  and do not introduce Radix lifecycle attributes.
- Popover, DropdownMenu (`Menu`), Select, and Tooltip use Base UI Positioner
  props (`align`, `alignOffset`, `side`, `sideOffset`) and `render`, not Radix
  `asChild`. Official close-completion coverage is present in the pinned Base
  UI tests for
  [`Popover`](https://github.com/mui/base-ui/blob/254f4744f0a241c20697b9eeab33402f4469a081/packages/react/src/popover/root/PopoverRoot.test.tsx#L1659),
  [`Menu`](https://github.com/mui/base-ui/blob/254f4744f0a241c20697b9eeab33402f4469a081/packages/react/src/menu/root/MenuRoot.test.tsx#L1865),
  [`Select`](https://github.com/mui/base-ui/blob/254f4744f0a241c20697b9eeab33402f4469a081/packages/react/src/select/root/SelectRoot.test.tsx#L2556), and
  [`Tooltip`](https://github.com/mui/base-ui/blob/254f4744f0a241c20697b9eeab33402f4469a081/packages/react/src/tooltip/root/TooltipRoot.test.tsx#L414).
- Command/CommandDialog remains the official `cmdk` composition over the local
  Base UI Dialog. Tabs use Base UI Tabs directly. Button and form primitives
  use Base UI `render`/native props; no `@radix-ui/*`, `asChild`, or Radix-only
  dismissal callbacks occur under `apps/web/src`.
- The files listed by PR #729 at head
  `844220d0b55553949b887bfa649be286d9fd815a` consume Command/CommandDialog,
  Dialog, AlertDialog (through `confirm-action` and directly), Popover, Select,
  Tooltip, Button, Input, Textarea, Checkbox, and Label. Each is covered by the
  classifications above. This audit does not modify PR #729's lifecycle work.

## Intentional divergences

- `alert.tsx`, `dialog.tsx`, and `alert-dialog.tsx`: retain Clawdi's long
  unbroken-token containment. AlertDialog also retains viewport-bounded
  vertical scrolling.
- `badge.tsx`: retains the local semantic guidance separating generic badges
  from status colors.
- `button.tsx`: retains the 44px coarse-pointer target for compact icon
  buttons.
- `sidebar.tsx`: retains side-aware mobile sizing and omits the unused
  randomized menu skeleton.
- `sonner.tsx`: retains responsive max width, `min-w-0`, wrapping, and
  non-shrinking action controls.
- Product helpers in the not-registry-owned row remain local compositions and
  must not be passed to a registry overwrite command.
