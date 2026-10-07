import {
	agentPluginOverviewState,
	type DeploymentRead,
	effectiveAgentProjectIds,
	isActiveConnection,
	linkedAgentProjectCount,
	resolveAgentWorkspaceProjectId,
} from "@clawdi/shared/api";
import {
	connectedAgentDetailClasses as detail,
	hostedAgentOverviewClasses as hostedStyles,
	agentOverviewLayoutClasses as layout,
	agentOverviewCapabilitiesClasses as styles,
} from "@clawdi/shared/ui";
import {
	agentOverviewSummary,
	agentOverviewCopy as copy,
	daemonStatusPresentation,
	daemonStatusVisual,
	deploymentFailurePresentation,
	deploymentRuntimeStatusPresentation,
	fetchAgentProjectSkills,
	fetchAgentProjectVaults,
	MANAGED_PROVIDER_ID,
	modelBindingDisplayName,
	modelOptionsForProvider,
	overviewComputePresentation,
	primaryModelProviderId,
	RESOURCE_TINT_CLASSES,
	relativeTime,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import {
	ArrowUp,
	Blocks,
	Brain,
	BrainCircuit,
	Cpu,
	CreditCard,
	FolderKanban,
	KeyRound,
	Laptop,
	MessagesSquare,
	Plug,
	Settings,
	Sparkles,
	WalletCards,
} from "lucide-react-native";
import type { ReactNode } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	AgentOverviewHeading,
	OverviewMetadata,
	OverviewNavigationCard,
} from "@/components/dashboard/agent-overview-layout";
import { OverviewComputeBody } from "@/components/dashboard/overview-compute-body";
import { AgentRecentSessions } from "@/components/dashboard/recent-sessions";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-badge";
import { Text } from "@/components/ui/text";
import { WebView } from "@/components/ui/web-layout";
import { type CloudAgent, useCloudSessions } from "@/hooks/cloud-inventory";
import { RuntimeBrowser } from "@/hosted/agents/runtime-handoff";
import { ComputeDunningBanner } from "@/hosted/billing/components/compute-dunning-banner";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useStoreSurfaces } from "@/platform/store/store-provider";
export function AgentOverview({
	agent,
	deployment,
	onManage,
}: {
	agent: CloudAgent;
	deployment?: DeploymentRead;
	onManage?: () => void;
}) {
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
	const skillProjectIds = workspace ? [workspace] : [];
	const skills = useQuery({
		queryKey: accountQueryKey(scope, "agent-overview-skills", skillProjectIds),
		enabled: scope.isReady && skillProjectIds.length > 0,
		retry: false,
		queryFn: ({ signal }) =>
			read(
				(s) =>
					fetchAgentProjectSkills(skillProjectIds, (project_id, page, page_size) =>
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
	const hostedCatalog = useQuery({
		queryKey: accountQueryKey(scope, "hosted-overview-catalog"),
		enabled: scope.isReady && Boolean(deployment && api.compute),
		retry: false,
		queryFn: ({ signal }) =>
			read(async (lease) => {
				if (!api.compute) throw new Error("Compute unavailable");
				const [providers, models, plans, capabilities] = await Promise.all([
					api.aiProviders.list(lease),
					api.compute.getManagedModels(lease),
					api.compute.listPlans(lease),
					api.compute.getProductCapabilities(lease),
				]);
				return { providers: providers.providers, models: models.models, plans, capabilities };
			}, signal),
	});
	const plugins = useQuery({
		queryKey: accountQueryKey(scope, "agent-plugins", agent.id),
		enabled: scope.isReady && Boolean(deployment),
		retry: false,
		queryFn: ({ signal }) =>
			read((lease) => api.agentExtensions.listPlugins(agent.id, lease), signal),
	});
	const runtimeSkills = useQuery({
		queryKey: accountQueryKey(scope, "hosted-overview-skills", deployment?.resource.id),
		enabled: scope.isReady && Boolean(deployment && api.workspaceSkills),
		retry: false,
		queryFn: ({ signal }) =>
			read((lease) => {
				if (!api.workspaceSkills || !deployment) throw new Error("Skills unavailable");
				return api.workspaceSkills.list(deployment.resource.id, lease);
			}, signal),
	});
	const managedSkills = useQuery({
		queryKey: accountQueryKey(scope, "managed-agent-skills", agent.id),
		enabled: scope.isReady && Boolean(deployment && workspace),
		retry: false,
		queryFn: ({ signal }) =>
			read((lease) => api.agentExtensions.listSkills(agent.id, lease), signal),
	});
	const pluginState = agentPluginOverviewState({
		plugins: plugins.data?.plugins,
		isLoading: plugins.isPending,
		error: plugins.data ? null : plugins.error,
	});
	const primary = deployment?.resource.spec.runtime_configuration.primary_model;
	const providerId =
		primaryModelProviderId(primary) ??
		deployment?.resource.spec.runtime_configuration.providers[0]?.provider_id ??
		MANAGED_PROVIDER_ID;
	const modelLabel = modelBindingDisplayName(
		primary,
		deployment?.resource.spec.runtime_configuration.providers[0]?.auth_kind,
		modelOptionsForProvider(
			providerId,
			hostedCatalog.data?.providers ?? [],
			hostedCatalog.data?.models ?? [],
		),
	);
	const surfaces = useStoreSurfaces();
	const compute = deployment
		? overviewComputePresentation(deployment, {
				canCreateCloudAgents: hostedCatalog.data?.capabilities.can_use_v2 ?? false,
				plansLoading: hostedCatalog.isPending,
				performancePlanAvailable:
					hostedCatalog.data?.plans.some((p) => p.slug === "compute_performance") ?? false,
			})
		: null;
	const computeStatus = deployment
		? (deploymentFailurePresentation(deployment)?.status ??
			deploymentRuntimeStatusPresentation(deployment.resource.status))
		: null;
	const ComputeActionIcon =
		compute?.action?.kind === "upgrade"
			? ArrowUp
			: compute?.action?.kind === "top_up"
				? WalletCards
				: compute?.action?.kind === "fix_payment"
					? CreditCard
					: Settings;
	const computeCard: ReactNode =
		deployment && compute && computeStatus ? (
			<OverviewNavigationCard
				title="Compute"
				description={
					<WebView recipe={hostedStyles.computeStatus} className="flex-row">
						<StatusDot status={computeStatus.tone} />
						<Text>{computeStatus.label}</Text>
					</WebView>
				}
				icon={Cpu}
				tint={hostedStyles.computeTint}
				onPress={onManage}
			>
				<OverviewComputeBody
					{...compute}
					resources={deployment.resource.spec.resources}
					action={
						// Store builds hide card payment recovery; Wallet top-up opens Wallet's Add credits.
						compute.action && (surfaces.cardBilling || compute.action.kind !== "fix_payment") ? (
							<Button
								variant="outline"
								size="sm"
								onPress={
									compute.action.kind === "top_up"
										? () => router.push("/settings/wallet")
										: () => router.push("/settings/compute")
								}
							>
								<Icon as={ComputeActionIcon} />
								<Text>{compute.action.label}</Text>
							</Button>
						) : undefined
					}
				/>
			</OverviewNavigationCard>
		) : null;
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
		<WebView recipe={styles.root}>
			{deployment ? <ComputeDunningBanner deployment={deployment} /> : null}
			{deployment ? (
				<WebView recipe={layout.tools}>
					<RuntimeBrowser deployment={deployment} overview />
					<OverviewNavigationCard
						prominent
						title={copy.chatViaChannels}
						description={copy.channelsDescription}
						icon={MessagesSquare}
						tint={hostedStyles.channelsTint}
						onPress={() =>
							router.push({
								pathname: "/agents/[id]/[section]",
								params: { id: agent.id, section: "channel-links" },
							})
						}
					/>
					<OverviewNavigationCard
						title="AI Providers"
						description={
							hostedCatalog.isPending ? (
								<Skeleton className="h-4 w-32" />
							) : hostedCatalog.isError ? (
								copy.unavailable
							) : (
								modelLabel
							)
						}
						icon={BrainCircuit}
						tint={hostedStyles.aiTint}
						onPress={() =>
							router.push({
								pathname: "/agents/[id]/[section]",
								params: { id: agent.id, section: "model-provider" },
							})
						}
					/>
				</WebView>
			) : null}
			<WebView recipe={deployment ? layout.entry : detail.section}>
				<WebView recipe={deployment ? layout.activity : detail.section}>
					{supportsSessions ? (
						<>
							<AgentOverviewHeading
								action={
									<Button
										variant="ghost"
										size="sm"
										onPress={() =>
											router.push({
												pathname: "/agents/[id]/[section]",
												params: { id: agent.id, section: "sessions" },
											})
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
									emptyMessage={deployment ? copy.hostedSessionsEmpty : copy.noRecentSessions}
								/>
							)}
						</>
					) : null}
				</WebView>
				{deployment ? (
					computeCard
				) : (
					<OverviewNavigationCard
						title={copy.status}
						description={
							<WebView recipe={styles.statusContent} className="flex-row">
								<StatusDot status={daemonStatusPresentation(agent).tone} />
								<Text>{status.label}</Text>
							</WebView>
						}
						icon={Laptop}
						tint={detail.statusTint}
						onPress={() =>
							router.push({
								pathname: "/agents/[id]/[section]",
								params: { section: "settings", id: agent.id },
							})
						}
					>
						<OverviewMetadata
							items={[
								{ label: copy.machine, value: agent.machine_name },
								{ label: copy.lastSeen, value: relativeTime(agent.last_seen_at) },
							]}
						/>
					</OverviewNavigationCard>
				)}
			</WebView>
			<WebView recipe={styles.section}>
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
						router.push({
							pathname: "/agents/[id]/[section]",
							params: { section: "project-access", id: agent.id },
						})
					}
				/>
				{deployment || !agent.adapter_modules || agent.adapter_modules.includes("skills") ? (
					<OverviewNavigationCard
						title="Skills"
						description={summary(
							"skills",
							new Set([
								...(skills.data ?? [])
									.filter((skill) => !deployment || skill.authority === "agent_sync")
									.map((skill) => skill.skill_key),
								...(runtimeSkills.data?.items ?? []).map((skill) => skill.skill_key),
								...(managedSkills.data?.skills ?? []).map((skill) => skill.skill_key),
							]).size,
							bindings.isPending ||
								skills.isLoading ||
								(Boolean(deployment) && (runtimeSkills.isPending || managedSkills.isPending)),
							bindings.isError ||
								!workspace ||
								(skills.data ? null : skills.error) ||
								(deployment && (runtimeSkills.isError || managedSkills.isError)),
						)}
						icon={Sparkles}
						tint={RESOURCE_TINT_CLASSES.skills}
						onPress={() =>
							router.push({ pathname: "/agents/[id]/skills", params: { id: agent.id } })
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
						router.push({
							pathname: "/agents/[id]/[section]",
							params: { id: agent.id, section: "vaults" },
						})
					}
				/>
				{deployment ? (
					<OverviewNavigationCard
						title="Plugins"
						description={
							pluginState.kind === "loading" ? (
								<Skeleton className="h-4 w-32" />
							) : pluginState.kind === "error" ? (
								copy.unavailable
							) : (
								pluginState.description
							)
						}
						icon={Blocks}
						tint={hostedStyles.pluginsTint}
						onPress={() =>
							router.push({
								pathname: "/agents/[id]/[section]",
								params: { section: "plugins", id: agent.id },
							})
						}
					/>
				) : null}
			</WebView>
			<WebView recipe={styles.section}>
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
