import {
	sessionAgentFallbackSizes,
	sessionAgentIconRadius,
	sessionAgentIconSizes,
} from "./session-meta";
/** Verbatim Web recipes, shared with the native phone layout. */
export const agentIconClasses = {
	size4: sessionAgentIconSizes.xs,
	size5: sessionAgentIconSizes.sm,
	size6: sessionAgentIconSizes.md,
	size8: sessionAgentIconSizes.lg,
	size10: sessionAgentIconSizes.rail,
	size12: sessionAgentIconSizes.xl,
	size25: sessionAgentFallbackSizes.xs,
	size3: sessionAgentFallbackSizes.sm,
	size35: sessionAgentFallbackSizes.md,
	roundedFull: sessionAgentIconRadius.circle,
	roundedMd: sessionAgentIconRadius.rounded,
} as const;
