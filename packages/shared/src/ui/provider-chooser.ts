export const providerChooserClasses = {
	root: "flex flex-col gap-3",
	variants: "grid gap-2 sm:grid-cols-2",
	variant: "h-auto min-h-11 justify-between whitespace-normal px-3 py-2 text-left",
	chevron: "size-3.5 shrink-0 text-muted-foreground",
	choices: "grid grid-cols-2 gap-2",
	choice: "h-11 min-w-0 justify-start gap-2 px-3 text-left",
	icon: "shrink-0",
	label: "min-w-0 flex-1 truncate",
	empty: "flex flex-col items-start gap-2",
	hint: "text-sm text-muted-foreground",
} as const;
