export const managedModelPickerClasses = {
	loading: "flex items-center gap-2 text-sm text-muted-foreground",
	icon: "size-3.5",
	root: "flex min-w-0 flex-col gap-2",
	controls: "flex min-w-0 max-w-full flex-wrap items-start gap-2",
	choices:
		"m-0 grid w-full min-w-0 grid-cols-1 gap-2 border-0 p-0 @md/main:grid-cols-2 @4xl/main:grid-cols-4",
	choice: "px-2.5 py-2",
	trigger: "max-w-full",
	value: "min-w-0",
	content: "min-w-64",
	item: "items-start py-2",
	itemContent: "flex min-w-0 items-start gap-2 whitespace-normal",
	itemCopy: "flex min-w-0 flex-col items-start gap-0.5",
	itemTitle: "font-medium",
	itemDescription: "text-xs leading-snug text-muted-foreground",
} as const;
