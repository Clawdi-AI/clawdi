import {
	sessionAgentFallbackSizes,
	sessionAgentIconRadius,
	sessionAgentIconSizes,
} from "@clawdi/shared/ui";
import { AgentFrameworkIcon } from "@/components/agent-framework-icon";
import { cn } from "@/lib/utils";

/**
 * Per-agent brand-mark icon. Product surfaces share one corner radius by
 * default; transcript bubbles can opt into a circular crop.
 */

export type AgentIconSize = "xs" | "sm" | "md" | "lg" | "rail" | "xl";

const SIZE_PX: Record<AgentIconSize, number> = {
	xs: 16,
	sm: 20,
	md: 24,
	lg: 32,
	rail: 40,
	xl: 48,
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
	const radius =
		shape === "circle" ? sessionAgentIconRadius.circle : sessionAgentIconRadius.rounded;
	return (
		<AgentFrameworkIcon
			agent={agent}
			pixelSize={SIZE_PX[size]}
			boxClassName={cn(sessionAgentIconSizes[size], radius)}
			fallbackIconClassName={sessionAgentFallbackSizes[size]}
			avatarUrl={avatarUrl}
			className={className}
			draggable={false}
		/>
	);
}
