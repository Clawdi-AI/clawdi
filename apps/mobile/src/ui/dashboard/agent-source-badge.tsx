import { agentSourceBadgeClasses } from "@clawdi/shared/ui";
import type { LucideIcon } from "lucide-react-native";
import { Icon } from "../icon";
import { StatusBadge } from "../status-badge";
import { webBoth } from "../web-layout";
export function AgentSourceBadge({ icon, legacy = false }: { icon: LucideIcon; legacy?: boolean }) {
	return (
		<StatusBadge
			status="neutral"
			className={webBoth(
				`${legacy ? agentSourceBadgeClasses.legacyRoot : agentSourceBadgeClasses.root} ${agentSourceBadgeClasses.iconOnly} ${legacy ? "" : agentSourceBadgeClasses.hosted}`,
			)}
		>
			<Icon
				as={icon}
				fill={legacy ? "none" : "currentColor"}
				className={webBoth(
					`${agentSourceBadgeClasses.icon} ${legacy ? agentSourceBadgeClasses.legacyIcon : agentSourceBadgeClasses.hostedIcon}`,
				)}
			/>
		</StatusBadge>
	);
}
