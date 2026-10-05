/** Exact Web recipes from apps/web/src/components/dashboard/agent-overview-layout.tsx. */
export const agentOverviewLayoutClasses = {
	tools: "grid auto-rows-fr gap-3 @5xl/main:grid-cols-3",
	heading: "flex min-h-8 items-center justify-between gap-3",
	entry:
		"grid items-stretch gap-4 @3xl/main:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)] @3xl/main:gap-y-3",
	activity:
		"grid min-w-0 gap-3 @3xl/main:row-span-2 @3xl/main:row-start-1 @3xl/main:grid-rows-subgrid",
} as const;
