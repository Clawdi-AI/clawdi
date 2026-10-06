import { BackButton, SessionRow, useCloudSessions } from "../../src/features/cloud-inventory";
import { useI18n } from "../../src/i18n";
import { ErrorState, LoadingScreen } from "../../src/ui/feedback";
import { AppScrollView, AppText, AppView } from "../../src/ui/primitives";

export default function SessionsRoute() {
	const t = useI18n();
	const sessions = useCloudSessions();
	if (sessions.isPending) return <LoadingScreen label={t("loading.sessions")} />;
	const items = sessions.data?.items ?? [];
	return (
		<AppScrollView className="flex-1 bg-background" contentContainerStyle={{ flexGrow: 1 }}>
			<AppView className="flex-1 gap-5 px-6 pb-10 pt-6">
				<BackButton />
				<AppView className="gap-1">
					<AppText className="text-3xl font-semibold text-foreground">
						{t("sessions.title")}
					</AppText>
					<AppText className="text-base leading-6 text-muted">{t("sessions.description")}</AppText>
				</AppView>
				{sessions.isError ? (
					<ErrorState onRetry={() => void sessions.refetch()} />
				) : items.length ? (
					<AppView className="gap-3">
						{items.map((session) => (
							<SessionRow key={session.id} session={session} />
						))}
					</AppView>
				) : (
					<AppView className="rounded-3xl bg-surface p-6">
						<AppText className="text-base leading-6 text-muted">{t("sessions.empty")}</AppText>
					</AppView>
				)}
			</AppView>
		</AppScrollView>
	);
}
