export const providerDialogClasses = {
	content:
		"flex max-h-[min(36rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl",
	body: "min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6",
	footer: "shrink-0 border-t bg-popover px-5 py-3 sm:px-6 sm:py-4",

	header: "relative shrink-0 px-5 pt-5 pr-14 sm:px-6 sm:pt-6 sm:pr-14",
	headerRow: "flex min-w-0 items-center gap-2",
	titleRow: "flex min-w-0 items-center gap-3",
	icon: "shrink-0",
	title: "min-w-0 break-words",
} as const;
