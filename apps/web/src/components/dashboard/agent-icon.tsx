import {
	agentIconFallbackClasses,
	agentIconPixels,
	agentIconRadiusClasses,
	agentIconSizeClasses,
} from "@clawdi/shared/ui";
import { AgentFrameworkIcon } from "@/components/agent-framework-icon";
import { cn } from "@/lib/utils";

/**
 * Per-agent brand-mark icon. Product surfaces share one corner radius by
 * default; transcript bubbles can opt into a circular crop.
 */

export type AgentIconSize = "xs" | "sm" | "md" | "lg" | "rail" | "xl";

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
	const radius = agentIconRadiusClasses[shape];
	return (
		<AgentFrameworkIcon
			agent={agent}
			pixelSize={agentIconPixels[size]}
			boxClassName={cn(agentIconSizeClasses[size], radius)}
			fallbackIconClassName={agentIconFallbackClasses[size]}
			avatarUrl={avatarUrl}
			className={className}
			draggable={false}
		/>
	);
}
