/** Verbatim recipes from apps/web/src/pages/dashboard/sessions/shared-page.tsx. */
export const sharedSessionLinksClasses = {
	page: "space-y-5 px-4 lg:px-6",
	list: "overflow-hidden rounded-lg border bg-card",
	row: "flex flex-col gap-3 p-4 sm:flex-row sm:items-center",
	content: "min-w-0 flex-1",
	titleRow: "flex min-w-0 flex-wrap items-center gap-2",
	title: "truncate text-sm font-medium underline-offset-4 hover:underline",
	meta: "mt-1 text-xs text-muted-foreground",
	actions: "flex shrink-0 flex-wrap items-center gap-2",
	revoke: "text-muted-foreground hover:text-destructive",
	skeleton: "overflow-hidden rounded-lg border",
	skeletonRow: "flex items-center gap-4 p-4",
	skeletonBody: "min-w-0 flex-1 space-y-2",
	skeletonTitle: "h-4 w-48 max-w-full",
	skeletonMeta: "h-3 w-72 max-w-full",
	skeletonActions: "h-8 w-32 shrink-0",
} as const;
