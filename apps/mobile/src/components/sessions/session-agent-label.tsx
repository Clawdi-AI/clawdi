import { agentLabelClasses as styles } from "@clawdi/shared/ui";
import {
	agentIdentity,
	type SessionAgentIdentity,
	sessionAgentIdentityInput,
} from "@clawdi/shared/view";
import { AgentIcon, type AgentIconSize } from "@/components/dashboard/agent-icon";
import { WebText, WebView } from "@/components/ui/web-layout";
export function SessionAgentLabel({
	session,
	size = "sm",
	className,
}: {
	session: SessionAgentIdentity;
	size?: AgentIconSize;
	className?: string;
}) {
	const identity = agentIdentity(sessionAgentIdentityInput(session));
	return (
		<WebView recipe={styles.root} className={className}>
			<AgentIcon agent={session.agent_type} size={size} />
			<WebView recipe={styles.copy}>
				<WebText recipe={`${styles.name} ${styles.nameBySize.sm}`}>{identity.primaryLabel}</WebText>
				{identity.secondaryLabel ? (
					<WebText recipe={styles.subtitle}>{identity.secondaryLabel}</WebText>
				) : null}
			</WebView>
		</WebView>
	);
}
