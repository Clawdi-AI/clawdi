/** Verbatim Web recipes; native adds only layout structure. */
export const apiKeysPanelClasses = {
	panel: "flex flex-col gap-8 px-5 sm:px-6 lg:px-8",
	command: "font-mono text-xs whitespace-nowrap",
	keyPrefix: "block min-w-0 truncate font-mono text-xs text-muted-foreground",
	revoke: "text-muted-foreground hover:text-destructive",
	card: "min-w-0 rounded-lg border bg-card p-4",
	cardHeader: "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3",
	factBody: "min-w-0",
	factWide: "col-span-2 min-w-0",
	cardName: "line-clamp-2 break-all text-sm font-medium",
	cardPrefix: "mt-1.5 max-w-full",
	facts: "mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3 text-xs",
	factLabel: "text-muted-foreground",
	factValue: "mt-0.5 font-medium text-foreground",
	permissionsValue: "mt-0.5 break-words font-medium text-foreground",
} as const;
