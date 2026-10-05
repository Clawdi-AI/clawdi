import {
	sessionAgentIconSizes as boxSizes,
	sessionAgentFallbackSizes as fallbackSizes,
	sessionAgentIconRadius as radius,
} from "@clawdi/shared/ui";
import { AgentFrameworkIcon } from "../agent-framework-icon";
import { webView } from "../web-layout";

const sizes = {
	xs: [16, boxSizes.xs, fallbackSizes.xs],
	sm: [20, boxSizes.sm, fallbackSizes.sm],
	md: [24, boxSizes.md, fallbackSizes.md],
	lg: [32, boxSizes.lg, fallbackSizes.lg],
} as const;
export type AgentIconSize = keyof typeof sizes;
export function AgentIcon({
	agent,
	size = "md",
	avatarUrl,
}: {
	agent: string | null | undefined;
	size?: AgentIconSize;
	avatarUrl?: string | null;
}) {
	const [pixelSize, box, fallback] = sizes[size];
	return (
		<AgentFrameworkIcon
			agent={agent}
			pixelSize={pixelSize}
			boxClassName={webView(`${box} ${radius.rounded}`)}
			fallbackIconClassName={webView(fallback)}
			avatarUrl={avatarUrl}
		/>
	);
}
