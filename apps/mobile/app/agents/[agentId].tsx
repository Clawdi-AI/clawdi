import { useLocalSearchParams } from "expo-router";
import {
	agentDisplayName,
	BackButton,
	formatDate,
	useCloudAgent,
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

export default function AgentDetailRoute() {
	const t = useI18n();
	const params = useLocalSearchParams<{ agentId?: string | string[] }>();
	const agentId = searchParam(params.agentId);
	const agent = useCloudAgent(agentId);
	if (agent.isPending) return <LoadingScreen label={t("loading.agent")} />;
	return (
		<AppScrollView className="flex-1 bg-background" contentContainerStyle={{ flexGrow: 1 }}>
			<AppView className="flex-1 gap-5 px-6 pb-10 pt-6">
				<BackButton />
				{agent.isError || !agent.data ? (
					<ErrorState onRetry={() => void agent.refetch()} />
				) : (
					<>
						<AppView className="gap-1">
							<AppText className="text-3xl font-semibold text-foreground">
								{agentDisplayName(agent.data)}
							</AppText>
							<AppText className="text-base leading-6 text-muted">
								{t("agents.detailDescription")}
							</AppText>
						</AppView>
						<AppView className="gap-3">
							<DetailRow label={t("agents.type")} value={agent.data.agent_type} />
							<DetailRow label={t("agents.machine")} value={agent.data.machine_name} />
							<DetailRow label={t("agents.operatingSystem")} value={agent.data.os} />
							<DetailRow
								label={t("agents.version")}
								value={agent.data.agent_version ?? t("agents.unknown")}
							/>
							<DetailRow
								label={t("agents.lastSeen")}
								value={formatDate(agent.data.last_seen_at) ?? t("agents.neverSeen")}
							/>
							<DetailRow
								label={t("agents.lastSync")}
								value={formatDate(agent.data.last_sync_at) ?? t("agents.unknown")}
							/>
							<DetailRow
								label={t("agents.syncEnabled")}
								value={agent.data.sync_enabled ? t("common.yes") : t("common.no")}
							/>
							{agent.data.adapter_modules?.length ? (
								<DetailRow
									label={t("agents.adapters")}
									value={agent.data.adapter_modules.join(", ")}
								/>
							) : null}
						</AppView>
					</>
				)}
			</AppView>
		</AppScrollView>
	);
}
