import { type AgentOwnership, agentOwnershipKindFromId } from "@clawdi/shared/client";
import { agentSourceBadgeClasses as styles } from "@clawdi/shared/ui";
import { agentSourceLabel } from "@clawdi/shared/view";
import { Cloud, Laptop } from "lucide-react-native";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Text } from "@/components/ui/text";
import { webBoth, webView } from "@/components/ui/web-layout";

export function AgentSourceBadge({
	agentId,
	ownership,
	showConnected = true,
}: {
	agentId?: string;
	ownership: AgentOwnership | null;
	showConnected?: boolean;
}) {
	const kind = agentOwnershipKindFromId(agentId, ownership);
	if (kind === "unresolved") return <Skeleton className={webView(styles.skeleton)} />;
	// Mobile is v2-only; legacy (v1 hosted) agents get no badge or legacy affordance.
	if (kind === "legacy") return null;
	const source = kind === "cloud" ? "hosted" : "connected";
	if (kind === "connected" && !showConnected) return null;
	return (
		<StatusBadge
			status="neutral"
			className={webBoth(`${styles.root} ${styles.compact} ${styles[source]}`)}
		>
			<Icon
				as={source === "hosted" ? Cloud : Laptop}
				fill={source === "hosted" ? "currentColor" : "none"}
				className={webBoth(styles.icon)}
			/>
			<Text>{agentSourceLabel(source)}</Text>
		</StatusBadge>
	);
}
