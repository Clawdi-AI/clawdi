import { sessionAgentInlineClasses } from "./session-meta";
/** Verbatim Web recipes, shared with the native phone layout. */
export const agentLabelClasses = {
	inlineFlexItemsCenterGap: sessionAgentInlineClasses.root,
	fontMediumTextForeground: sessionAgentInlineClasses.label,
	textInfoMutedForeground: "text-info-muted-foreground",
	textMutedForeground: "text-muted-foreground",
	shrink0WhitespaceNowrapBorder:
		"shrink-0 whitespace-nowrap border font-medium leading-none shadow-sm",
	size5JustifyCenterRounded: "size-5 justify-center rounded-full p-0",
	h5Gap1Rounded: "h-5 gap-1 rounded-full px-1.5 text-2xs",
	h5Gap15: "h-5 gap-1.5 rounded-full px-2 text-2xs",
	borderInfoMutedBgInfo: "border-info-muted bg-info-muted text-info-muted-foreground",
	borderBorderBgBackgroundText: "border-border bg-background text-muted-foreground",
	size35: "!size-3.5",
	size352: "size-3.5",
	srOnly: "sr-only",
	shrink0WhitespaceNowrapBorder2:
		"shrink-0 whitespace-nowrap border border-warning-muted bg-warning-muted font-medium leading-none text-warning-muted-foreground shadow-sm",
	textWarningMutedForeground: "text-warning-muted-foreground",
	h5W14Rounded: "h-5 w-14 rounded-full",
	textXsFontMedium: "text-xs font-medium",
	textSmFontMedium: "text-sm font-medium",
	textBaseFontMedium: "text-base font-medium",
	text2XlFontSemiboldTracking: "text-2xl font-semibold tracking-tight",
	mt0: "mt-0",
	mt05: "mt-0.5",
	mt1: "mt-1",
	flexMinW0Items: "flex min-w-0 items-center gap-3",
	minW0Flex1: "min-w-0 flex-1",
	flexMinW0Items2: "flex min-w-0 items-center gap-2",
	truncateLeadingTight: "truncate leading-tight",
	shrink0: "shrink-0",
	flexFlexWrapItemsCenter:
		"flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground",
	inlineFlexItemsCenterWhitespace: "inline-flex items-center whitespace-nowrap",
} as const;
