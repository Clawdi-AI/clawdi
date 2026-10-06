import {
	SEARCH_MARK_CLASS,
	type SessionListItem,
	sessionDetailLink,
	splitSearchHighlight,
} from "@clawdi/shared/api";
import { sessionFeedClasses as styles } from "@clawdi/shared/ui";
import {
	agentIdentity,
	formatNumber,
	groupSessionsByRecency,
	relativeTime,
	sessionAgentIdentityInput,
	sessionCardModel,
} from "@clawdi/shared/view";
import { cn } from "cn";
import { router } from "expo-router";
import { MessageSquare } from "lucide-react-native";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { EmptyState } from "@/components/empty-state";
import { ENTITY_CARD_BASE } from "@/components/entity-card";
import { SectionLabel } from "@/components/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { AppPressable } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useAgentRouteId } from "@/platform/navigation/use-agent-route";
export function SessionCardSkeleton() {
	return (
		<WebView recipe={`${ENTITY_CARD_BASE} ${styles.card}`} style={{ minHeight: 80 }}>
			<Skeleton className={webView(styles.avatarSkeleton)} />
			<WebView recipe={styles.skeletonBody}>
				<Skeleton className={webView(styles.titleSkeleton)} style={{ height: 20 }} />
				<WebView recipe={styles.skeletonMeta}>
					<Skeleton className={webView(styles.metaSkeleton)} style={{ height: 16 }} />
					<Skeleton className={webView(styles.secondaryMetaSkeleton)} style={{ height: 16 }} />
				</WebView>
			</WebView>
		</WebView>
	);
}
export function SessionFeed({
	sessions,
	isLoading,
	emptyMessage,
	emptyVariant = "page",
	grouped = true,
	groupBy = "last_activity_at",
	showAgent = true,
	quietAutomated = true,
	searchQuery = "",
}: {
	sessions: SessionListItem[];
	isLoading: boolean;
	emptyMessage: string;
	emptyVariant?: "page" | "inset";
	grouped?: boolean;
	groupBy?: "last_activity_at" | "started_at";
	showAgent?: boolean;
	quietAutomated?: boolean;
	searchQuery?: string;
}) {
	if (isLoading)
		return (
			<WebView recipe={styles.list}>
				{Array.from({ length: 5 }, (_, i) => (
					<SessionCardSkeleton key={i} />
				))}
			</WebView>
		);
	if (!sessions.length)
		return <EmptyState variant={emptyVariant} icon={MessageSquare} description={emptyMessage} />;
	const card = (session: SessionListItem) => (
		<SessionCard
			key={session.id}
			session={session}
			showAgent={showAgent}
			quietAutomated={quietAutomated}
			searchQuery={searchQuery}
		/>
	);
	return grouped ? (
		<WebView recipe={styles.groups}>
			{groupSessionsByRecency(sessions, groupBy).map((group) => (
				<WebView key={group.key} recipe={styles.list}>
					<SectionLabel>{group.label}</SectionLabel>
					<WebView recipe={styles.list}>{group.items.map(card)}</WebView>
				</WebView>
			))}
		</WebView>
	) : (
		<WebView recipe={styles.list}>{sessions.map(card)}</WebView>
	);
}
export function SessionCard({
	session,
	showAgent = true,
	quietAutomated = true,
	searchQuery = "",
}: {
	session: SessionListItem;
	showAgent?: boolean;
	quietAutomated?: boolean;
	searchQuery?: string;
}) {
	const agentId = useAgentRouteId();
	const { title, projectFolder, totalTokens, isAutomated } = sessionCardModel(
		session,
		quietAutomated,
	);
	const agent = agentIdentity(sessionAgentIdentityInput(session)).primaryLabel;
	const metadata = [
		showAgent ? { key: "agent", value: agent } : null,
		projectFolder ? { key: "project", value: projectFolder } : null,
		{
			key: "messages",
			value: `${session.message_count} ${session.message_count === 1 ? "message" : "messages"}`,
		},
		{ key: "tokens", value: `${formatNumber(totalTokens)} tokens` },
		{ key: "time", value: relativeTime(session.last_activity_at) },
	].filter((item) => item !== null);
	return (
		<AppPressable
			accessibilityRole="link"
			accessibilityLabel={`Open session ${title}`}
			className={cn(
				ENTITY_CARD_BASE,
				webView(styles.card),
				webView(styles.link),
				isAutomated && webView(styles.automated),
			)}
			style={{ minHeight: 80 }}
			onPress={() => {
				const { search } = sessionDetailLink(session, { searchQuery });
				const params = {
					...(search.matchKind ? { matchKind: search.matchKind } : {}),
					...(search.matchPosition !== undefined
						? { matchPosition: String(search.matchPosition) }
						: {}),
					...(search.matchRevision ? { matchRevision: search.matchRevision } : {}),
					...(search.matchQuery ? { matchQuery: search.matchQuery } : {}),
				};
				router.push(
					agentId
						? {
								pathname: "/agents/[id]/sessions/[sessionId]",
								params: { ...params, id: agentId, sessionId: session.id },
							}
						: { pathname: "/sessions/[id]", params: { ...params, id: session.id } },
				);
			}}
		>
			<AgentIcon agent={session.agent_type} size="lg" />
			<WebView recipe={styles.body}>
				<WebText recipe={styles.title} numberOfLines={1}>
					{title}
				</WebText>
				{session.search_match ? (
					<WebText recipe={styles.searchExcerpt} numberOfLines={2}>
						<WebText recipe={styles.searchRole}>{session.search_match.role}</WebText>
						{": "}
						{splitSearchHighlight(session.search_match.excerpt, searchQuery).map((part, index) => (
							<WebText
								key={`${index}:${part.text}`}
								recipe={part.highlighted ? SEARCH_MARK_CLASS : ""}
							>
								{part.text}
							</WebText>
						))}
					</WebText>
				) : null}
				<WebView recipe={styles.meta}>
					{metadata.map((item, i) => (
						<WebView key={item.key} recipe={styles.metaItem} className="flex-row">
							{i > 0 ? <WebText recipe={styles.metaSeparator}>·</WebText> : null}
							<WebText
								recipe={`${styles.metaValue} ${item.key === "project" ? styles.project : ""}`}
								numberOfLines={1}
							>
								{item.value}
							</WebText>
						</WebView>
					))}
				</WebView>
			</WebView>
		</AppPressable>
	);
}
