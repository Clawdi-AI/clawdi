/** Verbatim Web recipes from components/account-suspended-page; shared with native wrappers. */
export const accountSuspendedPageClasses = {
	page: "flex min-h-dvh items-center justify-center bg-background px-6 py-12",
	section: "w-full max-w-lg text-center",
	logo: "mx-auto size-12 rounded-md",
	iconChip:
		"mx-auto mt-8 flex size-11 items-center justify-center rounded-md border bg-muted text-muted-foreground",
	icon: "size-5",
	title: "mt-5 text-xl font-semibold",
	reason: "mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground",
	help: "mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground",
	actions: "mt-6 flex flex-col justify-center gap-2 sm:flex-row",
	error: "mt-4 text-sm text-destructive",
} as const;
