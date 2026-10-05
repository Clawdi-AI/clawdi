import {
	agentIconFallbackClasses,
	agentIconPixels,
	agentIconRadiusClasses,
	agentIconSizeClasses,
} from "@clawdi/shared/ui";
import { cn } from "cn";
import { AgentFrameworkIcon } from "../agent-framework-icon";
import { webView } from "../web-layout";
export function AgentIcon({
	agent,
	size = "md",
	avatarUrl,
}: {
	agent?: string | null;
	size?: keyof typeof agentIconPixels;
	avatarUrl?: string | null;
}) {
	return (
		<AgentFrameworkIcon
			agent={agent}
			pixelSize={agentIconPixels[size]}
			boxClassName={cn(
				webView(agentIconSizeClasses[size]),
				webView(agentIconRadiusClasses.rounded),
			)}
			fallbackIconClassName={webView(agentIconFallbackClasses[size])}
			avatarUrl={avatarUrl}
		/>
	);
}
