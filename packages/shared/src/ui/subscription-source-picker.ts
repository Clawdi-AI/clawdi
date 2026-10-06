export const subscriptionSourcePickerClasses = {
	root: "@container/subscription-source flex min-w-0 flex-col gap-3",
	grid: "grid min-w-0 items-start gap-2 @3xl/subscription-source:grid-cols-2",
	dueNow: "text-xs font-medium text-foreground",
	choice: "items-start p-3",
	loading: "flex items-center gap-2 text-sm text-muted-foreground",
	icon: "size-3.5",
	existingFacts:
		"grid min-w-0 grid-cols-2 gap-x-2 gap-y-1 text-[11px] @md/choice:gap-x-3 @md/choice:text-xs",
	fact: "min-w-0",
	factLabel: "text-muted-foreground",
	factValue: "whitespace-nowrap text-foreground",
	payment: "flex min-w-0 items-center gap-1 text-foreground",
	paymentIcon: "size-3 shrink-0",
	price: "whitespace-nowrap",
	nowrap: "whitespace-nowrap text-foreground tabular-nums",
} as const;
