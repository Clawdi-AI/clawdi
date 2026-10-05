/** Verbatim Web recipes; native adds only layout structure. */
export const generalPanelClasses = {
	panel: "flex flex-col gap-8 px-5 sm:px-6 lg:px-8",
	accountRow: "flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between",
	identity: "flex min-w-0 items-center gap-3",
	avatar: "size-11 shrink-0",
	identityText: "min-w-0",
	name: "truncate text-sm font-medium",
	email: "truncate text-sm text-muted-foreground",
	manageIcon: "size-3.5",
	appearanceRow: "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
	appearanceLabel: "space-y-0.5",
	description: "text-xs text-muted-foreground",
	themeTrigger: "w-full sm:w-40",
} as const;
