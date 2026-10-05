/** Verbatim Web recipes, shared with the native phone layout. */
export const resourcesCardClasses = {
	root: "gap-0 pb-0",
	header: "border-b",
	content: "p-0",
	error: "p-6",
	skeletonRow: "flex items-center gap-3 px-6 py-3",
	iconSkeleton: "size-4",
	nameSkeleton: "h-4 flex-1",
	countSkeleton: "h-4 w-8",
	count: "text-sm tabular-nums",
	emptyCount: "text-muted-foreground",
	activeCount: "font-semibold",
	row: "group flex items-center gap-3 px-6 py-3 transition-colors hover:bg-muted/50",
	iconTile: "flex size-7 shrink-0 items-center justify-center rounded-lg",
	icon: "size-3.5",
	body: "min-w-0 flex-1",
	name: "text-sm font-medium",
} as const;
