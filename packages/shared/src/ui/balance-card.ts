/** Verbatim Web recipes; native adds only layout structure. */
export const balanceCardClasses = {
	layout: "flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between",
	copy: "space-y-1.5",
	label: "flex items-center gap-1.5 text-sm text-muted-foreground",
	icon: "size-4",
	meta: "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground",
	warning: "inline-flex items-center gap-1 font-medium text-warning-muted-foreground",
	warningIcon: "size-3.5",
	actions: "flex w-full flex-col gap-2 sm:flex-row lg:w-auto lg:shrink-0",
	action: "w-full sm:w-auto",
	negativeBalance:
		"text-4xl font-semibold tracking-tight tabular-nums text-warning-muted-foreground",
	balance: "text-4xl font-semibold tracking-tight tabular-nums",
} as const;
