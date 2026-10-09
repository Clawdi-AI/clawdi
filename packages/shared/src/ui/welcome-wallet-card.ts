export const welcomeWalletCardClasses = {
	card: "border-primary/30 bg-primary/5",
	content: "flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between",
	summary: "flex items-start gap-3",
	icon: "mt-0.5 text-primary [&>svg]:size-6",
	body: "space-y-1",
	title: "font-medium",
	description: "text-sm text-muted-foreground",
	actions: "flex flex-wrap items-center gap-2",
	spinner: "size-4 text-muted-foreground",
	skeletonBody: "flex flex-1 flex-col gap-2",
	skeletonTitle: "h-5 w-56 max-w-full",
	skeletonLine: "h-4 w-96 max-w-full",
} as const;
