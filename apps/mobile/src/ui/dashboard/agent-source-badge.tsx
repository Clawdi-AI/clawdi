import { agentSourceBadgeClasses } from "@clawdi/shared/ui";
import type { LucideIcon } from "lucide-react-native";
import { Icon } from "../icon";
import { StatusBadge } from "../status-badge";
import { webBoth } from "../web-layout";

/** Icon-only hosted badge from the Web agent tile (mobile shows no legacy v1 agents). */
export function AgentSourceBadge({ icon }: { icon: LucideIcon }) {
	return (
		<StatusBadge
			status="neutral"
			className={webBoth(
				`${agentSourceBadgeClasses.root} ${agentSourceBadgeClasses.iconOnly} ${agentSourceBadgeClasses.hosted}`,
			)}
		>
			<Icon
				as={icon}
				fill="currentColor"
				className={webBoth(`${agentSourceBadgeClasses.icon} ${agentSourceBadgeClasses.hostedIcon}`)}
			/>
		</StatusBadge>
	);
}
