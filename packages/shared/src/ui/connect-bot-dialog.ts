export const connectBotDialogClasses = {
	body: "flex min-w-0 flex-col gap-4",
	chooser: "min-w-0 space-y-2 border-0 p-0",
	chooserTitle: "mb-2 text-sm font-medium",
	choices: "grid grid-cols-1 gap-2 sm:grid-cols-3",
	choice: "gap-2 p-2",
	field: "flex flex-col gap-1.5",
	configuration: "min-w-0 border-t pt-4",
	configurationTitle: "mb-3 text-sm font-medium",
	form: "flex min-w-0 flex-col gap-3",
	unsupported: "min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]",
	setupIcon: "size-3",
	setupLink:
		"inline-flex min-w-0 flex-wrap items-center gap-1 font-medium text-foreground underline underline-offset-4",
	hint: "min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]",
	action: "min-w-0 whitespace-normal",
} as const;

export const channelFormClasses = {
	pairingIdentity: "min-w-0 truncate text-sm font-medium",
	pairingDescription: "text-sm text-muted-foreground",
	pairingQr: "flex items-center justify-center",
	pairingExpiry: "text-center text-sm font-medium text-muted-foreground",
	pairingInstructions: "space-y-2 rounded-lg border bg-muted/20 p-3 text-sm",
	pairingCode: "min-w-0 rounded-md border bg-background p-3 font-mono text-xs text-foreground",

	content: "sm:max-w-md",
	field: "space-y-1.5",
	trigger: "w-full",
	pairingContent:
		"h-[min(40rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden sm:h-auto sm:max-w-md",
	pairingBody:
		"min-h-0 min-w-0 break-words overflow-y-auto overscroll-contain pr-1 [overflow-wrap:anywhere]",
};
