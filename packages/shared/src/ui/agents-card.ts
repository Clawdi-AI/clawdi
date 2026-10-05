/** Verbatim Web recipes, shared with the native wrappers. */
export const agentsCardClasses = {
	section: "space-y-3",
	card: "group relative z-0 h-full p-3 transition-colors hover:bg-muted/50",
	title: "flex min-w-0 items-center gap-1.5",
	name: "min-w-0 truncate",
	body: "min-w-0 flex-1",
	externalIcon: "pointer-events-none absolute right-3 top-3.5 size-3.5 text-muted-foreground",
	screenReaderOnly: "sr-only",
	status: "inline-flex shrink-0 items-center",
	dot: "size-1.5 rounded-full",
} as const;
