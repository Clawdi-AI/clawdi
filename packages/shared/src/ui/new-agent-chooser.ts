/** Web's "New agent" chooser choices, shared with the native sheet. */
export const newAgentChooserClasses = {
	choices: "grid gap-3",
	choicesWithDeploy: "sm:grid-cols-2",
	choice:
		"h-auto min-h-32 w-full flex-col items-start justify-start gap-2 whitespace-normal p-4 text-left hover:border-primary/40 hover:bg-muted/50",
	chip: "size-9 transition-colors",
	chipTint: "bg-primary/10 text-primary",
	title: "text-sm font-medium",
	description: "text-xs text-muted-foreground",
} as const;
