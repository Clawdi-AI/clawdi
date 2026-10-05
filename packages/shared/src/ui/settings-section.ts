/** Shared Web recipes, retaining additive aliases used by native screens. */
export const settingsSectionClasses = {
	header: "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
	copy: "flex max-w-2xl min-w-0 flex-col gap-1.5",
	description: "text-sm leading-5 text-muted-foreground",
	actions: "shrink-0",
	content: "min-w-0",
	section: "flex flex-col gap-4",
	title: "text-sm font-semibold",
	root: "flex flex-col gap-4",
	body: "flex max-w-2xl min-w-0 flex-col gap-1.5",
	destructive: "text-destructive",
} as const;
