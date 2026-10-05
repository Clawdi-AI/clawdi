import { agentIconClasses } from "@clawdi/shared/ui";
import { AgentFrameworkIcon } from "@/components/agent-framework-icon";
import { cn } from "@/lib/utils";

/**
 * Per-agent brand-mark icon. Product surfaces share one corner radius by
 * default; transcript bubbles can opt into a circular crop.
 */

export type AgentIconSize = "xs" | "sm" | "md" | "lg" | "rail" | "xl";

const SIZE_CLASS: Record<AgentIconSize, string> = {
	xs: agentIconClasses.size4,
	sm: agentIconClasses.size5,
	md: agentIconClasses.size6,
	lg: agentIconClasses.size8,
	rail: agentIconClasses.size10,
	xl: agentIconClasses.size12,
};

const SIZE_PX: Record<AgentIconSize, number> = {
	xs: 16,
	sm: 20,
	md: 24,
	lg: 32,
	rail: 40,
	xl: 48,
};

const FALLBACK_ICON_CLASS: Record<AgentIconSize, string> = {
	xs: agentIconClasses.size25,
	sm: agentIconClasses.size3,
	md: agentIconClasses.size35,
	lg: agentIconClasses.size4,
	rail: agentIconClasses.size5,
	xl: agentIconClasses.size6,
};

export function AgentIcon({
	agent,
	size = "md",
	shape = "rounded",
	avatarUrl,
	className,
}: {
	agent: string | null | undefined;
	size?: AgentIconSize;
	shape?: "rounded" | "circle";
	avatarUrl?: string | null;
	className?: string;
}) {
	const radius = shape === "circle" ? agentIconClasses.roundedFull : agentIconClasses.roundedMd;
	return (
		<AgentFrameworkIcon
			agent={agent}
			pixelSize={SIZE_PX[size]}
			boxClassName={cn(SIZE_CLASS[size], radius)}
			fallbackIconClassName={FALLBACK_ICON_CLASS[size]}
			avatarUrl={avatarUrl}
			className={className}
			draggable={false}
		/>
	);
}
