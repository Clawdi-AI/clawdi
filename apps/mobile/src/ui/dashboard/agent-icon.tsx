import { agentIconClasses as styles } from "@clawdi/shared/ui";
import { AgentFrameworkIcon } from "../agent-framework-icon";
import { webView } from "../web-layout";

const sizes = {
	xs: [16, styles.size4, styles.size25],
	sm: [20, styles.size5, styles.size3],
	md: [24, styles.size6, styles.size35],
	lg: [32, styles.size8, styles.size4],
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
			boxClassName={webView(`${box} ${styles.roundedMd}`)}
			fallbackIconClassName={webView(fallback)}
			avatarUrl={avatarUrl}
		/>
	);
}
