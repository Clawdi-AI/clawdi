import type { ChannelAccount } from "@clawdi/shared/api";
import { ENTITY_CARD_BASE, channelCardClasses as styles } from "@clawdi/shared/ui";
import { DISCORD_CONNECTION_ISSUE_COPY, providerMeta } from "@clawdi/shared/view";
import { TriangleAlert } from "lucide-react-native";
import type { ReactNode } from "react";
import { EntityHeader } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { Alert } from "@/components/ui/alert";
import { WebView, webView } from "@/components/ui/web-layout";
export function ChannelCard({
	provider,
	title,
	state,
	actions,
}: {
	provider: string;
	title: string;
	state?: ReactNode[];
	actions?: ReactNode;
}) {
	return (
		<WebView recipe={`${ENTITY_CARD_BASE} ${styles.card.replace(/\bh-full\b/g, "")}`}>
			<WebView recipe={styles.header}>
				<EntityHeader
					align="start"
					icon={<EntityIcon kind="channel" id={provider} label={providerMeta(provider).label} />}
					title={title}
					meta={state}
				/>
				{actions ? (
					<WebView recipe={styles.actions} className="flex-row">
						{actions}
					</WebView>
				) : null}
			</WebView>
		</WebView>
	);
}

/** Web's terminal Discord gateway notice for bot owners. */
export function DiscordConnectionIssueAlert({
	issue,
}: {
	issue: ChannelAccount["connection_issue"] | undefined;
}) {
	if (!issue) return null;
	const copy = DISCORD_CONNECTION_ISSUE_COPY[issue];
	return (
		<Alert icon={TriangleAlert} title={copy.title} className={webView(styles.connectionIssue)}>
			{copy.message}
		</Alert>
	);
}
