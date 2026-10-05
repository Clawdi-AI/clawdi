/** Verbatim recipes from apps/web/src/components/detail/layout.tsx. */
export const sessionMetaClasses = {
	title: "font-semibold text-lg tracking-tight",
	meta: "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground",
	stats: "flex flex-wrap items-center gap-x-4 gap-y-2",
	panel: "rounded-lg border bg-card/60 p-4",
} as const;

export const sessionAgentIconSizes = {
	xs: "size-4",
	sm: "size-5",
	md: "size-6",
	lg: "size-8",
	rail: "size-10",
	xl: "size-12",
} as const;
export const sessionAgentFallbackSizes = {
	xs: "size-2.5",
	sm: "size-3",
	md: "size-3.5",
	lg: "size-4",
	rail: "size-5",
	xl: "size-6",
} as const;
export const sessionAgentIconRadius = { circle: "rounded-full", rounded: "rounded-md" } as const;
export const sessionAgentInlineClasses = {
	root: "inline-flex items-center gap-1.5",
	label: "font-medium text-foreground",
} as const;
