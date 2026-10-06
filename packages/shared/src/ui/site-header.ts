/** Verbatim Web recipes, shared with the native phone layout. */
export const siteHeaderClasses = {
	pageSurface: "bg-background",
	root: "sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b",
	content: "flex w-full min-w-0 items-center gap-1 px-4 lg:gap-2 lg:px-6",
	sidebarTrigger: "-ml-1 md:hidden",
	sidebarSeparator: "mx-2 h-4 data-vertical:self-center md:hidden",
	breadcrumbs: "min-w-8 flex-1 overflow-hidden",
	notificationSkeleton: "size-8 rounded-md",
} as const;
