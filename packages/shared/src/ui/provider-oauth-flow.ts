export const providerOAuthFlowClasses = {
	root: "flex flex-col gap-4",
	tile: "rounded-lg border bg-muted/20 p-4 text-center",
	label: "text-xs font-medium uppercase tracking-wide text-muted-foreground",
	codeRow: "mt-2 flex items-center justify-center gap-2",
	code: "rounded-md bg-background px-3 py-2 font-mono text-xl font-semibold tracking-widest",
	error: "flex items-center gap-2 text-xs text-destructive",
	icon: "size-3.5",
	waiting: "flex items-center gap-2 text-xs text-muted-foreground",
} as const;
