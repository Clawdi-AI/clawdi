import { useLocalSearchParams } from "expo-router";
import {
	BackButton,
	formatDate,
	isNotFound,
	sessionDisplayName,
	useCloudSession,
} from "../../src/features/cloud-inventory";
import { routeParam } from "../../src/features/read-helpers";
import { ResourceError } from "../../src/features/resource-error";
import { Transcript } from "../../src/features/transcript";
import { useI18n } from "../../src/i18n";
import { LoadingScreen } from "../../src/ui/feedback";
import { DetailRow } from "../../src/ui/metadata-row";
import { AppScrollView, AppText, AppView } from "../../src/ui/primitives";
import { ReadScreen } from "../../src/ui/read-screen";

export default function SessionDetailRoute() {
	const t = useI18n();
	const params = useLocalSearchParams<{ sessionId?: string | string[] }>();
	const sessionId = routeParam(params.sessionId);
	const session = useCloudSession(sessionId);
	if (sessionId && session.isPending) return <LoadingScreen label={t("loading.session")} />;
	const header = (
		<AppView className="bg-background">
			<AppView className="gap-5">
				<BackButton />
				{!sessionId || session.isError || !session.data ? (
					<ResourceError
						missing={!sessionId || isNotFound(session.error)}
						onRetry={session.isFetching ? undefined : () => void session.refetch()}
					/>
				) : (
					<>
						<AppView className="gap-1">
							<AppText className="text-3xl font-semibold text-foreground">
								{sessionDisplayName(session.data)}
							</AppText>
							<AppText className="text-base leading-6 text-muted">
								{t("sessions.detailDescription")}
							</AppText>
						</AppView>
						<AppView className="gap-3">
							<DetailRow
								label={t("sessions.agent")}
								value={
									session.data.agent_display_name ??
									session.data.agent_name ??
									session.data.agent_type ??
									t("sessions.unknownAgent")
								}
							/>
							<DetailRow label={t("sessions.status")} value={session.data.status} />
							<DetailRow
								label={t("sessions.project")}
								value={session.data.project_path ?? t("sessions.unknownProject")}
							/>
							<DetailRow label={t("sessions.localId")} value={session.data.local_session_id} />
							<DetailRow
								label={t("sessions.started")}
								value={formatDate(session.data.started_at) ?? t("sessions.unknownActivity")}
							/>
							<DetailRow
								label={t("sessions.lastActivity")}
								value={formatDate(session.data.last_activity_at) ?? t("sessions.unknownActivity")}
							/>
							<DetailRow
								label={t("sessions.ended")}
								value={formatDate(session.data.ended_at) ?? t("sessions.inProgress")}
							/>
							<DetailRow
								label={t("sessions.messages")}
								value={String(session.data.message_count)}
							/>
							<DetailRow
								label={t("sessions.model")}
								value={session.data.model ?? t("sessions.unknownModel")}
							/>
							{session.data.tags?.length ? (
								<DetailRow label={t("sessions.tags")} value={session.data.tags.join(", ")} />
							) : null}
						</AppView>
					</>
				)}
			</AppView>
		</AppView>
	);
	return session.data && !session.isError ? (
		<Transcript sessionId={session.data.id} header={header} />
	) : (
		<ReadScreen>
			<AppScrollView contentContainerStyle={{ padding: 24, flexGrow: 1 }}>{header}</AppScrollView>
		</ReadScreen>
	);
}
