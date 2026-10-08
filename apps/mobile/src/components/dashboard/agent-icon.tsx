import {
	agentIconFallbackClasses,
	agentIconPixels,
	agentIconRadiusClasses,
	agentIconSizeClasses,
} from "@clawdi/shared/ui";
import { cn } from "cn";
import { AgentFrameworkIcon } from "@/components/agent-framework-icon";
import { webView } from "@/components/ui/web-layout";
export function AgentIcon({
	agent,
	size = "md",
	shape = "rounded",
	avatarUrl,
}: {
	agent?: string | null;
	size?: keyof typeof agentIconPixels;
	shape?: keyof typeof agentIconRadiusClasses;
	avatarUrl?: string | null;
}) {
	return (
		<AgentFrameworkIcon
			agent={agent}
			pixelSize={agentIconPixels[size]}
			boxClassName={cn(webView(agentIconSizeClasses[size]), webView(agentIconRadiusClasses[shape]))}
			fallbackIconClassName={webView(agentIconFallbackClasses[size])}
			avatarUrl={avatarUrl}
		/>
	);
}
