/** Verbatim Web recipes from components/ui/dialog; shared with native wrappers. */
export const dialogClasses = {
	dialogOverlay:
		"fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
	dialogContent:
		"fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-6 rounded-xl bg-popover p-6 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
	dialogContent2: "absolute top-4 right-4",
	dialogHeader: "flex flex-col gap-2",
	dialogFooter: "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
	dialogTitle: "leading-none font-medium",
	dialogDescription:
		"text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
} as const;
