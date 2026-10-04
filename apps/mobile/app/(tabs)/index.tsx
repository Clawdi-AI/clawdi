import { useUser } from "@clerk/expo";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { RefreshControl } from "react-native";
import { isMobilePreview } from "../../src/config/preview";
import {
	AgentRow,
	SessionRow,
	useCloudAgents,
	useCloudSessions,
} from "../../src/features/cloud-inventory";
import { PreviewHome } from "../../src/features/preview";
import { useI18n } from "../../src/i18n";
import {
	accountQueryKey,
	useAccountRead,
	useAccountScope,
} from "../../src/platform/account-lifecycle";
import { useMobileApi } from "../../src/providers/api-provider";
import { CloudActions } from "../../src/ui/cloud-actions";
import { ErrorState, LoadingScreen } from "../../src/ui/feedback";
import { AppScrollView, AppText, AppView } from "../../src/ui/primitives";

export default function HomeRoute() {
	if (isMobilePreview()) return <PreviewHome />;
	const t = useI18n();
	const { isLoaded, user } = useUser();
	const router = useRouter();
	const agents = useCloudAgents();
	const sessions = useCloudSessions();
	const { cloud } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const stats = useQuery({
		queryKey: accountQueryKey(scope, "dashboard-stats"),
		queryFn: ({ signal }) => read((readSignal) => cloud.getDashboardStats(readSignal), signal),
		enabled: scope.isReady,
		retry: false,
	});
	const displayName = user?.firstName ?? user?.primaryEmailAddress?.emailAddress;
	return (
		<AppScrollView
			className="flex-1 bg-background"
			contentContainerStyle={{ flexGrow: 1 }}
			refreshControl={
				<RefreshControl
					refreshing={agents.isRefetching || sessions.isRefetching || stats.isRefetching}
					onRefresh={() => {
						if (!agents.isFetching) void agents.refetch();
						if (!sessions.isFetching) void sessions.refetch();
						if (!stats.isFetching) void stats.refetch();
					}}
				/>
			}
		>
			<AppView className="flex-1 gap-6 px-6 pb-10 pt-8">
				<AppView className="gap-1">
					<AppText className="text-base text-muted">{t("home.greeting")}</AppText>
					<AppText className="text-3xl font-semibold text-foreground">
						{isLoaded && displayName ? displayName : t("app.name")}
					</AppText>
				</AppView>
				<CloudActions />
				{stats.isPending ? <LoadingScreen /> : null}
				{stats.isError ? (
					<ErrorState onRetry={stats.isFetching ? undefined : () => void stats.refetch()} />
				) : null}
				{stats.data ? (
					<AppView className="gap-3 rounded-3xl bg-surface p-5">
						<AppText className="text-lg font-semibold text-foreground">
							{t("home.statsTitle")}
						</AppText>
						<AppView className="flex-row flex-wrap gap-4">
							<Stat label={t("home.statsSessions")} value={stats.data.total_sessions} />
							<Stat label={t("home.statsMessages")} value={stats.data.total_messages} />
							<Stat label={t("home.statsProjects")} value={stats.data.projects_count} />
							<Stat label={t("home.statsSkills")} value={stats.data.skills_count} />
						</AppView>
					</AppView>
				) : null}
				<AppView className="gap-3">
					<SectionHeader title={t("home.agentsTitle")} onPress={() => router.push("/agents")} />
					{agents.isPending ? (
						<LoadingScreen label={t("loading.agents")} />
					) : agents.isError ? (
						<ErrorState onRetry={agents.isFetching ? undefined : () => void agents.refetch()} />
					) : agents.data?.length ? (
						agents.data.slice(0, 3).map((agent) => <AgentRow agent={agent} key={agent.id} />)
					) : (
						<AppView className="rounded-3xl bg-surface p-5">
							<AppText className="text-base leading-6 text-muted">{t("agents.empty")}</AppText>
						</AppView>
					)}
				</AppView>
				<AppView className="gap-3">
					<SectionHeader title={t("home.sessionsTitle")} onPress={() => router.push("/sessions")} />
					{sessions.isPending ? (
						<LoadingScreen label={t("loading.sessions")} />
					) : sessions.isError ? (
						<ErrorState onRetry={sessions.isFetching ? undefined : () => void sessions.refetch()} />
					) : sessions.data?.pages[0]?.items.length ? (
						sessions.data.pages[0]?.items
							.slice(0, 3)
							.map((session) => <SessionRow key={session.id} session={session} />)
					) : (
						<AppView className="rounded-3xl bg-surface p-5">
							<AppText className="text-base leading-6 text-muted">{t("sessions.empty")}</AppText>
						</AppView>
					)}
				</AppView>
			</AppView>
		</AppScrollView>
	);
}

function Stat({ label, value }: { label: string; value: number }) {
	return (
		<AppView className="flex-1 gap-1">
			<AppText className="text-2xl font-semibold text-foreground">{value}</AppText>
			<AppText className="text-sm text-muted">{label}</AppText>
		</AppView>
	);
}

function SectionHeader({ title, onPress }: { title: string; onPress: () => void }) {
	const t = useI18n();
	return (
		<AppView className="flex-row items-center justify-between gap-3">
			<AppText className="text-xl font-semibold text-foreground">{title}</AppText>
			<AppText
				accessibilityRole="button"
				onPress={onPress}
				className="text-sm font-semibold text-primary"
			>
				{t("inventory.viewAll")}
			</AppText>
		</AppView>
	);
}
