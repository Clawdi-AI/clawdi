/** Verbatim recipes from apps/web/src/pages/public-share/session-page.tsx. */
export const publicSessionClasses = {
	page: "space-y-5 px-4 py-6 lg:px-6",
	heading: "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
	body: "min-w-0 flex-1 space-y-2",
	empty: "text-sm text-muted-foreground",
	footer: "border-t pt-4 text-xs text-muted-foreground",
	gate: "mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center",
	gateLabel: "text-xs uppercase tracking-wide text-muted-foreground",
	gateTitle: "mt-2 text-2xl font-semibold tracking-tight",
	gateBody: "mt-3 text-sm text-muted-foreground",
	gateLink: "mt-6 text-sm font-medium underline-offset-4 hover:underline",
	header:
		"sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
	headerRow: "flex items-center justify-between px-4 py-3 lg:px-6",
	brand: "flex items-center gap-2 transition-opacity hover:opacity-80",
	brandImage: "size-7 shrink-0 rounded-md",
	brandName: "text-sm font-semibold tracking-tight",
} as const;
