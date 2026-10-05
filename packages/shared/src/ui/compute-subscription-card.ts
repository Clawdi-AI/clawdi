/** Verbatim Web recipes; native adds only layout structure. */
export const computeSubscriptionCardClasses = {
	includedIdentity: "flex min-w-0 items-center gap-3 text-success-muted-foreground",
	includedIconTile: "flex size-6 shrink-0 items-center justify-center rounded-md bg-success-muted",
	icon: "size-3.5",
	identityLabel: "truncate text-sm font-medium",
	orphanIdentity: "flex min-w-0 items-center gap-3 text-muted-foreground",
	orphanIconTile: "flex size-6 shrink-0 items-center justify-center rounded-md bg-muted",
	agentLink:
		"min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
	minWidth: "min-w-0",
	heading: "flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1.5",
	planName: "min-w-28 flex-1 basis-28 text-base font-semibold leading-6 [overflow-wrap:anywhere]",
	badges: "ml-auto flex max-w-full shrink-0 flex-wrap justify-end gap-1.5",
	meta: "flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1.5 empty:hidden",
	metaText: "min-w-0 text-xs leading-5 text-muted-foreground",
	screenReader: "sr-only",
	footer: "flex min-w-0 items-center gap-3 empty:hidden",
	hint: "shrink-0 text-xs text-muted-foreground",
	identity: "min-w-0 flex-1",
	price: "min-w-0 sm:text-right",
	actions:
		"flex min-w-0 w-full flex-wrap items-center gap-2 empty:hidden sm:justify-end max-sm:[&_[data-slot=button]]:h-auto max-sm:[&_[data-slot=button]]:min-h-8 max-sm:[&_[data-slot=button]]:max-w-full max-sm:[&_[data-slot=button]]:whitespace-normal",
	notices: "grid min-w-0 gap-2",
	noticeStrong: "font-semibold text-foreground",
} as const;
