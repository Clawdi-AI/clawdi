"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ExternalLink, Laptop } from "lucide-react";
import { AccountWideScopeBadge } from "@/components/account-wide-scope";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetAgentBreadcrumbTitle } from "@/components/breadcrumb-title";
import { ConnectorsSurface } from "@/components/connectors/connectors-surface";
import {
	AgentSourceBadgeForEnvironment,
	agentDisplayName,
} from "@/components/dashboard/agent-label";
import {
	AgentOverviewCapabilities,
	AgentOverviewCapabilitiesSkeleton,
	AgentOverviewStatusCard,
	OverviewMetadata,
	OverviewModuleError,
} from "@/components/dashboard/agent-overview-capabilities";
import {
	overviewProjectsModule,
	overviewSkillsModule,
	useOverviewConnectorsModule,
	useOverviewMemoriesModule,
	useOverviewVaultsModule,
} from "@/components/dashboard/agent-overview-resource-bodies";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { effectiveAgentProjectIds } from "@/components/dashboard/agent-project-scope";
import { AgentProjectsTab } from "@/components/dashboard/agent-projects-tab";
import { AgentSettingsPanel } from "@/components/dashboard/agent-settings-panel";
import { AgentSkillsTab, useAgentProjectSkills } from "@/components/dashboard/agent-skills-tab";
import { AgentVaultsTab } from "@/components/dashboard/agent-vaults-tab";
import { daemonStatusVisual } from "@/components/dashboard/daemon-status";
import { DetailNotFound } from "@/components/detail/layout";
import { MemoriesSurface } from "@/components/memories/memories-surface";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import {
	OverviewSessionList,
	OverviewSessionListSkeleton,
	SessionFeed,
} from "@/components/sessions/session-feed";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-badge";
import { agentOwnershipKindFromId, useAgentOwnership } from "@/lib/agent-ownership";
import {
	type AgentRouteSearch,
	type AgentSectionId,
	agentSectionLabel,
	agentSectionLink,
	agentSessionDetailLink,
	CONNECTED_AGENT_SECTION_IDS,
} from "@/lib/agent-routes";
import { useOpenApi } from "@/lib/api";
import { isApiNotFoundError } from "@/lib/api-errors";
import { legacyHostedDashboardUrl } from "@/lib/legacy-hosted-dashboard";
import { AGENT_SECTION_NAVIGATION_ITEMS, isAccountWideAgentSection } from "@/lib/navigation-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import { agentResourceScope } from "@/lib/resource-navigation";
import { sessionListQueryOptions } from "@/lib/session-queries";
import { cn, errorMessage, relativeTime } from "@/lib/utils";

type AgentTab =
	| "overview"
	| "sessions"
	| "memories"
	| "connectors"
	| "projects"
	| "skills"
	| "vaults"
	| "settings";

export function ConnectedAgentDetail({
	environmentId,
	section = "overview",
	routeSearch,
	showSourceBadge = true,
}: {
	environmentId: string;
	section?: AgentSectionId;
	routeSearch: AgentRouteSearch;
	showSourceBadge?: boolean;
}) {
	const id = environmentId;
	const $api = useOpenApi();
	const ownership = useAgentOwnership();
	const activeTab = parseAgentTab(section) ?? "overview";

	const {
		data: agent,
		isLoading,
		error,
		refetch: refetchAgent,
	} = $api.useQuery("get", "/v1/agents/{agent_id}", {
		params: { path: { agent_id: id } },
	});

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
		enabled: overviewEnabled,
	});

	const {
		data: sessionsPage,
		isLoading: sessionsLoading,
		error: sessionsError,
		refetch: refetchSessions,
	} = useQuery({
		...sessionListQueryOptions($api, { environment_id: id, page_size: 50 }),
		enabled: activeTab === "sessions" && Boolean(agent),
	});

	const agentProjectId = agent?.default_project_id;
	const {
		skills: skillsForThisEnv,
		isLoading: skillsLoading,
		error: skillsError,
	} = useAgentProjectSkills(id, agentProjectId, id, false, overviewEnabled);

	const blockingAgentError =
		isApiNotFoundError(error) || shouldBlockQueryError(error, agent) ? error : null;
	const blockingSkillsError = shouldBlockQueryError(skillsError, skillsForThisEnv)
		? skillsError
		: null;
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
	useSetAgentBreadcrumbTitle({ agentId: id, agentTitle, section: activeTab });
	const titleAdornment =
		activeTab === "overview" && agent && showSourceBadge ? (
			<AgentSourceBadgeForEnvironment env={agent} ownershipKind={ownershipKind} compact />
		) : isAccountWideAgentSection(activeTab) ? (
			<AccountWideScopeBadge />
		) : null;
	const legacyDashboardUrl = ownershipKind === "legacy" ? legacyHostedDashboardUrl() : null;
	const scopedSessionLink = (sessionId: string) => ({
		...agentSessionDetailLink(id, sessionId, routeSearch),
	});
	const resourceScope = agentResourceScope(id, routeSearch);
	const memoriesModule = useOverviewMemoriesModule({ enabled: overviewEnabled });
	const connectorsModule = useOverviewConnectorsModule({ enabled: overviewEnabled });
	const vaultsModule = useOverviewVaultsModule({
		projectIds: effectiveAgentProjectIds(projectBindings ?? []),
		resolution: projectBindingsLoading
			? "loading"
			: blockingProjectBindingsError
				? "unavailable"
				: "ready",
		enabled: overviewEnabled,
	});
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
				<AgentDetailContentSkeleton variant="connected" />
			) : agent ? (
				<section className="flex flex-col gap-4">
					<PageHeader
						title={activeTabLabel}
						titleAdornment={titleAdornment}
						description={activeTab === "overview" ? undefined : activeTabMeta.description}
						icon={ActiveTabIcon ? <ActiveTabIcon className="size-4 text-muted-foreground" /> : null}
						actions={
							activeTab === "overview" && legacyDashboardUrl ? (
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

					{activeTab === "overview" ? (
						<div className="flex flex-col gap-8">
							<div className="grid items-stretch gap-4 @3xl/main:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)] @3xl/main:gap-y-3">
								<div className="grid min-w-0 gap-3 @3xl/main:row-span-2 @3xl/main:row-start-1 @3xl/main:grid-rows-subgrid">
									<div className="flex items-center justify-between">
										<h2 id="connected-recent-sessions" className="text-sm font-semibold">
											Recent sessions
										</h2>
										<Button
											render={<Link {...agentSectionLink(id, "sessions", routeSearch)} />}
											nativeButton={false}
											variant="ghost"
											size="sm"
											className="text-muted-foreground"
										>
											View all
											<ArrowRight />
										</Button>
									</div>
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
								</div>
								<div className="@3xl/main:row-start-2">
									<AgentOverviewStatusCard
										agentId={id}
										section="settings"
										routeSearch={routeSearch}
										title="Live Sync"
										icon={Laptop}
										tint="bg-identity-7-bg text-identity-7-fg"
										description={
											<span className="inline-flex items-center gap-2">
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
								</div>
							</div>
							<AgentOverviewCapabilities
								agentId={id}
								variant="connected"
								routeSearch={routeSearch}
								content={{
									projects: overviewProjectsModule({
										bindings: {
											count: projectBindings?.length ?? null,
											isLoading: projectBindingsLoading,
											error: blockingProjectBindingsError,
										},
									}),
									skills: overviewSkillsModule({
										items: (skillsForThisEnv ?? []).map((skill) => skill.name),
										isLoading: skillsLoading,
										error: blockingSkillsError,
									}),
									memories: memoriesModule,
									vaults: vaultsModule,
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

					{activeTab === "skills" ? (
						<AgentSkillsTab
							agentId={id}
							agentProjectId={agentProjectId}
							routeSearch={routeSearch}
							isResolvingAgentProject={isLoading}
						/>
					) : null}

					{activeTab === "connectors" ? <ConnectorsSurface embedded scope={resourceScope} /> : null}

					{activeTab === "projects" ? (
						<AgentProjectsTab agentId={id} routeSearch={routeSearch} />
					) : null}

					{activeTab === "vaults" ? (
						<AgentVaultsTab agentId={id} routeSearch={routeSearch} />
					) : null}

					{activeTab === "settings" ? <AgentSettingsPanel environmentId={id} /> : null}
				</section>
			) : null}
		</div>
	);
}

export function ConnectedAgentDetailSkeleton({ hosted = false }: { hosted?: boolean }) {
	return (
		<div
			data-hosted={hosted ? "true" : undefined}
			className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6")}
		>
			<AgentDetailContentSkeleton variant={hosted ? "hosted" : "connected"} />
		</div>
	);
}

function AgentDetailContentSkeleton({ variant }: { variant: "connected" | "hosted" }) {
	return (
		<section className="flex flex-col gap-8" data-agent-detail-skeleton>
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="flex items-center gap-3">
					<Skeleton className="size-4 rounded-sm" />
					<Skeleton className="h-7 w-28" />
					{variant === "hosted" ? <Skeleton className="h-5 w-14 rounded-full" /> : null}
				</div>
				{variant === "hosted" ? <Skeleton className="h-9 w-48 rounded-md" /> : null}
			</div>
			<div className="grid items-stretch gap-4 @3xl/main:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)] @3xl/main:gap-y-3">
				<div className="grid min-w-0 gap-3 @3xl/main:row-span-2 @3xl/main:row-start-1 @3xl/main:grid-rows-subgrid">
					<div className="flex items-center justify-between">
						<Skeleton className="h-5 w-28" />
						<Skeleton className="h-8 w-20" />
					</div>
					<OverviewSessionListSkeleton />
				</div>
				<div className="@3xl/main:row-start-2">
					<Card
						size="sm"
						className="h-full gap-0 bg-muted/20 py-0"
						aria-hidden="true"
						data-testid="overview-status-card-skeleton"
					>
						<CardHeader className="p-0">
							<div className="flex items-center gap-3 px-4 py-3">
								<Skeleton className="size-8 shrink-0 rounded-lg" />
								<div className="min-w-0 flex-1">
									<Skeleton className="h-5 w-20" />
									<Skeleton className="h-5 w-16" />
								</div>
								<Skeleton className="size-4 shrink-0" />
							</div>
						</CardHeader>
						<CardContent className="flex flex-1 flex-col justify-end gap-2 px-4 pb-4">
							<Skeleton className="h-4 w-full" />
							<Skeleton className="h-4 w-3/4" />
						</CardContent>
					</Card>
				</div>
			</div>
			<AgentOverviewCapabilitiesSkeleton variant={variant} />
		</section>
	);
}

function parseAgentTab(value: AgentSectionId | string | null): AgentTab | null {
	if (value === "overview") return "overview";
	if (CONNECTED_AGENT_SECTION_IDS.includes(value as AgentTab)) return value as AgentTab;
	return null;
}
