export const projectIdentityClasses = {
	root: "flex min-w-0 items-start gap-3",
	body: "min-w-0 flex-1",
	titleRow: "flex min-w-0 flex-wrap items-center gap-2",
	title: "min-w-0 max-w-full truncate text-sm font-semibold",
	supporting:
		"mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground",
	icon: "mt-0.5 flex size-6 shrink-0 select-none items-center justify-center rounded-md text-xs leading-none",
	access: "border-border/70 bg-background/50 text-xs text-muted-foreground",
	viewer: "bg-muted/60 text-foreground",
	kind: "gap-1 border text-xs",
	kindSurface: "border-border bg-muted/50 text-muted-foreground",
	kindFallback: "border-border bg-muted/30 text-muted-foreground",
	kindIcon: "size-3",
} as const;
