/** Verbatim Web recipes, shared with the native phone layout. */
export const sessionFeedClasses = {
	searchRole: "font-medium capitalize",
	sessionRowHeightSpacing20:
		"[--session-row-height:--spacing(20)] @3xl/main:[--session-row-height:--spacing(16.5)]",
	flexMinHSessionRow:
		"flex min-h-(--session-row-height) min-w-0 items-center gap-3 px-4 py-3 transition-colors",
	gridGap2: "grid gap-2",
	size8Shrink0Rounded: "size-8 shrink-0 rounded-md",
	minW0Flex1: "min-w-0 flex-1",
	textSmLeading5Font: "text-sm leading-5 font-semibold",
	hLhW45: "h-lh w-4/5",
	mt05MinH: "mt-0.5 min-h-8 text-xs leading-4 @3xl/main:min-h-4",
	hLhW12: "h-lh w-1/2",
	hLhW13: "h-lh w-1/3 @3xl/main:hidden",
	justifyCenterBorderDashedBg:
		"justify-center border-dashed bg-muted/30 text-center text-sm text-muted-foreground",
	flexFlexColGap2: "flex flex-col gap-2",
	flexFlexColGap5: "flex flex-col gap-5",
	fontMono: "font-mono",
	minW0: "min-w-0",
	groupHoverBgMuted50:
		"group hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
	bgMuted30: "bg-muted/30",
	flexShrink0: "flex shrink-0",
	w0MinW0: "w-0 min-w-0 flex-1",
	blockTruncateTextSmLeading: "block truncate text-sm leading-5 font-semibold",
	mt05LineClamp: "mt-0.5 line-clamp-2 text-xs leading-4 text-foreground/75",
	mt05FlexMin:
		"mt-0.5 flex min-h-8 min-w-0 flex-wrap items-center gap-y-0 text-xs leading-4 text-muted-foreground @3xl/main:min-h-4",
	inlineFlexMinW0: "inline-flex min-w-0 max-w-full items-center",
	mx15Shrink0: "mx-1.5 shrink-0 text-muted-foreground/40",
	minW0Truncate: "min-w-0 truncate",
} as const;
