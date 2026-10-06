import { validateSessionDetailSearch } from "@clawdi/shared/api";
import { detailLayoutClasses, sessionDetailClasses as styles } from "@clawdi/shared/ui";
import {
	formatDuration,
	formatNumber,
	relativeTime,
	sessionAgentIdentityInput,
	sessionHasLaterActivity,
	sessionTitle,
} from "@clawdi/shared/view";
import { router, useLocalSearchParams } from "expo-router";
import { ArrowLeft, Clock, Hash, MessageSquare, Zap } from "lucide-react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, PageHeaderSkeleton } from "@/components/page-header";
import { AgentInline, DetailMeta, ModelBadge, Stat } from "@/components/sessions/meta";
import { SessionShareActions } from "@/components/sessions/share-controls";
import { MessagesSkeleton } from "@/components/sessions/skeleton";
import { Transcript } from "@/components/sessions/virtualized-message-list";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
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
	const back = (
		<Button
			variant="ghost"
			className="self-start"
			size="sm"
			onPress={() => (router.canGoBack() ? router.back() : router.replace("/sessions"))}
		>
			<Icon as={ArrowLeft} />
			<Text>{t("sessionDetail.back")}</Text>
		</Button>
	);
	if (!session)
		return (
			<SafeAreaScreen>
				<AppScrollView contentContainerStyle={{ padding: 16 }}>
					<WebView recipe={styles.page} className="px-0">
						{back}
						{query.isPending && sessionId ? (
							<>
								<PageHeaderSkeleton actions description={false} />
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
	const header = (
		<WebView recipe={styles.header}>
			{back}
			<PageHeader
				title={sessionTitle(session)}
				className={webView(styles.header)}
				status={
					<DetailMeta>
						<AgentInline identity={sessionAgentIdentityInput(session)} />
						{session.project_path ? (
							<>
								<WebText recipe={detailLayoutClasses.meta}>·</WebText>
								<WebText recipe={styles.project}>{session.project_path}</WebText>
							</>
						) : null}
						<WebText recipe={detailLayoutClasses.meta}>·</WebText>
						<WebText recipe={detailLayoutClasses.meta}>
							Started {relativeTime(session.started_at)}
						</WebText>
						{sessionHasLaterActivity(session.started_at, session.last_activity_at) ? (
							<>
								<WebText recipe={detailLayoutClasses.meta}>·</WebText>
								<WebText recipe={detailLayoutClasses.meta}>
									Last activity {relativeTime(session.last_activity_at)}
								</WebText>
							</>
						) : null}
						<ModelBadge modelId={session.model} />
						<Stat icon={MessageSquare} label={`${session.message_count} messages`} />
						<Stat
							icon={Zap}
							label={`${formatNumber((session.input_tokens ?? 0) + (session.output_tokens ?? 0))} tokens`}
						/>
						{session.duration_seconds ? (
							<Stat icon={Clock} label={formatDuration(session.duration_seconds)} />
						) : null}
						<Stat icon={Hash} label={session.local_session_id.slice(0, 8)} />
					</DetailMeta>
				}
				actions={<SessionShareActions sessionId={session.id} hasContent={session.has_content} />}
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
