/** Verbatim Web recipes, shared with the native phone layout. */
export const contributionGraphClasses = {
	inactiveActivity: "bg-primary/10",
	lowActivity: "bg-primary/30",
	mediumActivity: "bg-primary/50",
	highActivity: "bg-primary/75",
	peakActivity: "bg-primary",
	empty: "text-sm text-muted-foreground",
	root: "w-full",
	graph: "mx-auto flex w-fit gap-1.5",
	weekdays:
		"flex shrink-0 flex-col gap-[3px] text-center text-3xs text-muted-foreground tabular-nums",
	weeks: "flex gap-[3px]",
	week: "flex flex-col gap-[3px]",
	cell: "rounded-[3px]",
	placeholder: "bg-transparent",
	months: "relative mt-1 h-4 text-3xs leading-4 text-muted-foreground",
	monthLabel: "absolute whitespace-nowrap",
} as const;
