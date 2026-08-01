"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetAgentBreadcrumbTitle } from "@/components/breadcrumb-title";
import { ConnectorsSurface } from "@/components/connectors/connectors-surface";
import {
	AgentSourceBadgeForEnvironment,
	agentDisplayName,
} from "@/components/dashboard/agent-label";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { AgentProjectsTab } from "@/components/dashboard/agent-projects-tab";
import { AgentSettingsPanel } from "@/components/dashboard/agent-settings-panel";
import { AgentSkillsTab, useAgentProjectSkills } from "@/components/dashboard/agent-skills-tab";
import { AgentVaultsTab } from "@/components/dashboard/agent-vaults-tab";
import { DetailNotFound, DetailPanel } from "@/components/detail/layout";
import { ENTITY_CARD_BASE } from "@/components/entity-card";
import { MemoriesSurface } from "@/components/memories/memories-surface";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SessionFeed } from "@/components/sessions/session-feed";
import { Skeleton } from "@/components/ui/skeleton";
import { agentOwnershipKindFromId, useAgentOwnership } from "@/lib/agent-ownership";
import {
	type AgentRouteSearch,
	type AgentSectionId,
	agentSectionLabel,
	agentSessionDetailLink,
	CONNECTED_AGENT_SECTION_IDS,
} from "@/lib/agent-routes";
import { unwrap, useApi } from "@/lib/api";
import { isApiNotFoundError } from "@/lib/api-errors";
import { AGENT_SECTION_NAVIGATION_ITEMS } from "@/lib/navigation-model";
import { sessionListQueryOptions } from "@/lib/session-queries";
import { cn, errorMessage } from "@/lib/utils";

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
	const api = useApi();
	const ownership = useAgentOwnership();
	const activeTab = parseAgentTab(section) ?? "overview";

	const {
		data: agent,
		isLoading,
		error,
		refetch: refetchAgent,
	} = useQuery({
		queryKey: ["agents", id],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/agents/{agent_id}", {
					params: { path: { agent_id: id } },
				}),
			),
	});

	const {
		data: projectBindings,
		error: projectBindingsError,
		refetch: refetchProjectBindings,
	} = useAgentProjectBindings(id, { enabled: !!agent });

	const {
		data: sessionsPage,
		isLoading: sessionsLoading,
		error: sessionsError,
		refetch: refetchSessions,
	} = useQuery({
		...sessionListQueryOptions(api, { environment_id: id, page_size: 50 }),
		enabled: !!agent,
	});

	const agentProjectId = agent?.default_project_id;
	const {
		skills: skillsForThisEnv,
		error: skillsError,
		refetch: refetchSkills,
	} = useAgentProjectSkills(id, agentProjectId, id, false, Boolean(agent));

	const sessionTotal = sessionsError ? "—" : (sessionsPage?.total ?? 0);
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
			{error ? (
				isApiNotFoundError(error) ? (
					<DetailNotFound title="Agent not found" message={errorMessage(error)} />
				) : (
					<ApiErrorPanel
						error={error}
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
						<div className="flex flex-col gap-4">
							<div className="grid gap-3 sm:grid-cols-3">
								<AgentStatPanel label="Sessions" value={sessionTotal} />
								<AgentStatPanel
									label="Skills"
									value={skillsError ? "—" : skillsForThisEnv ? skillsForThisEnv.length : "—"}
								/>
								<AgentStatPanel
									label="Projects"
									value={projectBindingsError ? "—" : (projectBindings?.length ?? "—")}
								/>
							</div>
							{skillsError ? (
								<ApiErrorPanel
									error={skillsError}
									onRetry={() => {
										void refetchSkills();
									}}
									title="Couldn't load agent skills"
								/>
							) : null}
							{projectBindingsError ? (
								<ApiErrorPanel
									error={projectBindingsError}
									onRetry={() => {
										void refetchProjectBindings();
									}}
									title="Couldn't load agent Projects"
								/>
							) : null}
							{sessionsError ? (
								<ApiErrorPanel
									error={sessionsError}
									onRetry={() => {
										void refetchSessions();
									}}
									title="Couldn't load agent sessions"
								/>
							) : (
								<SessionFeed
									sessions={(sessionsPage?.items ?? []).slice(0, 5)}
									isLoading={sessionsLoading}
									emptyMessage="No sessions synced from this agent yet."
									emptyVariant="inset"
									showAgent={false}
									sessionLink={(session) => scopedSessionLink(session.id)}
								/>
							)}
						</div>
					) : null}

					{activeTab === "sessions" ? (
						sessionsError ? (
							<ApiErrorPanel
								error={sessionsError}
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

function AgentStatPanel({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<DetailPanel className="p-3">
			<div className="text-xl font-semibold tabular-nums">{value}</div>
			<div className="text-xs text-muted-foreground">{label}</div>
		</DetailPanel>
	);
}
