export const settingsDialogClasses = {
	dialog:
		"h-[min(820px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-6xl gap-0 overflow-hidden p-0 sm:max-w-6xl",
	shell: "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]",
	header:
		"flex h-14 shrink-0 flex-row items-center justify-between gap-3 border-b px-4 text-left md:px-5",
	title: "truncate text-sm font-semibold",
	screenReader: "sr-only",
	layout:
		"grid min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[15rem_minmax(0,1fr)] md:grid-rows-1",
	navigation: "flex min-w-0 flex-col border-b bg-muted/30 md:border-r md:border-b-0",
	navigationContainer: "relative min-w-0 md:min-h-0 md:flex-1",
	navigationItems:
		"flex gap-1 overflow-x-auto px-3 py-3 [scrollbar-width:thin] md:min-h-0 md:flex-1 md:flex-col md:overflow-y-auto",
	navigationCopy: "grid min-w-0 flex-1 leading-tight",
	navigationLabel: "truncate font-medium",
	navigationDescription: "hidden truncate text-xs text-muted-foreground md:block",
	navigationFade:
		"pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-muted/30 to-transparent md:hidden",
	panel: "min-h-0 min-w-0 overflow-y-auto py-6 md:py-8",
	panelWidth: "mx-auto w-full max-w-4xl",
	panelPadding: "px-5 sm:px-6 lg:px-8",
	navigationButton:
		"h-auto min-w-28 shrink-0 justify-start gap-2 rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground hover:bg-background/70 hover:text-foreground md:min-w-0 md:gap-3 md:px-3",
	navigationActive:
		"data-[active=true]:bg-background data-[active=true]:text-foreground data-[active=true]:shadow-xs",
} as const;
