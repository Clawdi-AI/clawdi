import { leaveProjectTitle, projectSharingFormCopy } from "@clawdi/shared/view";

("use client");

import {
	detailLayoutClasses,
	PROJECT_STAT_TILE_TINTS,
	projectDetailClasses,
} from "@clawdi/shared/ui";
import {
	agentDisplayName,
	compareAgentEnvironments,
	displayProjectName,
	identityFor,
	isCustomProject,
	LIBRARY_COPY,
	PROJECT_LOCAL_TABS,
	PROJECT_VAULT_COPY,
	type ProjectAgentMetadata,
	projectAgentFor,
	projectAgentSyncLabel,
	projectDetailDescription,
	projectResourceHref,
	projectVaultCreateDescription,
} from "@clawdi/shared/view";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import {
	ArrowRight,
	Bot,
	CheckCircle2,
	ChevronRight,
	Eye,
	LogOut,
	Plus,
	Save,
	Share2,
} from "lucide-react";
import {
	lazy,
	type ReactElement,
	type ReactNode,
	Suspense,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbSegmentTitle, useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { AgentLabel, AgentSourceBadgeForEnvironment } from "@/components/dashboard/agent-label";
import {
	agentProjectBindingsQueryKey,
	useAgentProjectBindings,
} from "@/components/dashboard/agent-project-bindings-query";
import { orderedAgentProjectBindings } from "@/components/dashboard/agent-project-scope";
import { ConnectedWorkspaceSkillsPanel } from "@/components/dashboard/workspace-skills-panel";
import { DetailBackLink } from "@/components/detail/back-link";
import { DetailNotFound, DetailPanel } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { HeaderActionGroup } from "@/components/header-action-group";
import { IconChip } from "@/components/icon-chip";
import { PageHeader, type PageHeaderProps, PageHeaderSkeleton } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { ProjectActions } from "@/components/projects/project-actions";
import { ProjectIdentity } from "@/components/projects/project-metadata";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
import { CreateSkillDialog } from "@/components/skills/create-skill-dialog";
import { SkillCardGrid, SkillCardSkeleton } from "@/components/skills/skill-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProjectVaultCatalog } from "@/components/vault/project-vault-catalog";
import { slugFromVaultName } from "@/components/vault/vault-slug";
import { agentDetailQueryKey, agentDetailQueryOptions } from "@/lib/agent-queries";
import {
	agentProjectDetailHref,
	agentProjectResourceHref,
	agentSectionHref,
	agentSectionLabel,
	agentSectionLink,
	agentSkillDetailLink,
} from "@/lib/agent-routes";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import { isApiNotFoundError, normalizeApiError } from "@/lib/api-errors";
import { fetchAllPages } from "@/lib/api-pagination";
import type { components } from "@/lib/api-schemas";
import { AGENT_SECTION_NAVIGATION_ITEMS } from "@/lib/navigation-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import {
	projectDetailHrefForScope,
	type ResourceNavigationScope,
	type ResourceNavigationTarget,
	resourceCatalogReturnTarget,
	resourceCollectionTarget,
} from "@/lib/resource-navigation";
import { isBrowserWritableSkillProject, skillCapabilities } from "@/lib/skill-authority";
import { useCommittedLocation } from "@/lib/use-committed-location";
import { cn } from "@/lib/utils";

type VaultSummary = components["schemas"]["VaultResponse"];
type Env = components["schemas"]["AgentResponse"];
type ProjectRow = components["schemas"]["ProjectResponse"];
type Member = components["schemas"]["MemberResponse"];
type CountValue = number | "unavailable";
type ProjectLocalTab = "overview" | "skills" | "vaults" | "agents" | "access";

const PROJECT_RESOURCE_PAGE_SIZE = 30;

function isProjectLocalTab(value: unknown): value is ProjectLocalTab {
	return typeof value === "string" && PROJECT_LOCAL_TABS.some((tab) => tab.id === value);
}

function projectLocalTabHref(
	pathname: string,
	searchParams: URLSearchParams,
	tab: ProjectLocalTab,
): string {
	const nextSearch = new URLSearchParams(searchParams);
	nextSearch.set("tab", tab);
	if (tab !== "vaults") nextSearch.delete("q");
	if (tab !== "overview") {
		nextSearch.delete("joined");
		nextSearch.delete("useWithAgent");
	}
	const query = nextSearch.toString();
	return `${pathname}${query ? `?${query}` : ""}`;
}

function searchRecordToSearchParams(search: Record<string, unknown>): URLSearchParams {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(search)) {
		if (typeof value === "string") {
			params.set(key, value);
		} else if (Array.isArray(value)) {
			for (const item of value) if (typeof item === "string") params.append(key, item);
		} else if (value != null) {
			params.set(key, String(value));
		}
	}
	return params;
}

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";
const HostedWorkspaceSkillsPanel = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/agents/hosted-workspace-skills-panel").then((module) => ({
				default: module.HostedWorkspaceSkillsPanel,
			})),
		)
	: null;

export default function ProjectDetailPage({
	projectId,
	scope,
	focus,
}: {
	projectId: string;
	scope: ResourceNavigationScope;
	focus?: "skills" | "vaults";
}) {
	const api = useApi();
	const $api = useOpenApi();
	const qc = useQueryClient();
	const router = useRouter();
	// Committed-match location, not the pending target: this page stays
	// mounted while an outgoing navigation loads, and the rendered tab must
	// keep matching the URL the user is still looking at.
	const { pathname, search } = useCommittedLocation();
	const searchParams = useMemo(() => searchRecordToSearchParams(search), [search]);
	const projectQuery = $api.useQuery("get", "/v1/projects/{project_id}", {
		params: { path: { project_id: projectId } },
	});

	const project = projectQuery.data ?? null;
	const requestedTab = searchParams.get("tab");
	const localTab: ProjectLocalTab = PROJECT_LOCAL_TABS.some((tab) => tab.id === requestedTab)
		? (requestedTab as ProjectLocalTab)
		: (focus ?? "overview");
	const projectsTarget = resourceCollectionTarget(scope, "projects");
	const isWorkspaceView = scope.kind === "agent" && project?.kind === "environment";
	const showSkills = isWorkspaceView ? focus !== "vaults" : localTab === "skills";
	const showVaults = isWorkspaceView ? focus !== "skills" : localTab === "vaults";
	const [useWithAgentOpen, setUseWithAgentOpen] = useState(
		searchParams.get("useWithAgent") === "1",
	);
	const [skillsPage, setSkillsPage] = useState(1);
	const joinedFromShare = !isWorkspaceView && searchParams.get("joined") === "share";
	const catalogReturnTarget = resourceCatalogReturnTarget(searchParams.get("from"));
	useEffect(() => {
		setSkillsPage(1);
	}, [projectId]);

	const projectName = project ? displayProjectName(project) : null;
	const projectResourceTargets =
		scope.kind === "agent"
			? {
					skills: agentProjectResourceHref(scope.agentId, projectId, "skills"),
					vaults: agentProjectResourceHref(scope.agentId, projectId, "vaults"),
				}
			: {
					skills: projectResourceHref("skills", projectId),
					vaults: projectResourceHref("vaults", projectId),
				};
	const isOwner = project?.is_owner !== false;
	const canManageSkills = isBrowserWritableSkillProject(project);
	const isShareableProject = project ? isCustomProject(project) : false;
	const scopedBindings = useAgentProjectBindings(scope.kind === "agent" ? scope.agentId : "", {
		enabled: scope.kind === "agent",
	});
	const orderedScopedBindings = useMemo(
		() => orderedAgentProjectBindings(scopedBindings.data ?? []),
		[scopedBindings.data],
	);
	const scopedBinding =
		orderedScopedBindings.find((binding) => binding.project_id === projectId) ?? null;
	const isWorkspace = isWorkspaceView && scopedBinding?.binding_type === "primary";
	const canManageProjectSkills = canManageSkills && !isWorkspace;
	const pageReturnTarget: ResourceNavigationTarget =
		isWorkspaceView && focus && scope.kind === "agent"
			? isWorkspace
				? {
						href: agentSectionHref(scope.agentId, "overview"),
						label: "Agent Overview",
					}
				: {
						href: projectDetailHrefForScope(scope, projectId),
						label: projectName ?? "Project",
					}
			: (catalogReturnTarget ?? projectsTarget);
	const workspaceAgent = useQuery({
		...agentDetailQueryOptions($api, qc, scope.kind === "agent" ? scope.agentId : ""),
		enabled: scope.kind === "agent" && isWorkspace && showSkills && !IS_HOSTED_BUILD,
	});
	useEffect(() => {
		if (searchParams.get("useWithAgent") === "1") setUseWithAgentOpen(true);
	}, [searchParams]);

	const handleUseWithAgentOpenChange = (open: boolean) => {
		setUseWithAgentOpen(open);
		if (!open && searchParams.get("useWithAgent") === "1") {
			const nextSearch = new URLSearchParams(searchParams);
			nextSearch.delete("useWithAgent");
			const nextQuery = nextSearch.toString();
			void router.navigate({
				href: `${pathname}${nextQuery ? `?${nextQuery}` : ""}`,
				replace: true,
				resetScroll: false,
			});
		}
	};

	const environments = $api.useQuery(
		"get",
		"/v1/agents",
		{},
		{ enabled: !isWorkspaceView && !!project && useWithAgentOpen },
	);
	const agentsById = useMemo(
		() => new Map((environments.data ?? []).map((agent) => [agent.id, agent])),
		[environments.data],
	);
	const projectAgent = project ? projectAgentFor(project, agentsById) : null;
	const localTabHref = (tab: ProjectLocalTab) =>
		projectLocalTabHref(projectDetailHrefForScope(scope, projectId), searchParams, tab);
	const selectLocalTab = (tab: ProjectLocalTab) => {
		void router.navigate({ href: localTabHref(tab), resetScroll: false });
	};

	const skills = useQuery({
		queryKey: ["skills", "project-detail", projectId, skillsPage],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/skills", {
					params: {
						query: {
							project_id: projectId,
							page: skillsPage,
							page_size: PROJECT_RESOURCE_PAGE_SIZE,
						},
					},
				}),
			),
		enabled:
			showSkills &&
			(!isWorkspaceView || !!scopedBinding || Boolean(project && isCustomProject(project))) &&
			!(IS_HOSTED_BUILD && isWorkspace),
	});
	const workspaceSkillProjections = useMemo(
		() => (skills.data?.items ?? []).filter((skill) => skill.authority === "agent_sync"),
		[skills.data?.items],
	);

	const vaults = useQuery({
		queryKey: ["get", "/v1/vault", "project-detail", projectId],
		queryFn: ({ signal }) =>
			fetchAllPages<VaultSummary>(
				async (page, pageSize) =>
					unwrap(
						await api.GET("/v1/vault", {
							signal,
							params: { query: { project_id: projectId, page, page_size: pageSize } },
						}),
					),
				{ pageSize: 200, resourceName: "Project Vaults" },
			),
		enabled:
			showVaults &&
			(!isWorkspaceView || !!scopedBinding || Boolean(project && isCustomProject(project))),
	});
	useEffect(() => {
		if (skills.data?.total === undefined) return;
		const pageCount = Math.max(1, Math.ceil(skills.data.total / PROJECT_RESOURCE_PAGE_SIZE));
		setSkillsPage((page) => Math.min(page, pageCount));
	}, [skills.data?.total]);

	// People tile/section — members list is owner-only on the API; viewers
	// simply don't get the section.
	const members = useQuery({
		queryKey: ["project-members", projectId],
		queryFn: async (): Promise<Member[]> =>
			unwrap(
				await api.GET("/v1/projects/{project_id}/members", {
					params: { path: { project_id: projectId } },
				}),
			),
		enabled:
			!isWorkspaceView && !!project && isOwner && isShareableProject && localTab === "access",
	});

	const boundAgents = $api.useQuery(
		"get",
		"/v1/agents",
		{ params: { query: { project_id: projectId } } },
		{ enabled: !isWorkspaceView && !!project && (localTab === "agents" || useWithAgentOpen) },
	);

	const refresh = async () => {
		await Promise.all([
			qc.invalidateQueries({ queryKey: ["get", "/v1/projects"] }),
			qc.invalidateQueries({ queryKey: ["get", "/v1/projects/{project_id}"] }),
			qc.invalidateQueries({ queryKey: ["skills"] }),
			qc.invalidateQueries({ queryKey: ["vaults"] }),
			qc.invalidateQueries({ queryKey: ["get", "/v1/vault"] }),
			qc.invalidateQueries({ queryKey: ["get", "/v1/agents"] }),
		]);
	};

	const removeProjectSkill = useMutation({
		mutationFn: async ({
			skillKey,
			skillProjectId,
		}: {
			skillKey: string;
			skillProjectId: string;
		}) =>
			unwrap(
				await api.DELETE("/v1/projects/{project_id}/skills/{skill_key}", {
					params: { path: { project_id: skillProjectId, skill_key: skillKey } },
				}),
			),
		onSuccess: () => {
			refresh();
			toast.success("Skill removed from Project");
		},
		onError: (error) =>
			toast.error("Couldn't remove Skill from Project", {
				description: normalizeApiError(error),
			}),
	});

	const leaveSharedProject = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.POST("/v1/projects/{project_id}/leave", {
					params: { path: { project_id: projectId } },
				}),
			),
		onSuccess: () => {
			refresh();
			qc.invalidateQueries({
				queryKey: ["get", "/v1/agents/{agent_id}/project-bindings"],
			});
			toast.success("Left shared project", { description: "Membership removed." });
			void router.navigate({ href: projectsTarget.href });
		},
		onError: (error) => {
			toast.error("Couldn't leave shared project", {
				description: normalizeApiError(error),
			});
		},
	});

	useSetBreadcrumbSegmentTitle(
		scope.kind === "agent" ? agentProjectDetailHref(scope.agentId, projectId) : null,
		isWorkspace ? "Workspace" : projectName,
		isWorkspace ? "workspace" : undefined,
	);
	useSetBreadcrumbTitle(
		projectName
			? focus
				? agentSectionLabel(focus)
				: isWorkspace
					? "Workspace"
					: projectName
			: null,
	);

	if (projectQuery.isLoading || (isWorkspaceView && scopedBindings.isLoading)) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, detailLayoutClasses.detailPage)}>
				<DetailBackLink
					href={catalogReturnTarget?.href ?? projectsTarget.href}
					label={catalogReturnTarget?.label ?? projectsTarget.label}
					mobileOnly={false}
				/>
				<PageHeaderSkeleton icon actions />
				<div className={projectDetailClasses.statGrid}>
					{Array.from({ length: 4 }).map((_, i) => (
						<Skeleton key={i} className={projectDetailClasses.statSkeleton} />
					))}
				</div>
				<Skeleton className={projectDetailClasses.panelSkeleton} />
			</div>
		);
	}

	const blockingScopeError = isWorkspaceView
		? shouldBlockQueryError(scopedBindings.error, scopedBindings.data)
			? scopedBindings.error
			: null
		: null;
	const blockingProjectError = shouldBlockQueryError(projectQuery.error, projectQuery.data)
		? projectQuery.error
		: null;

	if (blockingProjectError || blockingScopeError) {
		const blockingError = blockingProjectError ?? blockingScopeError;
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, detailLayoutClasses.detailPage)}>
				<DetailBackLink
					href={catalogReturnTarget?.href ?? projectsTarget.href}
					label={catalogReturnTarget?.label ?? projectsTarget.label}
					mobileOnly={false}
				/>
				{isApiNotFoundError(blockingError) ? (
					<DetailNotFound
						title="Project not found"
						message="This Project may have been removed, or your account no longer has access."
					/>
				) : (
					<ApiErrorPanel
						error={blockingError}
						onRetry={() => {
							if (blockingProjectError) void projectQuery.refetch();
							if (blockingScopeError) void scopedBindings.refetch();
						}}
						title={
							blockingScopeError
								? "Couldn't load Workspace or Project access"
								: "Couldn't load project"
						}
					/>
				)}
			</div>
		);
	}

	if (!project) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, detailLayoutClasses.detailPage)}>
				<DetailBackLink
					href={catalogReturnTarget?.href ?? projectsTarget.href}
					label={catalogReturnTarget?.label ?? projectsTarget.label}
					mobileOnly={false}
				/>
				<DetailNotFound
					title="Project not found"
					message="This Project may have been removed, or your account no longer has access."
				/>
			</div>
		);
	}

	if (!isWorkspaceView && project.kind !== "workspace") {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, detailLayoutClasses.detailPage)}>
				<DetailBackLink
					href={catalogReturnTarget?.href ?? projectsTarget.href}
					label={catalogReturnTarget?.label ?? projectsTarget.label}
					mobileOnly={false}
				/>
				<DetailNotFound
					title="Project not found"
					message="This page is for user-created Projects. Open an Agent to manage its private Workspace."
				/>
			</div>
		);
	}

	const blockingSkillsError = shouldBlockQueryError(skills.error, skills.data)
		? skills.error
		: null;
	const blockingVaultsError = shouldBlockQueryError(vaults.error, vaults.data)
		? vaults.error
		: null;
	const blockingWorkspaceAgentError = shouldBlockQueryError(
		workspaceAgent.error,
		workspaceAgent.data,
	)
		? workspaceAgent.error
		: null;
	const blockingMembersError = shouldBlockQueryError(members.error, members.data)
		? members.error
		: null;
	const blockingBoundAgentsError = shouldBlockQueryError(boundAgents.error, boundAgents.data)
		? boundAgents.error
		: null;
	const blockingEnvironmentsError = shouldBlockQueryError(environments.error, environments.data)
		? environments.error
		: null;
	const skillCount: CountValue | undefined = isWorkspaceView
		? isWorkspace || project.kind === "environment"
			? undefined
			: blockingSkillsError
				? "unavailable"
				: skills.data?.total
		: project.skill_count;
	const vaultCount: CountValue | undefined = isWorkspaceView
		? blockingVaultsError
			? "unavailable"
			: vaults.data?.total
		: project.vault_count;
	const peopleCount: CountValue | undefined = project.member_count + 1;
	const agentCount: CountValue | undefined = project.agent_count;

	const manageAgentsDialog = (trigger: ReactElement) => (
		<ManageProjectAgentsDialog
			project={project}
			environments={environments.data ?? []}
			linkedEnvironments={boundAgents.data ?? []}
			isLoadingAgents={environments.isLoading || boundAgents.isLoading}
			agentsError={blockingEnvironmentsError ?? blockingBoundAgentsError}
			onRetryAgents={() => {
				void environments.refetch();
				void boundAgents.refetch();
			}}
			open={useWithAgentOpen}
			onOpenChange={handleUseWithAgentOpenChange}
		>
			{trigger}
		</ManageProjectAgentsDialog>
	);
	const projectIdentity = identityFor(displayProjectName(project));
	const workspaceIdentity = identityFor("Workspace");
	const focusedResourceIdentity =
		isWorkspaceView && focus ? AGENT_SECTION_NAVIGATION_ITEMS[focus] : null;
	const FocusedResourceIcon = focusedResourceIdentity?.icon ?? null;
	const focusedWorkspaceSkillsPageHeaderProps: Omit<PageHeaderProps, "actions"> | undefined =
		isWorkspace && focus === "skills"
			? {
					title: "Skills",
					description:
						"Skills available in this Agent's Workspace. Skills synced from the Agent are read-only.",
					icon:
						focusedResourceIdentity && FocusedResourceIcon ? (
							<IconChip tint={focusedResourceIdentity.tint}>
								<FocusedResourceIcon />
							</IconChip>
						) : undefined,
				}
			: undefined;
	const focusedWorkspaceSkillsPageHeader = focusedWorkspaceSkillsPageHeaderProps ? (
		<PageHeader {...focusedWorkspaceSkillsPageHeaderProps} />
	) : null;
	const focusedWorkspaceSkillsLoading = focusedWorkspaceSkillsPageHeader ? (
		<div className={projectDetailClasses.page}>
			{focusedWorkspaceSkillsPageHeader}
			<ProjectSkillsLoadingGrid />
		</div>
	) : (
		<ProjectSkillsLoadingGrid />
	);
	const workspaceAgentErrorPanel = blockingWorkspaceAgentError ? (
		<ApiErrorPanel
			error={blockingWorkspaceAgentError}
			onRetry={() => {
				void workspaceAgent.refetch();
			}}
			title="Couldn't load the Agent identity"
		/>
	) : null;

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, detailLayoutClasses.page)}>
			<DetailBackLink
				href={pageReturnTarget.href}
				label={pageReturnTarget.label}
				mobileOnly={!catalogReturnTarget}
			/>

			{isWorkspace && focus === "skills" ? null : (
				<PageHeader
					title={
						focusedResourceIdentity?.label ??
						(isWorkspace ? "Workspace" : displayProjectName(project))
					}
					icon={
						focusedResourceIdentity && FocusedResourceIcon ? (
							<IconChip tint={focusedResourceIdentity.tint}>
								<FocusedResourceIcon />
							</IconChip>
						) : (
							<IconChip
								tint={isWorkspace ? workspaceIdentity.colorClasses : projectIdentity.colorClasses}
								className={projectDetailClasses.emoji}
							>
								{isWorkspace ? workspaceIdentity.emoji : projectIdentity.emoji}
							</IconChip>
						)
					}
					description={
						isWorkspace
							? focus === "vaults"
								? "Vaults available through this Agent’s Workspace."
								: "This Agent's fixed Workspace for installed Skills and Vaults."
							: projectDetailDescription(project, isOwner)
					}
					actions={
						isShareableProject ? (
							<>
								{!isWorkspaceView && !joinedFromShare
									? manageAgentsDialog(
											<Button size="sm">
												<Bot className={projectDetailClasses.inlineActionIcon} />
												{LIBRARY_COPY.manageAgents}
											</Button>,
										)
									: null}
								{isOwner ? (
									<ProjectActions
										project={project}
										onChanged={refresh}
										onArchived={() => router.navigate({ href: projectsTarget.href })}
									/>
								) : null}
							</>
						) : undefined
					}
				/>
			)}

			{joinedFromShare && isShareableProject ? (
				<Alert>
					<CheckCircle2 className={projectDetailClasses.icon} />
					<AlertTitle>Project added</AlertTitle>
					<AlertDescription className={projectDetailClasses.alertDescription}>
						<span>Linking lets an Agent use this Project&apos;s Skills and Vaults together.</span>
						<Button type="button" size="sm" onClick={() => setUseWithAgentOpen(true)}>
							<Bot className={projectDetailClasses.inlineActionIcon} />
							{LIBRARY_COPY.manageAgents}
						</Button>
					</AlertDescription>
				</Alert>
			) : null}

			{!isWorkspaceView ? (
				<Tabs
					value={localTab}
					onValueChange={(value) => {
						if (isProjectLocalTab(value)) selectLocalTab(value);
					}}
				>
					<TabsList
						aria-label="Project pages"
						activateOnFocus
						className={projectDetailClasses.tabs}
					>
						{PROJECT_LOCAL_TABS.map((tab) => (
							<TabsTrigger key={tab.id} value={tab.id} className={projectDetailClasses.tab}>
								{tab.label}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
			) : null}

			{!isWorkspaceView && localTab === "overview" ? (
				<DetailPanel className={projectDetailClasses.panel}>
					<div className={projectDetailClasses.headingStack}>
						<h2 className={projectDetailClasses.heading}>{LIBRARY_COPY.projectBundle}</h2>
						<p className={projectDetailClasses.description}>
							{project.description || LIBRARY_COPY.projectBundleDescription}
						</p>
					</div>
					<div className={projectDetailClasses.statGrid}>
						<StatTile label="Skills" value={skillCount} href={localTabHref("skills")} />
						<StatTile label="Vaults" value={vaultCount} href={localTabHref("vaults")} />
						<StatTile
							label={LIBRARY_COPY.people}
							value={peopleCount}
							href={localTabHref("access")}
						/>
						<StatTile label="Agents" value={agentCount} href={localTabHref("agents")} />
					</div>
				</DetailPanel>
			) : null}

			<HubSection
				visible={showSkills}
				showHeading={!isWorkspaceView || !focus}
				id="skills"
				title="Skills"
				count={skillCount}
				description={
					isWorkspaceView
						? isWorkspace
							? "Installed Skills in this Agent's fixed Workspace."
							: "Skills included in this Project."
						: project.kind === "environment"
							? "Skills synced from this Agent. Manage them on the Agent."
							: isOwner
								? LIBRARY_COPY.projectSkillsDescription
								: "Readable instructions shared by the owner."
				}
				action={
					(!focus || !isWorkspaceView) && (projectResourceTargets || canManageProjectSkills) ? (
						<>
							{!focus && projectResourceTargets ? (
								<ProjectResourceViewAllLink
									href={projectResourceTargets.skills}
									resource="Skills"
								/>
							) : null}
							{canManageProjectSkills ? (
								<CreateSkillDialog project={project} onCreated={refresh}>
									<Button variant="outline" size="sm">
										<Plus className={projectDetailClasses.actionIcon} />
										{LIBRARY_COPY.addSkill}
									</Button>
								</CreateSkillDialog>
							) : null}
						</>
					) : undefined
				}
			>
				{workspaceAgentErrorPanel ? (
					focusedWorkspaceSkillsPageHeader ? (
						<div className={projectDetailClasses.page}>
							{focusedWorkspaceSkillsPageHeader}
							{workspaceAgentErrorPanel}
						</div>
					) : (
						workspaceAgentErrorPanel
					)
				) : isWorkspace && scope.kind === "agent" ? (
					IS_HOSTED_BUILD && HostedWorkspaceSkillsPanel ? (
						<Suspense fallback={focusedWorkspaceSkillsLoading}>
							<HostedWorkspaceSkillsPanel
								agentId={scope.agentId}
								projectId={project.id}
								pageHeader={focusedWorkspaceSkillsPageHeaderProps}
							/>
						</Suspense>
					) : workspaceAgent.data ? (
						<ConnectedWorkspaceSkillsPanel
							agentId={scope.agentId}
							projectId={project.id}
							agentType={workspaceAgent.data.agent_type}
							projections={workspaceSkillProjections}
							isLoading={skills.isLoading}
							projectionError={blockingSkillsError}
							pageHeader={focusedWorkspaceSkillsPageHeaderProps}
							onRetryProjections={() => {
								void skills.refetch();
							}}
						/>
					) : (
						focusedWorkspaceSkillsLoading
					)
				) : blockingSkillsError ? (
					<ApiErrorPanel
						error={blockingSkillsError}
						onRetry={() => {
							void skills.refetch();
						}}
						title="Couldn't load Project Skills"
					/>
				) : (
					<SkillCardGrid
						skills={skills.data?.items ?? []}
						isLoading={skills.isLoading}
						emptyMessage={LIBRARY_COPY.emptyProjectSkills}
						emptyVariant="inset"
						capabilitiesFor={(skill) => skillCapabilities(skill, project)}
						onUninstall={
							canManageProjectSkills
								? (skillKey, skillProjectId) =>
										removeProjectSkill.mutateAsync({ skillKey, skillProjectId })
								: undefined
						}
						uninstallPending={removeProjectSkill.isPending}
						skillLink={
							scope.kind === "agent"
								? (skill) => agentSkillDetailLink(scope.agentId, skill.skill_key, project.id)
								: undefined
						}
					/>
				)}
				<ResourcePageControls
					page={skillsPage}
					total={skills.data?.total}
					pageSize={PROJECT_RESOURCE_PAGE_SIZE}
					isFetching={skills.isFetching}
					onPageChange={setSkillsPage}
				/>
			</HubSection>

			<HubSection
				visible={showVaults}
				showHeading={!isWorkspaceView || !focus}
				id="vaults"
				title="Vaults"
				count={isWorkspaceView ? vaultCount : undefined}
				description={
					isWorkspaceView
						? isWorkspace
							? "Vaults available through this Agent’s Workspace."
							: LIBRARY_COPY.projectVaultsDescription
						: isOwner
							? LIBRARY_COPY.projectVaultsDescription
							: "Read-only vaults shared through this Project."
				}
				action={
					(!focus || !isWorkspaceView) && (isWorkspaceView || isOwner) ? (
						<>
							{!focus && isWorkspaceView && projectResourceTargets ? (
								<ProjectResourceViewAllLink
									href={projectResourceTargets.vaults}
									resource="Vaults"
								/>
							) : null}
							{isOwner && !isWorkspaceView ? (
								<CreateProjectVaultDialog
									projectId={project.id}
									contextLabel={isWorkspace ? "Workspace" : "Project"}
									onChanged={refresh}
								/>
							) : null}
						</>
					) : undefined
				}
			>
				<ProjectVaultCatalog
					key={project.id}
					project={project}
					attachedVaults={vaults.data?.items}
					attachedVaultsUpdatedAt={vaults.dataUpdatedAt}
					isLoading={vaults.isLoading}
					error={vaults.error}
					onRetry={() => void vaults.refetch()}
					scope={scope}
					onChanged={refresh}
				/>
			</HubSection>

			{!isWorkspaceView && localTab === "access" && isOwner && isShareableProject ? (
				<HubSection
					id="people"
					title={LIBRARY_COPY.people}
					count={peopleCount}
					description={LIBRARY_COPY.peopleDescription}
					action={
						<ShareProjectDialog
							projectId={project.id}
							projectName={displayProjectName(project)}
							projectKind={project.kind}
						>
							<Button variant="outline" size="sm">
								<Share2 className={projectDetailClasses.inlineActionIcon} />
								Manage sharing
							</Button>
						</ShareProjectDialog>
					}
				>
					{members.isLoading ? (
						<Skeleton className={projectDetailClasses.rowSkeleton} />
					) : blockingMembersError ? (
						<ApiErrorPanel
							error={blockingMembersError}
							onRetry={() => {
								void members.refetch();
							}}
							title="Couldn't load Project members"
						/>
					) : (members.data?.length ?? 0) === 0 ? (
						<EmptyLine message="Only you so far. Share this Project to give a teammate viewer access." />
					) : (
						<div className={projectDetailClasses.rowList}>
							{(members.data ?? []).map((member) => (
								<div key={member.user_id} className={projectDetailClasses.row}>
									<span className={projectDetailClasses.rowName}>
										{member.user_email ?? member.user_display ?? member.user_id}
									</span>
									<Badge variant="secondary">{member.role}</Badge>
								</div>
							))}
						</div>
					)}
				</HubSection>
			) : null}

			{!isWorkspaceView && localTab === "access" && !isOwner ? (
				<HubSection
					id="people"
					title="Your access"
					description="You have viewer access. Linked Agents use this Project's Skills and Vaults together."
				>
					<SharedAccessPanel
						project={project}
						agent={projectAgent}
						isLeaving={leaveSharedProject.isPending}
						onLeave={() => leaveSharedProject.mutate()}
						useWithAgentControl={null}
					/>
				</HubSection>
			) : null}

			{!isWorkspaceView && localTab === "agents" ? (
				<HubSection
					id="agents"
					title={LIBRARY_COPY.yourAgents}
					count={agentCount}
					description={
						project.kind === "environment"
							? "Agent that owns this Workspace."
							: project.kind === "personal"
								? "Private library items are not linked to individual Agents."
								: LIBRARY_COPY.projectAgentsDescription
					}
				>
					{boundAgents.isLoading ? (
						<Skeleton className={projectDetailClasses.rowSkeleton} />
					) : blockingBoundAgentsError ? (
						<ApiErrorPanel
							error={blockingBoundAgentsError}
							onRetry={() => {
								void boundAgents.refetch();
							}}
							title="Couldn't load Project agent bindings"
						/>
					) : (boundAgents.data?.length ?? 0) === 0 ? (
						<EmptyLine
							message={
								project.kind === "environment"
									? "The home Agent for this Workspace is unavailable."
									: project.kind === "personal"
										? "Private library items have no Agent links."
										: LIBRARY_COPY.emptyProjectAgents
							}
						/>
					) : (
						<div className={projectDetailClasses.rowList}>
							{(boundAgents.data ?? []).map((env) => (
								<div key={env.id} className={projectDetailClasses.agentRow}>
									<AgentLabel
										machineName={env.machine_name}
										displayName={env.display_name}
										defaultName={env.default_name}
										type={env.agent_type}
										avatarUrl={env.avatar_url}
										size="sm"
										titleAdornment={<AgentSourceBadgeForEnvironment env={env} compact />}
										className={projectDetailClasses.agentIdentity}
									/>
									{env.default_project_id === project.id ? (
										<Badge variant="secondary" className={projectDetailClasses.badge}>
											Workspace
										</Badge>
									) : null}
									<Link
										{...agentSectionLink(env.id, "projects")}
										className={projectDetailClasses.stretchedLink}
									>
										<span className={projectDetailClasses.screenReaderOnly}>
											Open agent {agentDisplayName(env)}
										</span>
									</Link>
								</div>
							))}
						</div>
					)}
				</HubSection>
			) : null}
		</div>
	);
}

function StatTile({ label, value, href }: { label: string; value?: CountValue; href: string }) {
	return (
		<Link
			to={href}
			className={cn(projectDetailClasses.statTile, PROJECT_STAT_TILE_TINTS[label] ?? "bg-card")}
		>
			<div className={projectDetailClasses.statValue}>
				{value === undefined ? (
					<Skeleton className={projectDetailClasses.statValueSkeleton} />
				) : (
					formatCountValue(value)
				)}
			</div>
			<div className={projectDetailClasses.statLabel}>
				{label}
				<ChevronRight className={projectDetailClasses.statArrow} />
			</div>
		</Link>
	);
}

function ResourcePageControls({
	page,
	total,
	pageSize,
	isFetching,
	onPageChange,
}: {
	page: number;
	total?: number;
	pageSize: number;
	isFetching: boolean;
	onPageChange: (page: number) => void;
}) {
	if (total === undefined || total <= pageSize) return null;
	const pageCount = Math.max(1, Math.ceil(total / pageSize));
	return (
		<nav aria-label="Resource pages" className={projectDetailClasses.pagination}>
			<p className={projectDetailClasses.pageCount}>
				Page {page} of {pageCount}
			</p>
			<div className={projectDetailClasses.paginationActions}>
				<Button
					variant="outline"
					size="sm"
					disabled={page <= 1 || isFetching}
					onClick={() => onPageChange(Math.max(1, page - 1))}
				>
					Previous
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={page >= pageCount || isFetching}
					onClick={() => onPageChange(Math.min(pageCount, page + 1))}
				>
					Next
				</Button>
			</div>
		</nav>
	);
}

function HubSection({
	visible = true,
	showHeading = true,
	id,
	title,
	count,
	description,
	action,
	children,
}: {
	visible?: boolean;
	showHeading?: boolean;
	id: string;
	title: string;
	count?: CountValue;
	description: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	if (!visible) return null;
	return (
		<section id={id} className={projectDetailClasses.section}>
			{showHeading ? (
				<div className={projectDetailClasses.sectionHeader}>
					<div className={projectDetailClasses.sectionHeading}>
						<div className={projectDetailClasses.paginationActions}>
							<h2 className={projectDetailClasses.heading}>{title}</h2>
							{count !== undefined ? (
								<Badge variant="secondary" className={projectDetailClasses.resourceCount}>
									{formatCountValue(count)}
								</Badge>
							) : null}
						</div>
						<p className={projectDetailClasses.subtitle}>{description}</p>
					</div>
					{action ? <HeaderActionGroup>{action}</HeaderActionGroup> : null}
				</div>
			) : null}
			{children}
		</section>
	);
}

function ProjectResourceViewAllLink({
	href,
	resource,
}: {
	href: string;
	resource: "Skills" | "Vaults";
}) {
	return (
		<Button
			render={<Link to={href} aria-label={`View all ${resource}`} />}
			nativeButton={false}
			variant="ghost"
			size="sm"
			className={projectDetailClasses.emptyCount}
		>
			View all
			<ArrowRight />
		</Button>
	);
}

function SharedAccessPanel({
	project,
	agent,
	isLeaving,
	onLeave,
	useWithAgentControl,
}: {
	project: ProjectRow;
	agent?: ProjectAgentMetadata | null;
	isLeaving: boolean;
	onLeave: () => void;
	useWithAgentControl: ReactNode;
}) {
	return (
		<DetailPanel className={projectDetailClasses.form}>
			<div className={projectDetailClasses.headingStack}>
				<div className={projectDetailClasses.paginationActions}>
					<Eye className={projectDetailClasses.mutedIcon} />
					<h2 className={projectDetailClasses.heading}>You have viewer access</h2>
				</div>
				<p className={projectDetailClasses.meta}>
					You can read this Project and link it to an Agent. The Agent then uses the Project&apos;s
					Skills and Vaults together.
				</p>
			</div>
			<div className={projectDetailClasses.inset}>
				<div className={projectDetailClasses.actionRow}>
					<ProjectIdentity
						project={project}
						agent={agent}
						showKind={false}
						className={projectDetailClasses.control}
					/>
				</div>
			</div>
			{useWithAgentControl}
			<AlertDialog>
				<AlertDialogTrigger
					render={
						<Button
							variant="ghost"
							size="sm"
							disabled={isLeaving}
							className={projectDetailClasses.destructiveAction}
						/>
					}
				>
					<LogOut className={projectDetailClasses.inlineActionIcon} />
					{isLeaving ? "Leaving…" : "Leave project"}
				</AlertDialogTrigger>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{leaveProjectTitle(displayProjectName(project))}</AlertDialogTitle>
						<AlertDialogDescription>
							{projectSharingFormCopy.leaveDescription}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{LIBRARY_COPY.cancel}</AlertDialogCancel>
						<AlertDialogAction onClick={onLeave} className={projectDetailClasses.destructiveButton}>
							Leave project
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</DetailPanel>
	);
}

function ManageProjectAgentsDialog({
	project,
	environments,
	linkedEnvironments,
	isLoadingAgents,
	agentsError,
	onRetryAgents,
	open,
	onOpenChange,
	children,
}: {
	project: ProjectRow;
	environments: Env[];
	linkedEnvironments: Env[];
	isLoadingAgents: boolean;
	agentsError?: unknown;
	onRetryAgents: () => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactElement;
}) {
	const api = useApi();
	const qc = useQueryClient();
	const [managedAgentIds, setManagedAgentIds] = useState<Set<string>>(() => new Set());
	const updateAgentsLockedRef = useRef(false);
	const orderedEnvironments = useMemo(
		() => [...environments].sort(compareAgentEnvironments),
		[environments],
	);
	const linkedAgentIds = useMemo(
		() => new Set(linkedEnvironments.map((environment) => environment.id)),
		[linkedEnvironments],
	);
	const agentIdsToAdd = orderedEnvironments
		.filter(
			(environment) => managedAgentIds.has(environment.id) && !linkedAgentIds.has(environment.id),
		)
		.map((environment) => environment.id);
	const agentIdsToRemove = orderedEnvironments
		.filter(
			(environment) => linkedAgentIds.has(environment.id) && !managedAgentIds.has(environment.id),
		)
		.map((environment) => environment.id);
	const hasAgentChanges = agentIdsToAdd.length > 0 || agentIdsToRemove.length > 0;

	useEffect(() => {
		setManagedAgentIds(open ? new Set(linkedAgentIds) : new Set());
	}, [open, linkedAgentIds]);

	const updateProjectAgents = useMutation({
		mutationFn: async ({
			addAgentIds,
			removeAgentIds,
		}: {
			addAgentIds: string[];
			removeAgentIds: string[];
		}) => {
			return unwrap(
				await api.PATCH("/v1/projects/{project_id}/agents", {
					params: { path: { project_id: project.id } },
					body: {
						add_agent_ids: addAgentIds,
						remove_agent_ids: removeAgentIds,
					},
				}),
			);
		},
		onSuccess: async (response) => {
			const changedAgentIds = [...response.added_agent_ids, ...response.removed_agent_ids];
			await Promise.all([
				qc.invalidateQueries({ queryKey: ["get", "/v1/projects"] }),
				qc.invalidateQueries({ queryKey: ["get", "/v1/projects/{project_id}"] }),
				qc.invalidateQueries({ queryKey: ["get", "/v1/agents"] }),
				qc.invalidateQueries({ queryKey: ["get", "/v1/vault"] }),
				qc.invalidateQueries({ queryKey: ["skills"] }),
				qc.invalidateQueries({ queryKey: ["vaults"] }),
				...changedAgentIds.flatMap((agentId) => [
					qc.invalidateQueries({ queryKey: agentProjectBindingsQueryKey(agentId) }),
					qc.invalidateQueries({
						queryKey: agentDetailQueryKey(agentId),
					}),
				]),
			]);
			toast.success("Agent access updated");
			onOpenChange(false);
		},
		onError: (error) => {
			toast.error("Couldn't update Agent access", {
				description: normalizeApiError(error),
			});
		},
		onSettled: () => {
			updateAgentsLockedRef.current = false;
		},
	});
	const submitAgentChanges = () => {
		if (!hasAgentChanges || updateAgentsLockedRef.current) return;
		updateAgentsLockedRef.current = true;
		updateProjectAgents.mutate({
			addAgentIds: agentIdsToAdd,
			removeAgentIds: agentIdsToRemove,
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogTrigger render={children} />
			<DialogContent className={projectDetailClasses.agentsDialog}>
				<DialogHeader>
					<DialogTitle>{LIBRARY_COPY.manageAgents}</DialogTitle>
					<DialogDescription>{LIBRARY_COPY.chooseAgents}</DialogDescription>
				</DialogHeader>

				{isLoadingAgents ? (
					<Skeleton className={projectDetailClasses.textarea} />
				) : agentsError ? (
					<ApiErrorPanel
						error={agentsError}
						onRetry={onRetryAgents}
						title={LIBRARY_COPY.loadAgentsFailed}
					/>
				) : orderedEnvironments.length === 0 ? (
					<Alert>
						<Bot className={projectDetailClasses.icon} />
						<AlertTitle>{LIBRARY_COPY.noAgentsAvailable}</AlertTitle>
						<AlertDescription>{LIBRARY_COPY.addAgentFirst}</AlertDescription>
					</Alert>
				) : (
					<form
						className={projectDetailClasses.form}
						onSubmit={(event) => {
							event.preventDefault();
							submitAgentChanges();
						}}
					>
						<div className={projectDetailClasses.agentChoices}>
							{orderedEnvironments.map((environment) => {
								const name = agentDisplayName(environment);
								const checkboxId = `project-agent-${environment.id}`;
								const isSelected = managedAgentIds.has(environment.id);
								return (
									<label
										key={environment.id}
										htmlFor={checkboxId}
										className={projectDetailClasses.agentChoice}
									>
										<Checkbox
											id={checkboxId}
											checked={isSelected}
											disabled={updateProjectAgents.isPending}
											aria-label={`${name} access`}
											onCheckedChange={(checked) => {
												setManagedAgentIds((current) => {
													const next = new Set(current);
													if (checked === true) next.add(environment.id);
													else next.delete(environment.id);
													return next;
												});
											}}
										/>
										<AgentLabel
											machineName={environment.machine_name}
											displayName={environment.display_name}
											defaultName={environment.default_name}
											type={environment.agent_type}
											avatarUrl={environment.avatar_url}
											size="sm"
											primary="machine"
											titleAdornment={<AgentSourceBadgeForEnvironment env={environment} compact />}
											meta={[projectAgentSyncLabel(environment.last_sync_at)]}
											className={projectDetailClasses.agentIdentity}
										/>
									</label>
								);
							})}
						</div>

						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
								{LIBRARY_COPY.cancel}
							</Button>
							<Button type="submit" disabled={!hasAgentChanges || updateProjectAgents.isPending}>
								{updateProjectAgents.isPending ? (
									<Spinner />
								) : (
									<Save className={projectDetailClasses.actionIcon} />
								)}
								Save changes
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

function CreateProjectVaultDialog({
	projectId,
	contextLabel,
	onChanged,
}: {
	projectId: string;
	contextLabel: "Workspace" | "Project";
	onChanged: () => void;
}) {
	const api = useApi();
	const [vaultName, setVaultName] = useState("");
	const [createOpen, setCreateOpen] = useState(false);
	const newVaultSlug = slugFromVaultName(vaultName);
	const create = useMutation({
		mutationFn: async (nextName: string) => {
			const normalizedName = nextName.trim();
			const slug = slugFromVaultName(normalizedName);
			if (!slug) throw new Error("Use a Vault name containing letters or numbers");
			return unwrap(
				await api.POST("/v1/vault", {
					params: { query: { project_id: projectId, create_only: true } },
					body: { slug, name: normalizedName },
				}),
			);
		},
		onSuccess: () => {
			setVaultName("");
			setCreateOpen(false);
			onChanged();
			toast.success(`Vault created for this ${contextLabel}`, {
				description: "Its key values stay protected, and this Project or Workspace can use them.",
			});
		},
		onError: (error) =>
			toast.error("Couldn't create vault", { description: normalizeApiError(error) }),
	});

	return (
		<>
			<Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
				<Plus className={projectDetailClasses.actionIcon} />
				{LIBRARY_COPY.createVault}
			</Button>

			<Dialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				onOpenChangeComplete={(open) => {
					if (!open) setVaultName("");
				}}
			>
				<DialogContent className={projectDetailClasses.dialog}>
					<DialogHeader>
						<DialogTitle>{LIBRARY_COPY.createVault}</DialogTitle>
						<DialogDescription>{projectVaultCreateDescription(contextLabel)}</DialogDescription>
					</DialogHeader>
					<form
						className={projectDetailClasses.form}
						onSubmit={(event) => {
							event.preventDefault();
							if (vaultName.trim() && newVaultSlug && !create.isPending) {
								create.mutate(vaultName);
							}
						}}
					>
						<div className={projectDetailClasses.fieldStack}>
							<Label htmlFor={`project-vault-name-${projectId}`}>{PROJECT_VAULT_COPY.name}</Label>
							<Input
								id={`project-vault-name-${projectId}`}
								name="project-vault-name"
								value={vaultName}
								onChange={(event) => setVaultName(event.target.value)}
								placeholder={PROJECT_VAULT_COPY.placeholder}
								autoComplete="off"
								className={projectDetailClasses.agentIdentity}
							/>
							{vaultName.trim() && !newVaultSlug ? (
								<p className={projectDetailClasses.error}>{PROJECT_VAULT_COPY.invalidName}</p>
							) : null}
						</div>
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
								{LIBRARY_COPY.cancel}
							</Button>
							<Button
								type="submit"
								disabled={!vaultName.trim() || !newVaultSlug || create.isPending}
							>
								{create.isPending ? (
									<Spinner />
								) : (
									<Plus className={projectDetailClasses.actionIcon} />
								)}
								Create vault
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

function EmptyLine({ message }: { message: string }) {
	return <EmptyState variant="inset" description={message} />;
}

function ProjectSkillsLoadingGrid() {
	return (
		<div className={HERO_GRID_CLASS}>
			{Array.from({ length: 3 }).map((_, index) => (
				<SkillCardSkeleton key={index} />
			))}
		</div>
	);
}

function formatCountValue(value: CountValue) {
	return value === "unavailable" ? "—" : value;
}
