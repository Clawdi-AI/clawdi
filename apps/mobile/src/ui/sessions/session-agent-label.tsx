import { agentLabelClasses as styles } from "@clawdi/shared/ui";
import {
	agentIdentity,
	type SessionAgentIdentity,
	sessionAgentIdentityInput,
} from "@clawdi/shared/view";
import { AgentIcon, type AgentIconSize } from "../dashboard/agent-icon";
import { WebText, WebView } from "../web-layout";
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
		<WebView recipe={styles.flexMinW0Items} className={className}>
			<AgentIcon agent={session.agent_type} size={size} />
			<WebView recipe={styles.minW0Flex1}>
				<WebText recipe={`${styles.truncateLeadingTight} ${styles.textSmFontMedium}`}>
					{identity.primaryLabel}
				</WebText>
				{identity.secondaryLabel ? (
					<WebText recipe={styles.flexFlexWrapItemsCenter}>{identity.secondaryLabel}</WebText>
				) : null}
			</WebView>
		</WebView>
	);
}
