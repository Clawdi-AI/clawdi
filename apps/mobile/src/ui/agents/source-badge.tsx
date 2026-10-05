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
}: {
	agentId?: string;
	ownership: AgentOwnership | null;
}) {
	const kind = agentOwnershipKindFromId(agentId, ownership);
	if (kind === "unresolved") return <Skeleton className={webView(styles.loading)} />;
	const source = kind === "cloud" ? "hosted" : "connected";
	return (
		<StatusBadge
			status="neutral"
			className={webBoth(
				`${kind === "legacy" ? styles.legacy : styles.base} ${styles.compact} ${kind === "legacy" ? "" : styles[source]}`,
			)}
		>
			<Icon
				as={kind === "legacy" ? History : source === "hosted" ? Cloud : Laptop}
				className={webBoth(styles.icon)}
			/>
			<Text>{kind === "legacy" ? "Legacy" : agentSourceLabel(source)}</Text>
		</StatusBadge>
	);
}
