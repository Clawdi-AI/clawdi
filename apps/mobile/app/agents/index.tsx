import { AgentRow, BackButton, useCloudAgents } from "../../src/features/cloud-inventory";
import { useI18n } from "../../src/i18n";
import { ErrorState, LoadingScreen } from "../../src/ui/feedback";
import { AppScrollView, AppText, AppView } from "../../src/ui/primitives";

export default function AgentsRoute() {
	const t = useI18n();
	const agents = useCloudAgents();
	if (agents.isPending) return <LoadingScreen label={t("loading.agents")} />;
	return (
		<AppScrollView className="flex-1 bg-background" contentContainerStyle={{ flexGrow: 1 }}>
			<AppView className="flex-1 gap-5 px-6 pb-10 pt-6">
				<BackButton />
				<AppView className="gap-1">
					<AppText className="text-3xl font-semibold text-foreground">{t("agents.title")}</AppText>
					<AppText className="text-base leading-6 text-muted">{t("agents.description")}</AppText>
				</AppView>
				{agents.isError ? (
					<ErrorState onRetry={() => void agents.refetch()} />
				) : agents.data?.length ? (
					<AppView className="gap-3">
						{agents.data.map((agent) => (
							<AgentRow agent={agent} key={agent.id} />
						))}
					</AppView>
				) : (
					<AppView className="rounded-3xl bg-surface p-6">
						<AppText className="text-base leading-6 text-muted">{t("agents.empty")}</AppText>
					</AppView>
				)}
			</AppView>
		</AppScrollView>
	);
}
