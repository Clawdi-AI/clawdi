# shadcn Base UI audit

Audit date: 2026-08-02

## Reproduce

The comparison is intentionally read-only; never pass `--overwrite` against the
customized files.

```bash
bunx shadcn@4.16.1 add --cwd apps/web radio-group --dry-run --diff src/components/ui/radio-group.tsx
```

Done: the command resolves the `base-vega` registry item and prints only a diff.

## Pinned evidence

- Repo selection: `apps/web/components.json` uses `base-vega`, neutral, CSS
  variables, and Lucide.
- shadcn CLI/registry: `4.16.1`, official source commit
  [`cb2bcd88d93b2f9bddb030e9136f1f8773e7eac4`](https://github.com/shadcn-ui/ui/tree/cb2bcd88d93b2f9bddb030e9136f1f8773e7eac4),
  with Base registry sources under
  [`apps/v4/registry/bases/base/ui`](https://github.com/shadcn-ui/ui/tree/cb2bcd88d93b2f9bddb030e9136f1f8773e7eac4/apps/v4/registry/bases/base/ui).
  The rendered style variant was queried from the official
  `https://ui.shadcn.com/r/styles/base-vega/<component>.json` endpoints.
- Base UI: `@base-ui/react 1.6.0`, tag `v1.6.0`, commit
  [`b34551d644f2e58ebf8fc1050d949f6654ceca6c`](https://github.com/mui/base-ui/tree/b34551d644f2e58ebf8fc1050d949f6654ceca6c).
- Installed supporting versions: Tailwind CSS `4.3.2`, CVA `0.7.1`, and
  Lucide React `1.28.0` (from `bun.lock`).
- Context7 was attempted by the root auditor but its monthly quota was
  exhausted. The audit therefore falls back exclusively to the pinned official
  registry, documentation, and GitHub sources above; no secondary sources are
  used.

## Classification

`exact-current` means behavior, slots, state attributes, accessibility, and
style tokens match the rendered registry; import ordering, semicolons, and the
irrelevant RSC `"use client"` directive are ignored.

| Classification | Components | Notes |
| --- | --- | --- |
| exact-current | avatar, badge, breadcrumb, button, card, checkbox, command, dropdown-menu, empty, input, input-group, kbd, label, popover, radio-group, select, separator, sheet, sidebar, skeleton, spinner, switch, table, tabs, textarea, toggle, toggle-group, tooltip | `radio-group` was updated by this audit. |
| locally customized but upstream-current | alert, alert-dialog, dialog, sonner | Clawdi intentionally adds `min-w-0`, safe long-token wrapping, viewport-bounded scrolling, and toast overflow guards. These are additive and preserve upstream slots/state selectors. |
| genuinely outdated | none after this audit | Before the audit: `radio-group`. |
| unsafe/behavioral divergence | none | No unsupported Base UI or Radix-only API was found. |
| not registry-owned | confirm-action, data-table, data-table-column-header, data-table-faceted-filter, data-table-pagination, data-table-toolbar, search-input, status-badge | Clawdi composition/product helpers; audited for their use of local primitives but not registry-overwrite candidates. |

## High-risk primitive review

- Dialog, AlertDialog, and Sheet use Base UI `Root`, `Portal`, `Backdrop`,
  `Popup`, `Trigger`, and `Close` shapes. Dialog/AlertDialog root props include
  `onOpenChangeComplete`; Base UI invokes the opening callback from
  [`DialogPopup.tsx`](https://github.com/mui/base-ui/blob/b34551d644f2e58ebf8fc1050d949f6654ceca6c/packages/react/src/dialog/popup/DialogPopup.tsx#L65)
  and verifies close completion after exit animation in
  [`DialogRoot.test.tsx`](https://github.com/mui/base-ui/blob/b34551d644f2e58ebf8fc1050d949f6654ceca6c/packages/react/src/dialog/root/DialogRoot.test.tsx#L1268).
- Exit-presence behavior is driven by Base UI's `data-ending-style` state
  attribute, defined in
  [`stateAttributesMapping.ts`](https://github.com/mui/base-ui/blob/b34551d644f2e58ebf8fc1050d949f6654ceca6c/packages/react/src/internals/stateAttributesMapping.ts#L12).
  Local animation selectors use Base UI's `data-open`/`data-closed` attributes
  and do not introduce Radix lifecycle attributes.
- Popover, DropdownMenu (`Menu`), Select, and Tooltip use Base UI Positioner
  props (`align`, `alignOffset`, `side`, `sideOffset`) and `render`, not Radix
  `asChild`. Official close-completion coverage is present in the pinned Base
  UI tests for
  [`Popover`](https://github.com/mui/base-ui/blob/b34551d644f2e58ebf8fc1050d949f6654ceca6c/packages/react/src/popover/root/PopoverRoot.test.tsx#L1645),
  [`Menu`](https://github.com/mui/base-ui/blob/b34551d644f2e58ebf8fc1050d949f6654ceca6c/packages/react/src/menu/root/MenuRoot.test.tsx#L1612),
  [`Select`](https://github.com/mui/base-ui/blob/b34551d644f2e58ebf8fc1050d949f6654ceca6c/packages/react/src/select/root/SelectRoot.test.tsx#L2374), and
  [`Tooltip`](https://github.com/mui/base-ui/blob/b34551d644f2e58ebf8fc1050d949f6654ceca6c/packages/react/src/tooltip/root/TooltipRoot.test.tsx#L381).
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
- `sonner.tsx`: retains responsive max width, `min-w-0`, wrapping, and
  non-shrinking action controls.
- Product helpers in the not-registry-owned row remain local compositions and
  must not be passed to a registry overwrite command.
