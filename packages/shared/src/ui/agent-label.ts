/** AgentLabel's compact billing identity, shared verbatim with Web. */
export const agentLabelClasses = {
	root: "flex min-w-0 items-center gap-3",
	copy: "min-w-0 flex-1",
	heading: "flex min-w-0 items-center gap-2",
	name: "truncate leading-tight",
	mediumName: "text-sm font-medium",
	subtitle: "flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground",
	mediumSubtitleGap: "mt-0.5",
} as const;
export const agentIconClasses = {
	medium: "size-6",
	mediumFallback: "size-3.5",
	rounded: "rounded-md",
} as const;
