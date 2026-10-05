export const agentChannelSectionClasses = {
	section: "flex min-w-0 scroll-mt-6 flex-col gap-3 outline-none",
	header: "flex min-w-0 flex-wrap items-start justify-between gap-3",
	copy: "min-w-0 flex-1",
	description: "mt-1 min-w-0 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]",
	actions: "flex min-w-0 flex-wrap",
	loadingLabel: "sr-only",
	item: "h-full min-w-0",
	empty: "min-w-0 rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground",
} as const;
