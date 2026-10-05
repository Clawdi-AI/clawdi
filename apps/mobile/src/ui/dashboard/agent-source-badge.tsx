import { agentLabelClasses as styles } from "@clawdi/shared/ui";
import type { LucideIcon } from "lucide-react-native";
import { StatusBadge } from "../status-badge";
import { WebIcon, webView } from "../web-layout";
export function AgentSourceBadge({ icon, legacy = false }: { icon: LucideIcon; legacy?: boolean }) {
	return (
		<StatusBadge
			status="neutral"
			className={webView(
				`${legacy ? styles.shrink0WhitespaceNowrapBorder2 : styles.shrink0WhitespaceNowrapBorder} ${styles.size5JustifyCenterRounded} ${legacy ? "" : styles.borderInfoMutedBgInfo}`,
			)}
		>
			<WebIcon
				as={icon}
				recipe={`${styles.size352} ${legacy ? styles.textWarningMutedForeground : styles.textInfoMutedForeground}`}
			/>
		</StatusBadge>
	);
}
