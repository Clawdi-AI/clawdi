import {
	sessionAgentFallbackSizes,
	sessionAgentIconRadius,
	sessionAgentIconSizes,
	sessionAgentInlineClasses,
} from "./session-meta";

const nameBySize = {
	xs: "text-xs font-medium",
	sm: "text-sm font-medium",
	md: "text-sm font-medium",
	lg: "text-base font-medium",
	rail: "text-base font-medium",
	xl: "text-2xl font-semibold tracking-tight",
} as const;

const subtitleGapBySize = {
	xs: "mt-0",
	sm: "mt-0.5",
	md: "mt-0.5",
	lg: "mt-0.5",
	rail: "mt-0.5",
	xl: "mt-1",
} as const;

/** Verbatim recipes from apps/web/src/components/dashboard/agent-label.tsx. */
export const agentLabelClasses = {
	root: "flex min-w-0 items-center gap-3",
	copy: "min-w-0 flex-1",
	heading: "flex min-w-0 items-center gap-2",
	name: "truncate leading-tight",
	adornment: "shrink-0",
	subtitle: "flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground",
	subtitleSegment: "inline-flex items-center whitespace-nowrap",
	nameBySize,
	subtitleGapBySize,
	inline: sessionAgentInlineClasses,
} as const;

/** AgentSourceBadge / LegacyAgentBadge recipes. */
export const agentSourceBadgeClasses = {
	root: "shrink-0 whitespace-nowrap border font-medium leading-none shadow-sm",
	legacyRoot:
		"shrink-0 whitespace-nowrap border border-warning-muted bg-warning-muted font-medium leading-none text-warning-muted-foreground shadow-sm",
	iconOnly: "size-5 justify-center rounded-full p-0",
	compact: "h-5 gap-1 rounded-full px-1.5 text-2xs",
	regular: "h-5 gap-1.5 rounded-full px-2 text-2xs",
	info: "border-info-muted bg-info-muted text-info-muted-foreground",
	neutral: "border-border bg-background text-muted-foreground",
	infoIcon: "text-info-muted-foreground",
	neutralIcon: "text-muted-foreground",
	legacyIcon: "text-warning-muted-foreground",
	iconOnlyIcon: "!size-3.5",
	icon: "size-3.5",
	srOnly: "sr-only",
	skeleton: "h-5 w-14 rounded-full",
} as const;

export const agentIconClasses = {
	medium: sessionAgentIconSizes.md,
	mediumFallback: sessionAgentFallbackSizes.md,
	rounded: sessionAgentIconRadius.rounded,
} as const;
