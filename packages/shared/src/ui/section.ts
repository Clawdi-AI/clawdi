/** Verbatim Web recipes from components/dashboard/section; shared with native wrappers. */
export const sectionClasses = {
	root: "-mx-4 overflow-hidden border-y bg-card/60 sm:mx-0 sm:rounded-lg sm:border",
	primary: "border-foreground/15 bg-card",
	header: "flex flex-col gap-3 border-b px-4 py-4 sm:flex-row sm:items-start sm:justify-between",
	quietHeader: "bg-muted/15",
	primaryHeader: "bg-muted/25",
	headerBody: "min-w-0 space-y-1",
	titleRow: "flex min-w-0 items-center gap-2",
	icon: "size-4 shrink-0 text-muted-foreground",
	title: "truncate text-sm font-semibold",
	count: "text-xs tabular-nums",
	description: "max-w-3xl text-xs text-muted-foreground",
	actions: "flex w-full flex-col gap-2 sm:w-auto sm:min-w-0 sm:flex-row sm:items-center",
	toolbar: "border-b bg-background/40 px-4 py-3",
	empty: "m-4",
} as const;
