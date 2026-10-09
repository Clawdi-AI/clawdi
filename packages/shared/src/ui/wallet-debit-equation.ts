export const walletDebitEquationClasses = {
	root: "flex flex-col gap-1.5 rounded-lg border p-3 text-sm sm:flex-row sm:items-center",
	value: "min-w-0 flex-1 rounded-md bg-muted/50 px-3 py-2",
	label: "text-xs text-muted-foreground",
	amount: "truncate font-medium tabular-nums",
	operator: "self-center text-muted-foreground",
} as const;
