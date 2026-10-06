/** Exact Web recipes from apps/web/src/components/dashboard/agent-settings-panel.tsx. */
export const agentSettingsPanelClasses = {
	root: "flex flex-col gap-8",
	skeleton: "h-[420px] w-full rounded-lg",
	errorTitle: "text-sm font-semibold",
	errorDescription: "text-sm text-muted-foreground",
	avatarInput: "hidden",
	identity: "flex flex-col items-center gap-5 text-center sm:flex-row sm:text-left",
	identityCopy: "flex min-w-0 flex-col gap-1",
	name: "max-w-full truncate text-lg font-semibold leading-7",
	identityMeta:
		"flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground sm:justify-start",
	nameForm: "flex w-full flex-col gap-3",
	nameRow: "flex flex-col gap-2 lg:flex-row",
	screenReaderOnly: "sr-only",
	saveName: "lg:h-9 lg:min-w-20",
	nameHelp:
		"flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between",
	defaultName: "min-w-0 truncate",
	resetName: "h-7 w-fit px-2 text-xs text-muted-foreground",
	avatarRow: "flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between",
	avatarIdentity: "flex min-w-0 flex-1 items-center gap-3",
	avatarCopy: "min-w-0",
	avatarLabel: "truncate text-sm font-medium",
	avatarHint: "text-xs text-muted-foreground",
	avatarActions: "flex shrink-0 flex-wrap gap-2 lg:justify-end",
	removeAvatar: "text-muted-foreground",
	actionRow: "flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between",
	actionDescription: "max-w-md text-sm text-muted-foreground",
	disconnect:
		"border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive",
} as const;
