import {
	effectiveAgentProjectIds,
	isActiveConnection,
	linkedAgentProjectCount,
	resolveAgentWorkspaceProjectId,
} from "@clawdi/shared/api";
import {
	connectedAgentDetailClasses as detail,
	RESOURCE_TINT_CLASSES,
	agentOverviewCapabilitiesClasses as styles,
} from "@clawdi/shared/ui";
import {
	agentOverviewSummary,
	agentOverviewCopy as copy,
	daemonStatusPresentation,
	daemonStatusVisual,
	fetchAgentProjectSkills,
	fetchAgentProjectVaults,
	relativeTime,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Brain, FolderKanban, KeyRound, Laptop, Plug, Sparkles } from "lucide-react-native";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import {
	AgentOverviewHeading,
	OverviewMetadata,
	OverviewNavigationCard,
} from "../ui/agents/overview";
import { AgentRecentSessions } from "../ui/agents/recent-sessions";
import { ApiErrorPanel } from "../ui/api-error-panel";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { StatusDot } from "../ui/status-badge";
import { Text } from "../ui/text";
import { WebView } from "../ui/web-layout";
import { type CloudAgent, useCloudSessions } from "./cloud-inventory";
export function AgentOverview({ agent }: { agent: CloudAgent }) {
	const scope = useAccountScope(),
		read = useAccountRead(),
		api = useMobileApi();
	const supportsSessions = !agent.adapter_modules || agent.adapter_modules.includes("sessions");
	const sessions = useCloudSessions(agent.id, supportsSessions, { page_size: 3 });
	const bindings = useQuery({
		queryKey: accountQueryKey(scope, "agent-overview-bindings", agent.id),
		enabled: scope.isReady,
		retry: false,
		queryFn: ({ signal }) => read((s) => api.agentProjects.listBindings(agent.id, s), signal),
	});
	const workspace = resolveAgentWorkspaceProjectId(bindings.data ?? [], agent.default_project_id);
	const projectIds = effectiveAgentProjectIds(bindings.data ?? []);
	const skills = useQuery({
		queryKey: accountQueryKey(scope, "agent-overview-skills", workspace),
		enabled: scope.isReady && Boolean(workspace),
		retry: false,
		queryFn: ({ signal }) =>
			read(
				(s) =>
					fetchAgentProjectSkills(workspace ? [workspace] : [], (project_id, page, page_size) =>
						api.cloud.listSkills({ project_id, page, page_size }, s),
					),
				signal,
			),
	});
	const vaults = useQuery({
		queryKey: accountQueryKey(scope, "agent-overview-vaults", projectIds),
		enabled: scope.isReady && projectIds.length > 0,
		retry: false,
		queryFn: ({ signal }) =>
			read(
				(s) =>
					fetchAgentProjectVaults(projectIds, (project_id, page, page_size) =>
						api.vault.list({ project_id, page, page_size }, s),
					),
				signal,
			),
	});
	const memories = useQuery({
		queryKey: accountQueryKey(scope, "agent-overview-memories"),
		enabled: scope.isReady,
		retry: false,
		queryFn: ({ signal }) =>
			read((s) => api.cloud.listMemories({ page: 1, page_size: 1 }, s), signal),
	});
	const connections = useQuery({
		queryKey: accountQueryKey(scope, "connectors"),
		enabled: scope.isReady,
		retry: false,
		queryFn: ({ signal }) => read((s) => api.connectors.list(s), signal),
	});
	const status = daemonStatusVisual(agent);
	const summary = (
		kind: Parameters<typeof agentOverviewSummary>[0],
		count: number,
		pending: boolean,
		error: unknown,
	) =>
		pending ? (
			<Skeleton className="h-4 w-32" />
		) : error ? (
			copy.unavailable
		) : (
			agentOverviewSummary(kind, count)
		);
	return (
		<WebView recipe={styles.flexFlexColGap}>
			<WebView recipe={detail.flexFlexColGap}>
				{supportsSessions ? (
					<>
						<AgentOverviewHeading
							action={
								<Button
									variant="ghost"
									size="sm"
									onPress={() =>
										router.push({ pathname: "/sessions", params: { agentId: agent.id } })
									}
								>
									<Text>{copy.viewAll} →</Text>
								</Button>
							}
						>
							{copy.recentSessions}
						</AgentOverviewHeading>
						{sessions.isError && !sessions.data ? (
							<ApiErrorPanel error={sessions.error} onRetry={() => void sessions.refetch()} />
						) : (
							<AgentRecentSessions
								sessions={sessions.data?.pages.flatMap((page) => page.items) ?? []}
								loading={sessions.isPending}
								emptyMessage={copy.noRecentSessions}
							/>
						)}
					</>
				) : null}
				<OverviewNavigationCard
					title={copy.status}
					description={
						<WebView recipe={styles.flexMinWItems2} className="flex-row">
							<StatusDot status={daemonStatusPresentation(agent).tone} />
							<Text>{status.label}</Text>
						</WebView>
					}
					icon={Laptop}
					tint={detail.statusTint}
					onPress={() =>
						router.push({ pathname: "/agents/[agentId]/settings", params: { agentId: agent.id } })
					}
				>
					<OverviewMetadata
						items={[
							{ label: copy.machine, value: agent.machine_name },
							{ label: copy.lastSeen, value: relativeTime(agent.last_seen_at) },
						]}
					/>
				</OverviewNavigationCard>
			</WebView>
			<WebView recipe={styles.flexFlexColGap2}>
				<AgentOverviewHeading>{copy.workspace}</AgentOverviewHeading>
				<OverviewNavigationCard
					title="Projects"
					description={summary(
						"projects",
						linkedAgentProjectCount(bindings.data ?? []),
						bindings.isPending,
						bindings.data ? null : bindings.error,
					)}
					icon={FolderKanban}
					tint={RESOURCE_TINT_CLASSES.projects}
					onPress={() =>
						router.push({ pathname: "/agents/[agentId]/projects", params: { agentId: agent.id } })
					}
				/>
				{!agent.adapter_modules || agent.adapter_modules.includes("skills") ? (
					<OverviewNavigationCard
						title="Skills"
						description={summary(
							"skills",
							new Set(skills.data?.map((skill) => skill.skill_key)).size,
							bindings.isPending || skills.isLoading,
							bindings.isError || !workspace || (skills.data ? null : skills.error),
						)}
						icon={Sparkles}
						tint={RESOURCE_TINT_CLASSES.skills}
						onPress={() =>
							router.push({ pathname: "/agents/[agentId]/skills", params: { agentId: agent.id } })
						}
					/>
				) : null}
				<OverviewNavigationCard
					title="Vaults"
					description={summary(
						"vaults",
						vaults.data?.length ?? 0,
						bindings.isPending || vaults.isLoading,
						bindings.isError || !workspace || (vaults.data ? null : vaults.error),
					)}
					icon={KeyRound}
					tint={RESOURCE_TINT_CLASSES.vaults}
					onPress={() =>
						router.push({ pathname: "/vault", params: { projectId: workspace ?? "" } })
					}
				/>
			</WebView>
			<WebView recipe={styles.flexFlexColGap2}>
				<AgentOverviewHeading>{copy.shared}</AgentOverviewHeading>
				<OverviewNavigationCard
					title="Memories"
					description={summary(
						"memories",
						memories.data?.total ?? 0,
						memories.isPending,
						memories.data ? null : memories.error,
					)}
					icon={Brain}
					tint={RESOURCE_TINT_CLASSES.memories}
					onPress={() => router.push("/memories")}
				/>
				<OverviewNavigationCard
					title="Connectors"
					description={summary(
						"connectors",
						new Set(
							connections.data?.filter(isActiveConnection).map((connection) => connection.app_name),
						).size,
						connections.isPending,
						connections.data ? null : connections.error,
					)}
					icon={Plug}
					tint={RESOURCE_TINT_CLASSES.connectors}
					onPress={() => router.push("/connectors")}
				/>
			</WebView>
		</WebView>
	);
}
