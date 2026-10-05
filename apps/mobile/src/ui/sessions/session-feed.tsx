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
import { AgentIcon } from "../dashboard/agent-icon";
import { EmptyState } from "../empty-state";
import { ENTITY_CARD_BASE } from "../entity-card";
import { SectionLabel } from "../section-label";
import { Skeleton } from "../skeleton";
import { AppPressable } from "../view";
import { WebText, WebView, webView } from "../web-layout";
export function SessionCardSkeleton() {
	return (
		<WebView recipe={`${ENTITY_CARD_BASE} ${styles.flexMinHSessionRow}`} style={{ minHeight: 80 }}>
			<Skeleton className={webView(styles.size8Shrink0Rounded)} />
			<WebView recipe={styles.minW0Flex1}>
				<Skeleton className={webView(styles.hLhW45)} style={{ height: 20 }} />
				<WebView recipe={styles.mt05MinH}>
					<Skeleton className={webView(styles.hLhW12)} style={{ height: 16 }} />
					<Skeleton className={webView(styles.hLhW13)} style={{ height: 16 }} />
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
			<WebView recipe={styles.flexFlexColGap2}>
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
		<WebView recipe={styles.flexFlexColGap5}>
			{groupSessionsByRecency(sessions, groupBy).map((group) => (
				<WebView key={group.key} recipe={styles.flexFlexColGap2}>
					<SectionLabel>{group.label}</SectionLabel>
					<WebView recipe={styles.flexFlexColGap2}>{group.items.map(card)}</WebView>
				</WebView>
			))}
		</WebView>
	) : (
		<WebView recipe={styles.flexFlexColGap2}>{sessions.map(card)}</WebView>
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
				webView(styles.flexMinHSessionRow),
				webView(styles.groupHoverBgMuted50),
				isAutomated && webView(styles.bgMuted30),
			)}
			style={{ minHeight: 80 }}
			onPress={() => {
				const { search } = sessionDetailLink(session, { searchQuery });
				router.push({
					pathname: "/sessions/[sessionId]",
					params: {
						sessionId: session.id,
						...(search.matchKind ? { matchKind: search.matchKind } : {}),
						...(search.matchPosition !== undefined
							? { matchPosition: String(search.matchPosition) }
							: {}),
						...(search.matchRevision ? { matchRevision: search.matchRevision } : {}),
						...(search.matchQuery ? { matchQuery: search.matchQuery } : {}),
					},
				});
			}}
		>
			<AgentIcon agent={session.agent_type} size="lg" />
			<WebView recipe={styles.w0MinW0}>
				<WebText recipe={styles.blockTruncateTextSmLeading} numberOfLines={1}>
					{title}
				</WebText>
				{session.search_match ? (
					<WebText recipe={styles.mt05LineClamp} numberOfLines={2}>
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
				<WebView recipe={styles.mt05FlexMin}>
					{metadata.map((item, i) => (
						<WebView key={item.key} recipe={styles.inlineFlexMinW0} className="flex-row">
							{i > 0 ? <WebText recipe={styles.mx15Shrink0}>·</WebText> : null}
							<WebText
								recipe={`${styles.minW0Truncate} ${item.key === "project" ? styles.fontMono : ""}`}
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
