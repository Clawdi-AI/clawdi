/** Verbatim Web recipes from components/icon-chip; shared with native wrappers. */
export const iconChipClasses = {
	xs: "size-5 rounded-md [&>svg]:size-3.5",
	sm: "size-8 rounded-md [&>svg]:size-4",
	md: "size-10 rounded-lg [&>svg]:size-5",
	lg: "size-12 rounded-xl [&>svg]:size-6",
	defaultTint: "bg-muted text-muted-foreground",
	root: "flex shrink-0 select-none items-center justify-center leading-none",
} as const;

export const ICON_CHIP_SIZE_CLASS = {
	xs: iconChipClasses.xs,
	sm: iconChipClasses.sm,
	md: iconChipClasses.md,
	lg: iconChipClasses.lg,
} as const;

export type IconChipSize = keyof typeof ICON_CHIP_SIZE_CLASS;
