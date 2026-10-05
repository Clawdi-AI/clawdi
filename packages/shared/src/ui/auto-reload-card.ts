/** Read-only native form geometry comes from Web's AutoReloadCard. */
export const autoReloadCardClasses = {
	form: "flex flex-col gap-5",
	fields: "grid gap-5 sm:grid-cols-2",
	field: "flex flex-col gap-1.5",
	input:
		"tabular-nums [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
} as const;
