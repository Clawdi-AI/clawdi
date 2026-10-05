export const agentSourceBadgeClasses = {
	iconOnly: "size-5 justify-center rounded-full p-0",
	compact: "h-5 gap-1 rounded-full px-1.5 text-2xs",
	regular: "h-5 gap-1.5 rounded-full px-2 text-2xs",
	icon: "size-3.5",
	root: "shrink-0 whitespace-nowrap border font-medium leading-none shadow-sm",
	legacyRoot:
		"shrink-0 whitespace-nowrap border border-warning-muted bg-warning-muted font-medium leading-none text-warning-muted-foreground shadow-sm",
	hosted: "border-info-muted bg-info-muted text-info-muted-foreground",
	connected: "border-border bg-background text-muted-foreground",
	hostedIcon: "text-info-muted-foreground",
	connectedIcon: "text-muted-foreground",
	legacyIcon: "text-warning-muted-foreground",
	iconOnlyIcon: "!size-3.5",
	screenReaderOnly: "sr-only",
	skeleton: "h-5 w-14 rounded-full",
} as const;
