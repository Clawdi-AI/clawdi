/** Verbatim recipes from apps/web/src/components/sessions/share-controls.tsx. */
export const shareControlsClasses = {
	button: "h-8",
	body: "space-y-3",
	link: "rounded-lg border p-3",
	linkHeader: "mb-2 flex items-center justify-between gap-3",
	linkTitle: "truncate text-sm font-medium",
	linkMeta: "text-xs text-muted-foreground",
	linkActions: "flex gap-2",
	url: "h-8 min-w-0 font-mono text-xs",
	copy: "h-8 shrink-0",
	revoke: "text-muted-foreground hover:text-destructive",
	older: "cursor-pointer text-sm text-muted-foreground",
} as const;
