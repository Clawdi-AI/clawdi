import { validateSessionDetailSearch } from "@clawdi/shared/api";
import { detailLayoutClasses, sessionDetailClasses as styles } from "@clawdi/shared/ui";
import {
	formatDuration,
	formatNumber,
	profileLabel,
	relativeTime,
	sessionAgentIdentityInput,
	sessionHasLaterActivity,
	sessionTitle,
} from "@clawdi/shared/view";
import { useLocalSearchParams } from "expo-router";
import Clock from "lucide-react-native/icons/clock";
import Hash from "lucide-react-native/icons/hash";
import MessageSquare from "lucide-react-native/icons/message-square";
import Zap from "lucide-react-native/icons/zap";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, PageHeaderSkeleton } from "@/components/page-header";
import { AgentInline, DetailMeta, ModelBadge, Stat } from "@/components/sessions/meta";
import { SessionShareActions } from "@/components/sessions/share-controls";
import { MessagesSkeleton } from "@/components/sessions/skeleton";
import { Transcript } from "@/components/sessions/virtualized-message-list";
import { AppScrollView } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { isNotFound, useCloudSession } from "@/hooks/cloud-inventory";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

export default function SessionDetailRoute() {
	const t = useI18n();
	const params = useLocalSearchParams<{ id?: string | string[]; sessionId?: string | string[] }>();
	const sessionId = routeParam(params.sessionId ?? params.id);
	const query = useCloudSession(sessionId);
	const session = !query.isError ? query.data : undefined;
	if (!session)
		return (
			<SafeAreaScreen>
				<AppScrollView contentContainerStyle={{ padding: 16 }}>
					<WebView recipe={styles.page} className="px-0">
						{query.isPending && sessionId ? (
							<>
								<PageHeaderSkeleton description={false} />
								<MessagesSkeleton />
							</>
						) : isNotFound(query.error) || !sessionId ? (
							<EmptyState
								title={t("sessionDetail.notFound")}
								description={t("sessionDetail.notFoundDescription")}
							/>
						) : (
							<ApiErrorPanel error={query.error} onRetry={() => void query.refetch()} />
						)}
					</WebView>
				</AppScrollView>
			</SafeAreaScreen>
		);
	const profile = profileLabel(session);
	const header = (
		<WebView recipe={styles.header}>
			<PageHeader
				testID={`session-detail-${session.id}`}
				title={sessionTitle(session)}
				className={webView(styles.header)}
				status={
					<DetailMeta>
						<AgentInline identity={sessionAgentIdentityInput(session)} />
						{profile ? (
							<>
								<WebText recipe={detailLayoutClasses.meta}>·</WebText>
								<WebText recipe={detailLayoutClasses.meta} numberOfLines={1}>
									{profile}
								</WebText>
							</>
						) : null}
						{session.project_path ? (
							<>
								<WebText recipe={detailLayoutClasses.meta}>·</WebText>
								<WebText recipe={styles.project}>{session.project_path}</WebText>
							</>
						) : null}
						<WebText recipe={detailLayoutClasses.meta}>·</WebText>
						<WebText recipe={detailLayoutClasses.meta}>
							{t("sessionFilters.started_at")} {relativeTime(session.started_at)}
						</WebText>
						{sessionHasLaterActivity(session.started_at, session.last_activity_at) ? (
							<>
								<WebText recipe={detailLayoutClasses.meta}>·</WebText>
								<WebText recipe={detailLayoutClasses.meta}>
									{t("sessionFilters.last_activity_at")} {relativeTime(session.last_activity_at)}
								</WebText>
							</>
						) : null}
						<ModelBadge modelId={session.model} />
						<Stat
							icon={MessageSquare}
							label={t("labels.messageCount", { count: session.message_count })}
						/>
						<Stat
							icon={Zap}
							label={t("labels.tokenCount", {
								count: formatNumber((session.input_tokens ?? 0) + (session.output_tokens ?? 0)),
							})}
						/>
						{session.duration_seconds ? (
							<Stat icon={Clock} label={formatDuration(session.duration_seconds)} />
						) : null}
						<Stat icon={Hash} label={session.local_session_id.slice(0, 8)} />
					</DetailMeta>
				}
			/>
			<SessionShareActions
				title={sessionTitle(session)}
				sessionId={session.id}
				hasContent={session.has_content}
			/>
		</WebView>
	);
	return (
		<Transcript
			sessionId={session.id}
			agentType={session.agent_type}
			hasContent={session.has_content}
			relatedRefs={session.related_refs}
			header={header}
			search={validateSessionDetailSearch(params)}
		/>
	);
}
