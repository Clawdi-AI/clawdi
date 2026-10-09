const CARD_LAYOUT = "flex flex-col overflow-hidden p-0";

export const channelCardClasses = {
	grid: "items-stretch xl:grid-cols-2",
	card: `${CARD_LAYOUT} h-full`,
	/** Card without grid-row stretching; native lists size cards to content. */
	cardLayout: CARD_LAYOUT,
	header:
		"grid min-h-20 min-w-0 flex-1 content-center gap-3 p-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center",
	actions: "relative z-10 flex min-w-0 items-center justify-end gap-2",
	connectionIssue: "border-warning/30 bg-warning-muted",
};
