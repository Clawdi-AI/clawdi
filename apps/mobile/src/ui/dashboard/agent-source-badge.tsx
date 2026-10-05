import { agentSourceBadgeClasses } from "@clawdi/shared/ui";
import type { LucideIcon } from "lucide-react-native";
import { StatusBadge } from "../status-badge";
import { WebIcon, webView } from "../web-layout";
export function AgentSourceBadge({ icon, legacy = false }: { icon: LucideIcon; legacy?: boolean }) {
	return (
		<StatusBadge
			status="neutral"
			className={webView(
				`${legacy ? agentSourceBadgeClasses.legacyRoot : agentSourceBadgeClasses.root} ${agentSourceBadgeClasses.iconOnly} ${legacy ? "" : agentSourceBadgeClasses.info}`,
			)}
		>
			<WebIcon
				as={icon}
				recipe={`${agentSourceBadgeClasses.icon} ${legacy ? agentSourceBadgeClasses.legacyIcon : agentSourceBadgeClasses.infoIcon}`}
			/>
		</StatusBadge>
	);
}
