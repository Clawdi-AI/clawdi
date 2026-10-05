import { type AgentOwnership, agentOwnershipKindFromId } from "@clawdi/shared/client";
import { agentSourceBadgeClasses as styles } from "@clawdi/shared/ui";
import { agentSourceLabel } from "@clawdi/shared/view";
import { Cloud, History, Laptop } from "lucide-react-native";
import { Icon } from "../icon";
import { Skeleton } from "../skeleton";
import { StatusBadge } from "../status-badge";
import { Text } from "../text";
import { webBoth, webView } from "../web-layout";

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
	const source = kind === "cloud" ? "hosted" : "connected";
	if (kind === "connected" && !showConnected) return null;
	return (
		<StatusBadge
			status="neutral"
			className={webBoth(
				`${kind === "legacy" ? styles.legacyRoot : styles.root} ${styles.compact} ${kind === "legacy" ? "" : styles[source]}`,
			)}
		>
			<Icon
				as={kind === "legacy" ? History : source === "hosted" ? Cloud : Laptop}
				className={webBoth(styles.icon)}
				fill={kind === "cloud" ? "currentColor" : "none"}
			/>
			<Text>{kind === "legacy" ? "Legacy" : agentSourceLabel(source)}</Text>
		</StatusBadge>
	);
}
