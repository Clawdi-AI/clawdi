import type { SessionListItem } from "@clawdi/shared/api";
import { ENTITY_CARD_BASE, sessionFeedClasses as styles } from "@clawdi/shared/ui";
import { formatNumber, relativeTime, sessionCardModel } from "@clawdi/shared/view";
import { router } from "expo-router";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { EntityCardSkeleton } from "@/components/entity-card";
import { AppPressable } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useAgentRouteId } from "@/platform/navigation/use-agent-route";
export function AgentRecentSessions({
	sessions,
	loading,
	emptyMessage,
}: {
	sessions: SessionListItem[];
	loading: boolean;
	emptyMessage: string;
}) {
	const agentId = useAgentRouteId();
	if (loading)
		return (
			<WebView recipe={styles.overviewList}>
				{[0, 1, 2].map((i) => (
					<EntityCardSkeleton key={i} />
				))}
			</WebView>
		);
	const visible = sessions.slice(0, 3);
	return (
		<WebView recipe={styles.overviewList}>
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
							router.push(
								agentId
									? {
											pathname: "/agents/[id]/sessions/[sessionId]",
											params: { id: agentId, sessionId: session.id },
										}
									: { pathname: "/sessions/[id]", params: { id: session.id } },
							)
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
					recipe={`${ENTITY_CARD_BASE} ${styles.card} ${styles.emptyRow}`}
					style={{ minHeight: 80 }}
				>
					{!visible.length && !index ? (
						<WebText recipe={styles.emptyRow}>{emptyMessage}</WebText>
					) : null}
				</WebView>
			))}
		</WebView>
	);
}
