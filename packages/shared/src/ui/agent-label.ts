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
export { agentSourceBadgeClasses } from "./agent-source-badge";

export const agentIconClasses = {
	medium: sessionAgentIconSizes.md,
	mediumFallback: sessionAgentFallbackSizes.md,
	rounded: sessionAgentIconRadius.rounded,
} as const;
