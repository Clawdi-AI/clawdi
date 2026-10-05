export const dataTablePaginationClasses = {
	root: "flex flex-col-reverse items-center justify-between gap-3 px-1 sm:flex-row",
	results: "text-sm text-muted-foreground",
	controls: "flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row sm:gap-6",
	pageSize: "flex items-center gap-2",
	pageSizeTrigger: "w-[72px]",
	navigation: "flex items-center gap-1",
	boundaryAction: "hidden sm:inline-flex",
	actionIcon: "size-4",
	pageCount: "min-w-12 px-2 text-center text-sm tabular-nums whitespace-nowrap",
} as const;
