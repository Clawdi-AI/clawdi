"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Cpu, ExternalLink, Laptop } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { ConnectorsSurface } from "@/components/connectors/connectors-surface";
import {
	AgentSourceBadgeForEnvironment,
	agentDisplayName,
} from "@/components/dashboard/agent-label";
import {
	AgentOverviewCapabilities,
	AgentOverviewCapabilitiesSkeleton,
	AgentOverviewStatusCard,
	OVERVIEW_CHANNELS_DESCRIPTION,
	OverviewMetadata,
	OverviewModuleError,
	OverviewNavigationCard,
} from "@/components/dashboard/agent-overview-capabilities";
import {
	AgentOverviewActivity,
	AgentOverviewTools,
} from "@/components/dashboard/agent-overview-layout";
import {
	overviewProjectsModule,
	useOverviewConnectorsModule,
	useOverviewMemoriesModule,
	useOverviewVaultsModule,
	useOverviewWorkspaceSkillsModule,
} from "@/components/dashboard/agent-overview-resource-bodies";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import {
	linkedAgentProjectCount,
	resolveAgentWorkspaceProjectId,
} from "@/components/dashboard/agent-project-scope";
import { AgentProjectsTab } from "@/components/dashboard/agent-projects-tab";
import { AgentSettingsPanel } from "@/components/dashboard/agent-settings-panel";
import { daemonStatusVisual } from "@/components/dashboard/daemon-status";
import { OverviewComputeBody } from "@/components/dashboard/overview-compute-body";
import { DetailNotFound } from "@/components/detail/layout";
import { MemoriesPageActions, MemoriesSurface } from "@/components/memories/memories-surface";
import { PageHeader, PageHeaderSkeleton } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import {
	OverviewSessionList,
	OverviewSessionListSkeleton,
	SessionFeed,
} from "@/components/sessions/session-feed";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-badge";
import { connectedAdapterHasModule } from "@/lib/adapter-modules";
import { agentOwnershipKindFromId, useAgentOwnership } from "@/lib/agent-ownership";
import { agentDetailQueryOptions } from "@/lib/agent-queries";
import {
	type AgentSectionId,
	agentProjectResourceLink,
	agentSectionLabel,
	agentSectionLink,
	agentSessionDetailLink,
	CONNECTED_AGENT_SECTION_IDS,
} from "@/lib/agent-routes";
import { useOpenApi } from "@/lib/api";
import { isApiNotFoundError } from "@/lib/api-errors";
import { AGENT_SECTION_NAVIGATION_ITEMS } from "@/lib/navigation-model";
import { useProductAccess } from "@/lib/product-access";
import { shouldBlockQueryError } from "@/lib/query-state";
import { agentResourceScope } from "@/lib/resource-navigation";
import { sessionListQueryOptions } from "@/lib/session-queries";
import { cn, errorMessage, relativeTime } from "@/lib/utils";

type AgentTab = "overview" | "sessions" | "memories" | "connectors" | "projects" | "settings";

export function ConnectedAgentDetail({
	environmentId,
	section = "overview",
	showSourceBadge = true,
}: {
	environmentId: string;
	section?: AgentSectionId;
	showSourceBadge?: boolean;
}) {
	const id = environmentId;
	const $api = useOpenApi();
	const queryClient = useQueryClient();
	const ownership = useAgentOwnership();
	const { legacyDashboardUrl: projectedLegacyDashboardUrl } = useProductAccess();
	const activeTab = parseAgentTab(section) ?? "overview";

	const {
		data: agent,
		isLoading,
		error,
		refetch: refetchAgent,
	} = useQuery(agentDetailQueryOptions($api, queryClient, id));

	const supportsSessions = connectedAdapterHasModule(agent?.adapter_modules, "sessions");
	const supportsSkills = connectedAdapterHasModule(agent?.adapter_modules, "skills");
	const overviewEnabled = activeTab === "overview" && Boolean(agent);
	const overviewProjects = useAgentProjectBindings(id, { enabled: overviewEnabled });
	const projectBindings = overviewProjects.data;
	const projectBindingsLoading = overviewProjects.isLoading;
	const projectBindingsError = overviewProjects.error;
	const {
		data: overviewSessionsPage,
		isLoading: overviewSessionsLoading,
		error: overviewSessionsError,
		refetch: refetchOverviewSessions,
	} = useQuery({
		...sessionListQueryOptions($api, { environment_id: id, page_size: 3 }),
		enabled: overviewEnabled && supportsSessions,
	});

	const {
		data: sessionsPage,
		isLoading: sessionsLoading,
		error: sessionsError,
		refetch: refetchSessions,
	} = useQuery({
		...sessionListQueryOptions($api, { environment_id: id, page_size: 50 }),
		enabled: activeTab === "sessions" && Boolean(agent) && supportsSessions,
	});

	const blockingAgentError =
		isApiNotFoundError(error) || shouldBlockQueryError(error, agent) ? error : null;
	const blockingProjectBindingsError = shouldBlockQueryError(projectBindingsError, projectBindings)
		? projectBindingsError
		: null;
	const blockingOverviewSessionsError = shouldBlockQueryError(
		overviewSessionsError,
		overviewSessionsPage,
	)
		? overviewSessionsError
		: null;
	const blockingSessionsError = shouldBlockQueryError(sessionsError, sessionsPage)
		? sessionsError
		: null;
	const syncStatus = daemonStatusVisual(agent);
	const syncTone =
		syncStatus.kind === "live"
			? "success"
			: syncStatus.kind === "errored"
				? "destructive"
				: syncStatus.kind === "paused"
					? "warning"
					: "neutral";
	const activeTabMeta = AGENT_SECTION_NAVIGATION_ITEMS[activeTab];
	const activeTabLabel = agentSectionLabel(activeTab);
	const ActiveTabIcon = activeTabMeta.icon;
	const ownershipKind = agent ? agentOwnershipKindFromId(agent.id, ownership) : "connected";
	const agentTitle = agent ? agentDisplayName(agent) : null;
	useSetBreadcrumbTitle(activeTab === "overview" ? agentTitle : agentSectionLabel(activeTab));
	const headerStatus =
		activeTab === "overview" && agent && showSourceBadge ? (
			<AgentSourceBadgeForEnvironment env={agent} ownershipKind={ownershipKind} compact />
		) : null;
	const legacyDashboardUrl = ownershipKind === "legacy" ? projectedLegacyDashboardUrl : null;
	const scopedSessionLink = (sessionId: string) => ({
		...agentSessionDetailLink(id, sessionId),
	});
	const resourceScope = agentResourceScope(id);
	const workspaceProjectId = agent
		? resolveAgentWorkspaceProjectId(projectBindings ?? [], agent.default_project_id)
		: null;
	const workspaceResolution = projectBindingsLoading
		? "loading"
		: blockingProjectBindingsError || !workspaceProjectId
			? "unavailable"
			: "ready";
	const skillsModule = useOverviewWorkspaceSkillsModule({
		projectId: workspaceProjectId,
		resolution: workspaceResolution,
		enabled: overviewEnabled && supportsSkills,
	});
	const vaultsModule = useOverviewVaultsModule({
		projectIds: workspaceProjectId ? [workspaceProjectId] : [],
		resolution: workspaceResolution,
		enabled: overviewEnabled,
	});
	const memoriesModule = useOverviewMemoriesModule({ enabled: overviewEnabled });
	const connectorsModule = useOverviewConnectorsModule({ enabled: overviewEnabled });
	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6")}>
			{blockingAgentError ? (
				isApiNotFoundError(blockingAgentError) ? (
					<DetailNotFound title="Agent not found" message={errorMessage(blockingAgentError)} />
				) : (
					<ApiErrorPanel
						error={blockingAgentError}
						onRetry={() => {
							void refetchAgent();
						}}
						title="Couldn't load agent"
					/>
				)
			) : isLoading ? (
				<AgentDetailContentSkeleton variant="connected" section={activeTab} />
			) : agent && activeTab === "sessions" && !supportsSessions ? (
				<DetailNotFound
					title="Sessions unavailable"
					message="This Connected Agent does not provide session sync."
				/>
			) : agent ? (
				<section className="flex flex-col gap-6">
					{activeTab === "projects" ? null : (
						<PageHeader
							title={activeTab === "overview" ? (agentTitle ?? activeTabLabel) : activeTabLabel}
							titleAdornment={headerStatus}
							description={activeTabMeta.description}
							icon={
								ActiveTabIcon ? <ActiveTabIcon className="size-4 text-muted-foreground" /> : null
							}
							actions={
								activeTab === "memories" ? (
									<MemoriesPageActions scope={resourceScope} />
								) : activeTab === "overview" && legacyDashboardUrl ? (
									<Button
										variant="outline"
										render={
											<a
												href={legacyDashboardUrl}
												target="_blank"
												rel="noopener noreferrer"
												aria-label="Open legacy dashboard"
											/>
										}
										nativeButton={false}
									>
										<ExternalLink />
										Legacy dashboard
									</Button>
								) : null
							}
						/>
					)}

					{activeTab === "overview" ? (
						<div className="flex flex-col gap-8">
							<AgentOverviewActivity
								heading={
									<h2 id="connected-recent-sessions" className="text-sm font-semibold">
										Recent sessions
									</h2>
								}
								action={
									<Button
										render={<Link {...agentSectionLink(id, "sessions")} />}
										nativeButton={false}
										variant="ghost"
										size="sm"
										className="text-muted-foreground"
									>
										View all
										<ArrowRight />
									</Button>
								}
								sessions={
									supportsSessions ? (
										<section aria-labelledby="connected-recent-sessions" className="min-w-0">
											{blockingOverviewSessionsError ? (
												<OverviewModuleError
													label="Sessions"
													onRetry={() => void refetchOverviewSessions()}
												/>
											) : (
												<OverviewSessionList
													sessions={overviewSessionsPage?.items ?? []}
													isLoading={overviewSessionsLoading}
													emptyMessage="No recent sessions"
													sessionLink={(session) => scopedSessionLink(session.id)}
												/>
											)}
										</section>
									) : null
								}
							>
								<AgentOverviewStatusCard
									agentId={id}
									section="settings"
									title="Status"
									icon={Laptop}
									tint="bg-identity-7-bg text-identity-7-fg"
									description={
										<span className="flex items-center gap-2">
											<StatusDot status={syncTone} /> {syncStatus.label}
										</span>
									}
								>
									<div className="flex h-full flex-col justify-end">
										<OverviewMetadata
											items={[
												{ label: "Machine", value: agent.machine_name },
												{ label: "Last seen", value: relativeTime(agent.last_seen_at) },
											]}
										/>
									</div>
								</AgentOverviewStatusCard>
							</AgentOverviewActivity>
							<AgentOverviewCapabilities
								agentId={id}
								variant="connected"
								content={{
									projects: overviewProjectsModule({
										bindings: {
											count: projectBindings ? linkedAgentProjectCount(projectBindings) : null,
											isLoading: projectBindingsLoading,
											error: blockingProjectBindingsError,
										},
									}),
									...(supportsSkills
										? {
												skills: {
													...skillsModule,
													link: workspaceProjectId
														? agentProjectResourceLink(id, workspaceProjectId, "skills")
														: null,
												},
											}
										: {}),
									memories: memoriesModule,
									vaults: {
										...vaultsModule,
										link: workspaceProjectId
											? agentProjectResourceLink(id, workspaceProjectId, "vaults")
											: null,
									},
									connectors: connectorsModule,
								}}
							/>
						</div>
					) : null}

					{activeTab === "sessions" ? (
						blockingSessionsError ? (
							<ApiErrorPanel
								error={blockingSessionsError}
								onRetry={() => {
									void refetchSessions();
								}}
								title="Couldn't load agent sessions"
							/>
						) : (
							<SessionFeed
								sessions={sessionsPage?.items ?? []}
								isLoading={sessionsLoading}
								emptyMessage="No sessions synced from this agent yet."
								showAgent={false}
								sessionLink={(session) => scopedSessionLink(session.id)}
							/>
						)
					) : null}

					{activeTab === "memories" ? <MemoriesSurface scope={resourceScope} /> : null}

					{activeTab === "connectors" ? <ConnectorsSurface embedded scope={resourceScope} /> : null}

					{activeTab === "projects" ? (
						<AgentProjectsTab
							agentId={id}
							headerAdornment={headerStatus}
							headerIcon={
								ActiveTabIcon ? <ActiveTabIcon className="size-4 text-muted-foreground" /> : null
							}
						/>
					) : null}

					{activeTab === "settings" ? <AgentSettingsPanel environmentId={id} /> : null}
				</section>
			) : null}
		</div>
	);
}

export function ConnectedAgentDetailSkeleton({
	hosted = false,
	section = "overview",
}: {
	hosted?: boolean;
	section?: AgentSectionId;
}) {
	if (section === "console" || section === "files" || section === "terminal") {
		return (
			<div
				data-hosted={hosted ? "true" : undefined}
				data-testid="agent-live-tool-loading-shell"
				role="status"
				aria-label={`${agentSectionLabel(section)} loading`}
				className="flex min-h-0 w-full flex-1 flex-col overflow-hidden"
			>
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
					<div className="flex h-12 shrink-0 items-center justify-between gap-3 px-4 lg:px-6">
						<div className="flex min-w-0 items-center gap-2">
							<Skeleton className="size-4 shrink-0 rounded-sm" />
							<Skeleton className="h-4 w-32 max-w-[45vw]" />
						</div>
						<Skeleton className="h-8 w-20 shrink-0" />
					</div>
					<Skeleton className="min-h-0 flex-1 rounded-none" />
				</div>
			</div>
		);
	}

	return (
		<div
			data-hosted={hosted ? "true" : undefined}
			className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6")}
		>
			<AgentDetailContentSkeleton variant={hosted ? "hosted" : "connected"} section={section} />
		</div>
	);
}

function AgentDetailContentSkeleton({
	variant,
	section = "overview",
}: {
	variant: "connected" | "hosted";
	section?: AgentSectionId;
}) {
	if (section !== "overview") {
		return (
			<section
				className="flex flex-col gap-6"
				data-agent-detail-skeleton
				data-agent-detail-section={section}
			>
				<PageHeaderSkeleton
					icon
					iconClassName="size-4 rounded-sm"
					actions={section === "memories"}
					description={AGENT_SECTION_NAVIGATION_ITEMS[section].description ?? false}
				/>
				<div className="space-y-4">
					<Skeleton className="h-4 w-28" />
					<Skeleton className="h-4 w-56 max-w-full" />
					<Skeleton className="h-40 w-full" />
				</div>
			</section>
		);
	}

	return (
		<section
			className="flex flex-col gap-6"
			data-agent-detail-skeleton
			data-agent-detail-section="overview"
		>
			<PageHeaderSkeleton
				icon
				iconClassName="size-4 rounded-sm"
				description={AGENT_SECTION_NAVIGATION_ITEMS.overview.description ?? false}
			/>
			<div className="flex flex-col gap-8">
				{variant === "hosted" ? (
					<AgentOverviewTools>
						{(
							[
								["dashboard", "console"],
								["channels", "channels"],
								["model-provider", "ai"],
							] as const
						).map(([id, section]) => {
							const item = AGENT_SECTION_NAVIGATION_ITEMS[section];
							return (
								<OverviewNavigationCard
									key={id}
									id={id}
									title={item.label}
									description={section === "channels" ? OVERVIEW_CHANNELS_DESCRIPTION : null}
									icon={item.icon}
									tint={item.tint}
									link={null}
									loading
								/>
							);
						})}
					</AgentOverviewTools>
				) : null}
				<AgentOverviewActivity
					heading={
						<h2 className="text-sm font-semibold">
							<Skeleton className="h-lh w-28" />
						</h2>
					}
					action={<Skeleton className="h-8 w-20" />}
					sessions={<OverviewSessionListSkeleton />}
				>
					<AgentOverviewStatusCard
						agentId=""
						section="settings"
						title={variant === "hosted" ? "Compute" : "Status"}
						icon={variant === "hosted" ? Cpu : Laptop}
						tint=""
						description={null}
						loading
					>
						{variant === "hosted" ? (
							<OverviewComputeBody loading />
						) : (
							<div className="flex h-full flex-col justify-end">
								<OverviewMetadata
									items={[
										{ label: "Machine", value: <Skeleton className="h-lh w-24" /> },
										{ label: "Last seen", value: <Skeleton className="h-lh w-20" /> },
									]}
								/>
							</div>
						)}
					</AgentOverviewStatusCard>
				</AgentOverviewActivity>
				<AgentOverviewCapabilitiesSkeleton variant={variant} />
			</div>
		</section>
	);
}

function parseAgentTab(value: AgentSectionId | string | null): AgentTab | null {
	if (value === "overview") return "overview";
	if (CONNECTED_AGENT_SECTION_IDS.includes(value as AgentTab)) return value as AgentTab;
	return null;
}
