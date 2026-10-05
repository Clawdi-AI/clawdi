export const agentSourceBadgeClasses = {
	base: "shrink-0 whitespace-nowrap border font-medium leading-none shadow-sm",
	iconOnly: "size-5 justify-center rounded-full p-0",
	compact: "h-5 gap-1 rounded-full px-1.5 text-2xs",
	regular: "h-5 gap-1.5 rounded-full px-2 text-2xs",
	hosted: "border-info-muted bg-info-muted text-info-muted-foreground",
	connected: "border-border bg-background text-muted-foreground",
	legacy:
		"shrink-0 whitespace-nowrap border border-warning-muted bg-warning-muted font-medium leading-none text-warning-muted-foreground shadow-sm",
	loading: "h-5 w-14 rounded-full",
	icon: "size-3.5",
} as const;
