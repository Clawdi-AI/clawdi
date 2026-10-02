import { useLocalSearchParams } from "expo-router";
import {
	BackButton,
	formatDate,
	sessionDisplayName,
	useCloudSession,
} from "../../src/features/cloud-inventory";
import { useI18n } from "../../src/i18n";
import { ErrorState, LoadingScreen } from "../../src/ui/feedback";
import { AppScrollView, AppText, AppView } from "../../src/ui/primitives";

function searchParam(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function DetailRow({ label, value }: { label: string; value: string }) {
	return (
		<AppView className="gap-1 rounded-2xl bg-surface px-4 py-3">
			<AppText className="text-sm text-muted">{label}</AppText>
			<AppText className="text-base text-foreground">{value}</AppText>
		</AppView>
	);
}

export default function SessionDetailRoute() {
	const t = useI18n();
	const params = useLocalSearchParams<{ sessionId?: string | string[] }>();
	const sessionId = searchParam(params.sessionId);
	const session = useCloudSession(sessionId);
	if (session.isPending) return <LoadingScreen label={t("loading.session")} />;
	return (
		<AppScrollView className="flex-1 bg-background" contentContainerStyle={{ flexGrow: 1 }}>
			<AppView className="flex-1 gap-5 px-6 pb-10 pt-6">
				<BackButton />
				{session.isError || !session.data ? (
					<ErrorState onRetry={() => void session.refetch()} />
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
		</AppScrollView>
	);
}
