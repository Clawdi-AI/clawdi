export const addAgentSetupClasses = {
	actionIcon: "size-3.5",
	root: "space-y-4",
	manualDivider: "flex items-center gap-3 text-xs text-muted-foreground",
	manualDividerLine: "h-px flex-1 bg-border",
	tabsList: "w-full sm:w-auto",
	commands: "mt-2 space-y-4",
	title: "text-sm font-medium",
	requirementHint: "mt-1 text-xs text-muted-foreground",
	installationLink: "underline underline-offset-4",
	promptContent: "mt-2 space-y-3",
	promptPanel: "rounded-lg border bg-muted/30",
	promptHeader: "flex items-center justify-between border-b border-border/40 px-3 py-1.5",
	promptLabel: "text-2xs uppercase tracking-wider text-muted-foreground",
	prompt: "whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed",
	registration: "border-t pt-4",
	registrationHeading: "flex items-center gap-2",
	registeredIcon:
		"flex size-6 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground",
	registeredAgents: "mt-2 space-y-2 rounded-lg border border-success/30 bg-success-muted p-3",
	registeredAgent: "flex items-center justify-between gap-3",
	body: "min-w-0 flex-1",
	registeredDescription: "text-xs text-success-muted-foreground",
	waiting:
		"mt-2 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground",
	waitingIndicator: "relative flex size-2",
	waitingPulse:
		"absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60",
	waitingDot: "relative inline-flex size-2 rounded-full bg-primary",
	steps: "space-y-3",
	step: "flex gap-3",
	commandRow: "mt-1 flex items-center gap-1.5 rounded-md border bg-muted/30 px-3 py-1.5",
	command: "min-w-0 flex-1 overflow-x-auto font-mono text-xs",
	stepNumber:
		"flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary",
} as const;

/** Add agent hand-off to Clawdi Desktop and its `/desktop/connect` launch page. */
export const desktopHandoffClasses = {
	root: "rounded-lg border bg-muted/30 p-4",
	row: "flex flex-col gap-3 sm:flex-row sm:items-center",
	summary: "flex min-w-0 flex-1 items-start gap-3",
	iconTint: "bg-primary/10 text-primary",
	body: "min-w-0",
	title: "text-sm font-medium",
	description: "mt-0.5 text-xs text-muted-foreground",
	openAction: "w-full sm:w-auto",
	fallback: "mt-3 text-xs text-muted-foreground",
	externalLink:
		"inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4",
	externalIcon: "size-3",
	launchPage: "flex min-h-dvh items-center justify-center bg-background p-6",
	launchCard: "flex w-full max-w-sm flex-col items-center gap-4 text-center",
	launchTitle: "text-lg font-semibold",
	launchDescription: "text-sm text-muted-foreground",
	launchFallbacks: "flex flex-col gap-2 text-xs text-muted-foreground",
} as const;
