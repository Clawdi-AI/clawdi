export const connectBotDialogClasses = {
	chooser: "min-w-0 space-y-2 border-0 p-0",
	chooserTitle: "mb-2 text-sm font-medium",
	choices: "grid grid-cols-1 gap-2 sm:grid-cols-3",
	choice: "gap-2 p-2",
	field: "flex flex-col gap-1.5",
	configuration: "min-w-0 border-t pt-4",
	configurationTitle: "mb-3 text-sm font-medium",
	form: "flex min-w-0 flex-col gap-3",
	hint: "min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]",
	action: "min-w-0 whitespace-normal",
} as const;
