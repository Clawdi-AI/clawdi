"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Laptop } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetAgentBreadcrumbTitle } from "@/components/breadcrumb-title";
import { ConnectorsSurface } from "@/components/connectors/connectors-surface";
import {
	AgentSourceBadgeForEnvironment,
	agentDisplayName,
} from "@/components/dashboard/agent-label";
import {
	AgentOverviewCapabilities,
	AgentOverviewStatusCard,
	OverviewMetadata,
	OverviewModuleError,
} from "@/components/dashboard/agent-overview-capabilities";
import {
	OverviewConnectorsBody,
	OverviewMemoriesBody,
	OverviewProjectsBody,
	OverviewSkillsBody,
	OverviewVaultsBody,
} from "@/components/dashboard/agent-overview-resource-bodies";
import { useAgentOverviewProjects } from "@/components/dashboard/agent-project-bindings-query";
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
import { OverviewSessionList, SessionFeed } from "@/components/sessions/session-feed";
import { Button } from "@/components/ui/button";
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
import { AGENT_SECTION_NAVIGATION_ITEMS } from "@/lib/navigation-model";
import { shouldBlockQueryError } from "@/lib/query-state";
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
	const overviewProjects = useAgentOverviewProjects(id, { enabled: overviewEnabled });
	const projectBindings = overviewProjects.bindings.data;
	const projectBindingsLoading = overviewProjects.bindings.isLoading;
	const projectBindingsError = overviewProjects.bindings.error;
	const refetchProjectBindings = overviewProjects.bindings.refetch;
	const projectNames = overviewProjects.nameResolution;

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
		refetch: refetchSkills,
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
	const headerStatus =
		agent && showSourceBadge ? (
			<AgentSourceBadgeForEnvironment env={agent} ownershipKind={ownershipKind} compact />
		) : null;
	const scopedSessionLink = (sessionId: string) => ({
		...agentSessionDetailLink(id, sessionId, routeSearch),
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
				<AgentDetailContentSkeleton />
			) : agent ? (
				<section className="flex flex-col gap-4">
					<PageHeader
						title={activeTabLabel}
						description={activeTab === "overview" ? undefined : activeTabMeta.description}
						icon={ActiveTabIcon ? <ActiveTabIcon className="size-4 text-muted-foreground" /> : null}
						status={headerStatus}
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
									>
										<div className="flex h-full flex-col justify-between gap-4">
											<p
												data-overview-primary-value
												className="inline-flex items-center gap-2 text-base font-semibold"
											>
												<StatusDot status={syncTone} /> {syncStatus.label}
											</p>
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
									projects: {
										body: (
											<OverviewProjectsBody
												bindings={{
													count: projectBindings?.length ?? null,
													isLoading: projectBindingsLoading,
													error: blockingProjectBindingsError,
													onRetry: () => void refetchProjectBindings(),
												}}
												names={{
													items: projectNames.names,
													unresolvedCount: projectNames.unresolvedCount,
													isLoading: projectNames.isLoading,
													error: projectNames.error,
													onRetry: () => void projectNames.refetch(),
												}}
											/>
										),
									},
									skills: {
										body: (
											<OverviewSkillsBody
												items={(skillsForThisEnv ?? []).map((skill) => skill.name)}
												isLoading={skillsLoading}
												error={blockingSkillsError}
												onRetry={() => void refetchSkills()}
											/>
										),
									},
									memories: { body: <OverviewMemoriesBody /> },
									vaults: {
										body: (
											<OverviewVaultsBody
												projectIds={effectiveAgentProjectIds(projectBindings ?? [])}
												resolution={
													projectBindingsLoading
														? "loading"
														: blockingProjectBindingsError
															? "unavailable"
															: "ready"
												}
											/>
										),
									},
									connectors: { body: <OverviewConnectorsBody /> },
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

					{activeTab === "memories" ? <MemoriesSurface /> : null}

					{activeTab === "skills" ? (
						<AgentSkillsTab
							agentId={id}
							agentProjectId={agentProjectId}
							routeSearch={routeSearch}
							isResolvingAgentProject={isLoading}
						/>
					) : null}

					{activeTab === "connectors" ? <ConnectorsSurface embedded /> : null}

					{activeTab === "projects" ? <AgentProjectsTab agentId={id} /> : null}

					{activeTab === "vaults" ? <AgentVaultsTab agentId={id} /> : null}

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
			<AgentDetailContentSkeleton />
		</div>
	);
}

function AgentDetailContentSkeleton() {
	return (
		<section className="flex flex-col gap-8">
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<Skeleton className="size-4 rounded-sm" />
					<Skeleton className="h-5 w-28" />
				</div>
			</div>
			<div>
				<Skeleton className="mb-3 h-4 w-28" />
				<div className="grid items-stretch gap-4 @3xl/main:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
					<div className="grid min-h-52 gap-2">
						{Array.from({ length: 3 }).map((_, index) => (
							<Skeleton key={index} className="h-11 rounded-lg" />
						))}
					</div>
					<Skeleton className="min-h-52 rounded-lg" />
				</div>
			</div>
			<div>
				<Skeleton className="mb-3 h-4 w-20" />
				<div className="grid gap-3 @2xl/main:grid-cols-2 @4xl/main:grid-cols-3">
					{Array.from({ length: 5 }).map((_, index) => (
						<Skeleton key={index} className="h-40 rounded-xl" />
					))}
				</div>
			</div>
		</section>
	);
}

function parseAgentTab(value: AgentSectionId | string | null): AgentTab | null {
	if (value === "overview") return "overview";
	if (CONNECTED_AGENT_SECTION_IDS.includes(value as AgentTab)) return value as AgentTab;
	return null;
}
