export const credentialsDialogClasses = {
	dialog: "sm:max-w-md",
	loading: "flex items-center justify-center py-6",
	spinner: "size-5 text-muted-foreground",
	empty: "text-sm text-muted-foreground",
	form: "flex flex-col gap-3",
	field: "flex flex-col gap-1.5",
	required: "ml-0.5 text-destructive",
	hint: "text-xs text-muted-foreground",
	error: "text-sm text-destructive",
	icon: "size-3.5",
	body: "py-2",
} as const;
