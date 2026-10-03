import { useLocalSearchParams, useRouter } from "expo-router";
import {
	agentDisplayName,
	BackButton,
	formatDate,
	isNotFound,
	useCloudAgent,
} from "../../src/features/cloud-inventory";
import { routeParam } from "../../src/features/read-helpers";
import { ResourceError } from "../../src/features/resource-error";
import { useI18n } from "../../src/i18n";
import { LoadingScreen } from "../../src/ui/feedback";
import { DetailRow } from "../../src/ui/metadata-row";
import { NativeButton } from "../../src/ui/native-controls";
import { AppScrollView, AppText, AppView } from "../../src/ui/primitives";
import { ReadScreen } from "../../src/ui/read-screen";

export default function AgentDetailRoute() {
	const t = useI18n();
	const router = useRouter();
	const params = useLocalSearchParams<{ agentId?: string | string[] }>();
	const agentId = routeParam(params.agentId);
	const agent = useCloudAgent(agentId);
	if (agentId && agent.isPending) return <LoadingScreen label={t("loading.agent")} />;
	return (
		<ReadScreen>
			<AppScrollView className="flex-1 bg-background" contentContainerStyle={{ flexGrow: 1 }}>
				<AppView className="flex-1 gap-5 px-6 pb-10 pt-6">
					<BackButton />
					{!agentId || agent.isError || !agent.data ? (
						<ResourceError
							missing={!agentId || isNotFound(agent.error)}
							onRetry={agent.isFetching ? undefined : () => void agent.refetch()}
						/>
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
								<NativeButton
									label={t("agentExtensions.plugins")}
									onPress={() =>
										router.push({
											pathname: "/agents/[agentId]/plugins",
											params: { agentId: agent.data.id },
										})
									}
								/>
								<NativeButton
									label={t("agentExtensions.title")}
									onPress={() =>
										router.push({
											pathname: "/agents/[agentId]/skills",
											params: { agentId: agent.data.id },
										})
									}
								/>
								<NativeButton
									label={t("agentSettings.title")}
									onPress={() =>
										router.push({
											pathname: "/agents/[agentId]/settings",
											params: { agentId: agent.data.id },
										})
									}
								/>
								<NativeButton
									label={t("bindings.title")}
									onPress={() =>
										router.push({
											pathname: "/agents/[agentId]/projects",
											params: { agentId: agent.data.id },
										})
									}
								/>
								<NativeButton
									label={t("sessions.title")}
									onPress={() =>
										router.push({ pathname: "/sessions", params: { agentId: agent.data.id } })
									}
								/>
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
		</ReadScreen>
	);
}
