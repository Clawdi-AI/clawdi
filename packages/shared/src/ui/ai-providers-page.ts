/** Exact Web recipes from apps/web/src/hosted/v2/ai-providers/ai-providers-page.tsx. */
export const aiProvidersPageClasses = {
	section: "flex flex-col gap-2",
	titleBadges: "inline-flex items-center gap-1.5",
	actions: "mt-auto flex flex-wrap items-center gap-2 pt-3",
	removeAction: "ml-auto text-muted-foreground hover:text-destructive",
	removalDescription: "space-y-2",
	impactLoading: "flex items-center gap-2 text-muted-foreground",
	affectedAgents: "space-y-1 text-foreground",
	acknowledgement:
		"flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3",
	acknowledgementLabel: "text-sm font-normal leading-snug",
} as const;
