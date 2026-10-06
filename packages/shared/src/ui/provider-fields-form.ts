export const providerFieldsFormClasses = {
	root: "flex flex-col gap-4",
	field: "flex flex-col gap-1.5",
	select: "w-full",
	oauth: "flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center",
	oauthIcon: "size-4 shrink-0 text-muted-foreground",
	content: "min-w-0 flex-1",
	title: "text-sm font-medium",
	hint: "text-xs text-muted-foreground",
	credentialHeader: "flex items-center justify-between gap-2",
	credentialLink:
		"inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline",
	externalIcon: "size-3",
} as const;
