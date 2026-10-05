import { ENTITY_CARD_BASE, channelCardClasses as styles } from "@clawdi/shared/ui";
import { providerMeta } from "@clawdi/shared/view";
import type { ReactNode } from "react";
import { EntityHeader } from "../entity-card";
import { EntityIcon } from "../entity-icon";
import { WebView } from "../web-layout";
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
