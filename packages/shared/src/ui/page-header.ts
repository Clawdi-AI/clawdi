/** Verbatim Web recipes from components/page-header; shared with native wrappers. */
export const pageHeaderClasses = {
	root: "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
	lockup: "flex min-w-0 items-center gap-3",
	icon: "shrink-0",
	body: "min-w-0 max-w-full",
	titleRow: "flex min-w-0 flex-wrap items-center gap-2",
	title: "text-xl font-semibold tracking-tight text-pretty break-words",
	description: "mt-1 text-sm text-muted-foreground",
	status: "mt-1",
	skeletonIcon: "size-10 rounded-lg",
	skeletonTitle: "h-lh w-52 max-w-full",
	skeletonText: "text-transparent",
	skeletonDescription: "h-lh w-80 max-w-full",
	skeletonActions: "h-11 w-36 sm:h-8",
} as const;
