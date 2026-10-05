import type { SessionListItem } from "@clawdi/shared/api";
import { ENTITY_CARD_BASE, agentRecentSessionClasses as styles } from "@clawdi/shared/ui";
import { formatNumber, relativeTime, sessionCardModel } from "@clawdi/shared/view";
import { router } from "expo-router";
import { EntityCardSkeleton } from "../entity-card";
import { AppPressable } from "../view";
import { WebText, WebView, webView } from "../web-layout";
import { AgentIcon } from "./agent-icon";
export function AgentRecentSessions({
	sessions,
	loading,
	emptyMessage,
}: {
	sessions: SessionListItem[];
	loading: boolean;
	emptyMessage: string;
}) {
	if (loading)
		return (
			<WebView recipe={styles.list}>
				{[0, 1, 2].map((i) => (
					<EntityCardSkeleton key={i} />
				))}
			</WebView>
		);
	const visible = sessions.slice(0, 3);
	return (
		<WebView recipe={styles.list}>
			{visible.map((session) => {
				const model = sessionCardModel(session);
				return (
					<AppPressable
						key={session.id}
						accessibilityRole="link"
						accessibilityLabel={`Open session ${model.title}`}
						className={`${webView(`${ENTITY_CARD_BASE} ${styles.card}`)} flex-row`}
						style={{ minHeight: 80 }}
						onPress={() =>
							router.push({ pathname: "/sessions/[sessionId]", params: { sessionId: session.id } })
						}
					>
						<AgentIcon agent={session.agent_type} size="lg" />
						<WebView recipe={styles.body}>
							<WebText recipe={styles.title} numberOfLines={1}>
								{model.title}
							</WebText>
							<WebText recipe={styles.meta}>
								{model.projectFolder ? (
									<WebText recipe={styles.project}>{model.projectFolder} · </WebText>
								) : null}
								{session.message_count} {session.message_count === 1 ? "message" : "messages"} ·{" "}
								{formatNumber(model.totalTokens)} tokens · {relativeTime(session.last_activity_at)}
							</WebText>
						</WebView>
					</AppPressable>
				);
			})}
			{Array.from({ length: 3 - visible.length }, (_, index) => (
				<WebView
					key={`empty-${index}`}
					recipe={`${ENTITY_CARD_BASE} ${styles.card} ${styles.placeholder}`}
					style={{ minHeight: 80 }}
				>
					{!visible.length && !index ? (
						<WebText recipe={styles.placeholder}>{emptyMessage}</WebText>
					) : null}
				</WebView>
			))}
		</WebView>
	);
}
