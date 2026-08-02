"use client";

import { useQuery } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
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
	OverviewChips,
	OverviewMetadata,
	OverviewModuleError,
	OverviewModuleSkeleton,
	OverviewSummaryRows,
} from "@/components/dashboard/agent-overview-capabilities";
import {
	OverviewConnectorsBody,
	OverviewMemoriesBody,
	OverviewVaultsBody,
} from "@/components/dashboard/agent-overview-resource-bodies";
import { useAgentOverviewProjects } from "@/components/dashboard/agent-project-bindings-query";
import { effectiveAgentProjectIds } from "@/components/dashboard/agent-project-scope";
import { AgentProjectsTab } from "@/components/dashboard/agent-projects-tab";
import { AgentSettingsPanel } from "@/components/dashboard/agent-settings-panel";
import { AgentSkillsTab, useAgentProjectSkills } from "@/components/dashboard/agent-skills-tab";
import { AgentVaultsTab } from "@/components/dashboard/agent-vaults-tab";
import { daemonStatusVisual } from "@/components/dashboard/daemon-status";
import { DetailNotFound, DetailPanel } from "@/components/detail/layout";
import { ENTITY_CARD_BASE } from "@/components/entity-card";
import { MemoriesSurface } from "@/components/memories/memories-surface";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { OverviewSessionList, SessionFeed } from "@/components/sessions/session-feed";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-badge";
import { agentOwnershipKindFromId, useAgentOwnership } from "@/lib/agent-ownership";
import {
	type AgentRouteSearch,
	type AgentSectionId,
	agentSectionLabel,
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

	const overviewProjects = useAgentOverviewProjects(id, { enabled: !!agent });
	const projectBindings = overviewProjects.bindings.data;
	const projectBindingsLoading = overviewProjects.bindings.isLoading;
	const projectBindingsError = overviewProjects.bindings.error;
	const refetchProjectBindings = overviewProjects.bindings.refetch;
	const projectNames = overviewProjects.nameResolution;

	const {
		data: sessionsPage,
		isLoading: sessionsLoading,
		error: sessionsError,
		refetch: refetchSessions,
	} = useQuery({
		...sessionListQueryOptions($api, { environment_id: id, page_size: 50 }),
		enabled: !!agent,
	});

	const agentProjectId = agent?.default_project_id;
	const {
		skills: skillsForThisEnv,
		isLoading: skillsLoading,
		error: skillsError,
		refetch: refetchSkills,
	} = useAgentProjectSkills(id, agentProjectId, id, false, Boolean(agent));

	const blockingAgentError =
		isApiNotFoundError(error) || shouldBlockQueryError(error, agent) ? error : null;
	const blockingSkillsError = shouldBlockQueryError(skillsError, skillsForThisEnv)
		? skillsError
		: null;
	const blockingProjectBindingsError = shouldBlockQueryError(projectBindingsError, projectBindings)
		? projectBindingsError
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
						description={activeTabMeta.description}
						icon={ActiveTabIcon ? <ActiveTabIcon className="size-4 text-muted-foreground" /> : null}
						status={headerStatus}
					/>

					{activeTab === "overview" ? (
						<div className="flex flex-col gap-8">
							<div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
								<section aria-labelledby="connected-recent-sessions">
									<h2 id="connected-recent-sessions" className="mb-3 text-sm font-semibold">
										Recent sessions
									</h2>
									{blockingSessionsError ? (
										<OverviewModuleError label="Sessions" onRetry={() => void refetchSessions()} />
									) : (
										<OverviewSessionList
											sessions={sessionsPage?.items ?? []}
											isLoading={sessionsLoading}
											emptyMessage="No recent sessions"
											sessionLink={(session) => scopedSessionLink(session.id)}
										/>
									)}
								</section>
								<AgentOverviewStatusCard
									agentId={id}
									section="settings"
									routeSearch={routeSearch}
									title="Live Sync"
									icon={Laptop}
									tint="bg-identity-7-bg text-identity-7-fg"
								>
									<div className="space-y-3">
										<p className="inline-flex items-center gap-2 text-lg font-semibold">
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
							<AgentOverviewCapabilities
								agentId={id}
								variant="connected"
								routeSearch={routeSearch}
								content={{
									projects: {
										body: projectBindingsLoading ? (
											<OverviewModuleSkeleton label="projects" rows={3} />
										) : blockingProjectBindingsError ? (
											<OverviewModuleError
												label="Projects"
												onRetry={() => void refetchProjectBindings()}
											/>
										) : (
											<div className="space-y-3">
												<p className="text-lg font-semibold">
													{(projectBindings?.length ?? 0) > 0
														? `${projectBindings?.length} ${projectBindings?.length === 1 ? "project" : "projects"}`
														: "No projects added"}
												</p>
												{(projectBindings?.length ?? 0) === 0 ? null : projectNames.isLoading ? (
													<OverviewModuleSkeleton
														label="project names"
														rows={3}
														showHeading={false}
													/>
												) : projectNames.error ? (
													<OverviewModuleError
														label="Project names"
														onRetry={() => void projectNames.refetch()}
													/>
												) : (
													<>
														<OverviewSummaryRows
															items={projectNames.names}
															empty="Project names can’t be shown"
														/>
														{projectNames.unresolvedCount > 0 ? (
															<p className="text-xs text-muted-foreground">
																{projectNames.unresolvedCount} project{" "}
																{projectNames.unresolvedCount === 1 ? "name can’t" : "names can’t"}{" "}
																be shown
															</p>
														) : null}
													</>
												)}
											</div>
										),
									},
									skills: {
										body: skillsLoading ? (
											<OverviewModuleSkeleton label="skills" rows={2} />
										) : blockingSkillsError ? (
											<OverviewModuleError label="Skills" onRetry={() => void refetchSkills()} />
										) : (
											<div className="space-y-3">
												<p className="text-lg font-semibold">
													{(skillsForThisEnv?.length ?? 0) > 0
														? `${skillsForThisEnv?.length} ${skillsForThisEnv?.length === 1 ? "skill" : "skills"}`
														: "No skills available"}
												</p>
												{(skillsForThisEnv?.length ?? 0) > 0 ? (
													<OverviewChips
														items={(skillsForThisEnv ?? []).map((skill) => skill.name)}
														empty="No skills available"
													/>
												) : null}
											</div>
										),
									},
									memories: { body: <OverviewMemoriesBody /> },
									vaults: {
										body: (
											<OverviewVaultsBody
												projectIds={effectiveAgentProjectIds(projectBindings ?? [])}
												isLoading={projectBindingsLoading}
											error={blockingProjectBindingsError}
												onRetry={() => void refetchProjectBindings()}
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
		<section className="flex flex-col gap-4">
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<Skeleton className="size-4 rounded-sm" />
					<Skeleton className="h-5 w-28" />
				</div>
				<Skeleton className="h-4 w-80 max-w-full" />
			</div>
			<div className="grid gap-3 sm:grid-cols-3">
				{Array.from({ length: 3 }).map((_, index) => (
					<DetailPanel key={index} className="p-3">
						<Skeleton className="h-7 w-12" />
						<Skeleton className="mt-1.5 h-3 w-16" />
					</DetailPanel>
				))}
			</div>
			<div className="flex flex-col gap-2">
				{Array.from({ length: 3 }).map((_, index) => (
					<div key={index} className={cn(ENTITY_CARD_BASE, "flex items-start gap-3")}>
						<Skeleton className="size-8 shrink-0 rounded-md" />
						<div className="min-w-0 flex-1">
							<Skeleton className="h-4 w-4/5" />
							<Skeleton className="mt-3 h-3 w-1/2" />
						</div>
					</div>
				))}
			</div>
		</section>
	);
}

function parseAgentTab(value: AgentSectionId | string | null): AgentTab | null {
	if (value === "overview") return "overview";
	if (CONNECTED_AGENT_SECTION_IDS.includes(value as AgentTab)) return value as AgentTab;
	return null;
}
