/** Exact Web recipes from apps/web/src/components/dashboard/agents-card.tsx. */
export const agentsCardClasses = {
	tile: "group relative z-0 h-full p-3 transition-colors hover:bg-muted/50",
	dot: "size-1.5 rounded-full",
	spaceY: "space-y-3",
	flexMinWItems: "flex min-w-0 items-center gap-1.5",
	minWTruncate: "min-w-0 truncate",
	minWFlex: "min-w-0 flex-1",
	pointerEventsNoneAbsolute:
		"pointer-events-none absolute right-3 top-3.5 size-3.5 text-muted-foreground",
	srOnly: "sr-only",
	inlineFlexShrinkItems: "inline-flex shrink-0 items-center",
} as const;
