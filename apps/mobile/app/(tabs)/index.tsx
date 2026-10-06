import { useUser } from "@clerk/expo";
import { useRouter } from "expo-router";
import {
	AgentRow,
	SessionRow,
	useCloudAgents,
	useCloudSessions,
} from "../../src/features/cloud-inventory";
import { useI18n } from "../../src/i18n";
import { ErrorState, LoadingScreen } from "../../src/ui/feedback";
import { AppScrollView, AppText, AppView } from "../../src/ui/primitives";

export default function HomeRoute() {
	const t = useI18n();
	const { isLoaded, user } = useUser();
	const router = useRouter();
	const agents = useCloudAgents();
	const sessions = useCloudSessions();
	const displayName = user?.firstName ?? user?.primaryEmailAddress?.emailAddress;
	return (
		<AppScrollView className="flex-1 bg-background" contentContainerStyle={{ flexGrow: 1 }}>
			<AppView className="flex-1 gap-6 px-6 pb-10 pt-8">
				<AppView className="gap-1">
					<AppText className="text-base text-muted">{t("home.greeting")}</AppText>
					<AppText className="text-3xl font-semibold text-foreground">
						{isLoaded && displayName ? displayName : t("app.name")}
					</AppText>
				</AppView>
				<AppView className="gap-3">
					<SectionHeader title={t("home.agentsTitle")} onPress={() => router.push("/agents")} />
					{agents.isPending ? (
						<LoadingScreen label={t("loading.agents")} />
					) : agents.isError ? (
						<ErrorState onRetry={() => void agents.refetch()} />
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
						<ErrorState onRetry={() => void sessions.refetch()} />
					) : sessions.data?.items.length ? (
						sessions.data.items
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
