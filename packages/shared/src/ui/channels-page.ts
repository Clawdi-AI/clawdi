/** Exact Web recipes from apps/web/src/hosted/v2/channels/channels-page.tsx. */
export const channelsPageClasses = {
	filterCount: "text-muted-foreground tabular-nums",
	ownedSection: "flex flex-col gap-3",
	sharedSection: "flex min-w-0 flex-col gap-3",
	sharedDescription: "mt-1 text-xs text-muted-foreground",
	sharedCard: "h-full min-w-0",
	cardContainer: "group relative z-0 h-full min-w-0",
	card: "transition-colors group-hover:bg-muted/50",
	removeAction: "text-muted-foreground hover:text-destructive",
	actionIcon: "size-3.5",
	screenReaderOnly: "sr-only",
} as const;
