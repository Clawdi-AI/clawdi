"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import {
	ArrowLeft,
	ArrowRight,
	BookOpen,
	Bot,
	CheckCircle2,
	ChevronRight,
	ExternalLink,
	Eye,
	Link2,
	LogOut,
	Plus,
	Share2,
	Trash2,
} from "lucide-react";
import {
	lazy,
	type ReactElement,
	type ReactNode,
	Suspense,
	useEffect,
	useMemo,
	useState,
} from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbSegmentTitle, useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import {
	AgentLabel,
	AgentSourceBadgeForEnvironment,
	agentDisplayName,
	compareAgentEnvironments,
} from "@/components/dashboard/agent-label";
import {
	agentProjectBindingsQueryKey,
	useAgentProjectBindings,
} from "@/components/dashboard/agent-project-bindings-query";
import { orderedAgentProjectBindings } from "@/components/dashboard/agent-project-scope";
import { ConnectedWorkspaceSkillsPanel } from "@/components/dashboard/workspace-skills-panel";
import { DetailNotFound, DetailPanel } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import {
	displayProjectName,
	isCustomProject,
	isManagedProject,
	type ProjectAgentMetadata,
	ProjectIdentity,
	ProjectKindBadge,
	projectAgentFor,
	projectKindMeta,
} from "@/components/projects/project-metadata";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
import { SkillCardGrid } from "@/components/skills/skill-card";
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
import { ConfirmAction } from "@/components/ui/confirm-action";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { VaultCard, VaultCardSkeleton } from "@/components/vault/vaults-surface";
import {
	agentDeploymentRouteQuery,
	agentDeploymentSelector,
	agentProjectDetailHref,
	agentProjectResourceHref,
	agentSectionHref,
	agentSectionLabel,
	agentSectionLink,
	agentSkillDetailLink,
} from "@/lib/agent-routes";
import { ApiError, unwrap, useApi, useOpenApi } from "@/lib/api";
import { formatApiError, isApiNotFoundError } from "@/lib/api-errors";
import { fetchAllPages } from "@/lib/api-pagination";
import type { components } from "@/lib/api-schemas";
import { formatShortDate } from "@/lib/format";
import { identityFor } from "@/lib/identity";
import { AGENT_SECTION_NAVIGATION_ITEMS } from "@/lib/navigation-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import {
	libraryManagementTarget,
	projectDetailHrefForScope,
	type ResourceNavigationScope,
	type ResourceNavigationTarget,
	resourceCollectionTarget,
} from "@/lib/resource-navigation";
import { isBrowserWritableSkillProject, skillCapabilities } from "@/lib/skill-authority";
import { cn, errorMessage } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type VaultSummary = components["schemas"]["VaultResponse"];
type Env = components["schemas"]["AgentResponse"];
type AgentProjectBinding = components["schemas"]["AgentProjectBindingResponse"];

type ProjectRow = components["schemas"]["ProjectResponse"];
type Member = components["schemas"]["MemberResponse"];
type CountValue = number | "unavailable";

const AGENT_PROJECTS_SECTION_LABEL = agentSectionLabel("projects");
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
	const pathname = useLocation({ select: (location) => location.pathname });
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const searchParams = useMemo(() => new URLSearchParams(searchStr), [searchStr]);
	const projectsTarget = resourceCollectionTarget(scope, "projects");
	const managementTarget = libraryManagementTarget("projects", { projectId });
	const isAgentScope = scope.kind === "agent";
	const showSkills = focus !== "vaults";
	const showVaults = focus !== "skills";
	const [useWithAgentOpen, setUseWithAgentOpen] = useState(
		searchParams.get("useWithAgent") === "1",
	);
	const [installSkillOpen, setInstallSkillOpen] = useState(false);
	const joinedFromShare = !isAgentScope && searchParams.get("joined") === "share";

	const projects = $api.useQuery("get", "/v1/projects", {});

	const rows = projects.data ?? [];
	const project = rows.find((row) => row.id === projectId) ?? null;
	const projectName = project ? displayProjectName(project) : null;
	const projectResourceTargets =
		scope.kind === "agent"
			? {
					skills: agentProjectResourceHref(
						scope.agentId,
						projectId,
						"skills",
						agentDeploymentRouteQuery(scope.agentQuery),
					),
					vaults: agentProjectResourceHref(
						scope.agentId,
						projectId,
						"vaults",
						agentDeploymentRouteQuery(scope.agentQuery),
					),
				}
			: null;
	const projectNameById = useMemo(
		() => new Map(rows.map((row) => [row.id, displayProjectName(row)])),
		[rows],
	);
	const visibleProjectIds = useMemo(() => new Set([projectId]), [projectId]);
	const isOwner = project?.is_owner !== false;
	const canManageSkills = isBrowserWritableSkillProject(project);
	const isShareableProject = project ? isCustomProject(project) : false;
	const isManaged = project ? isManagedProject(project) : false;
	const scopedBindings = useAgentProjectBindings(scope.kind === "agent" ? scope.agentId : "", {
		enabled: scope.kind === "agent",
	});
	const orderedScopedBindings = useMemo(
		() => orderedAgentProjectBindings(scopedBindings.data ?? []),
		[scopedBindings.data],
	);
	const scopedBinding =
		orderedScopedBindings.find((binding) => binding.project_id === projectId) ?? null;
	const isWorkspace = isAgentScope && scopedBinding?.binding_type === "primary";
	const isWorkspaceContext = isWorkspace || project?.kind === "environment";
	const canManageProjectSkills = canManageSkills && !isWorkspace;
	const deploymentSelector =
		scope.kind === "agent" ? agentDeploymentSelector(scope.agentQuery) : null;
	const pageReturnTarget: ResourceNavigationTarget =
		focus && scope.kind === "agent"
			? isWorkspace
				? {
						href: agentSectionHref(scope.agentId, "overview", scope.agentQuery),
						label: "Back to Agent Overview",
					}
				: {
						href: projectDetailHrefForScope(scope, projectId),
						label: projectName ? `Back to ${projectName}` : "Back to Project",
					}
			: projectsTarget;
	const workspaceAgent = $api.useQuery(
		"get",
		"/v1/agents/{agent_id}",
		{
			params: { path: { agent_id: scope.kind === "agent" ? scope.agentId : "" } },
		},
		{
			enabled: scope.kind === "agent" && isWorkspace && showSkills && !IS_HOSTED_BUILD,
		},
	);
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
		{ enabled: !isAgentScope && !!project },
	);
	const agentsById = useMemo(
		() => new Map((environments.data ?? []).map((agent) => [agent.id, agent])),
		[environments.data],
	);
	const projectAgent = project ? projectAgentFor(project, agentsById) : null;
	const projectType = project ? projectKindMeta(project.kind) : null;

	const skills = useQuery({
		queryKey: ["skills", "project-detail", projectId],
		queryFn: async () =>
			fetchAllPages<SkillSummary>(
				async (page, pageSize) =>
					unwrap(
						await api.GET("/v1/skills", {
							params: { query: { project_id: projectId, page, page_size: pageSize } },
						}),
					),
				{ pageSize: 200, resourceName: "project skills" },
			),
		enabled: showSkills && (!isAgentScope || !!scopedBinding),
	});
	const workspaceSkillProjections = useMemo(
		() => (skills.data?.items ?? []).filter((skill) => skill.authority === "agent_sync"),
		[skills.data?.items],
	);

	const vaults = useQuery({
		queryKey: ["vaults", "project-detail", projectId],
		queryFn: async () =>
			fetchAllPages<VaultSummary>(
				async (page, pageSize) =>
					unwrap(
						await api.GET("/v1/vault", {
							params: { query: { project_id: projectId, page, page_size: pageSize } },
						}),
					),
				{ pageSize: 200, resourceName: "project vaults" },
			),
		enabled: showVaults && (!isAgentScope || !!scopedBinding),
	});

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
		enabled: !isAgentScope && !!project && isOwner && isShareableProject,
	});

	// Agents tile/section — which connected agents can use this project:
	// its home agent (default_project_id) plus every context binding.
	const boundAgents = useQuery({
		queryKey: ["project-bound-agents", projectId, (environments.data ?? []).length],
		enabled: !isAgentScope && !!project && !!environments.data,
		queryFn: async () => {
			const envs = environments.data ?? [];
			const results = await Promise.all(
				envs.map(async (env) => {
					if (env.default_project_id === projectId) return { env, home: true };
					const bindings = unwrap(
						await api.GET("/v1/agents/{agent_id}/project-bindings", {
							params: { path: { agent_id: env.id } },
						}),
					);
					return bindings.some((b: AgentProjectBinding) => b.project_id === projectId)
						? { env, home: false }
						: null;
				}),
			);
			return results.filter((r): r is { env: Env; home: boolean } => r !== null);
		},
	});

	const refresh = () => {
		qc.invalidateQueries({ queryKey: ["get", "/v1/projects"] });
		qc.invalidateQueries({ queryKey: ["skills"] });
		qc.invalidateQueries({ queryKey: ["vaults"] });
		qc.invalidateQueries({ queryKey: ["get", "/v1/vault"] });
		qc.invalidateQueries({ queryKey: ["project-bound-agents", projectId] });
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
			toast.error("Couldn't remove Skill from Project", { description: errorMessage(error) }),
	});

	const detachProjectVault = useMutation({
		mutationFn: async (vault: VaultSummary) =>
			unwrap(
				await api.DELETE("/v1/vault/{slug}", {
					params: {
						path: { slug: vault.slug },
						query: { project_id: projectId, vault_id: vault.id },
					},
				}),
			),
		onSuccess: () => {
			refresh();
			toast.success(isWorkspace ? "Vault detached from Workspace" : "Vault detached from Project");
		},
		onError: (error) =>
			toast.error(
				isWorkspace ? "Couldn't detach vault from Workspace" : "Couldn't detach vault from Project",
				{ description: errorMessage(error) },
			),
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
			toast.success("Left Shared Project", { description: "Membership removed." });
			void router.navigate({ href: projectsTarget.href });
		},
		onError: (e) => {
			toast.error("Couldn't leave shared project", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	useSetBreadcrumbSegmentTitle(
		scope.kind === "agent" ? agentProjectDetailHref(scope.agentId, projectId) : null,
		isWorkspace ? "Workspace" : projectName,
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

	if (projects.isLoading || (isAgentScope && scopedBindings.isLoading)) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<Skeleton className="h-8 w-24" />
				<div className="flex items-start gap-3">
					<Skeleton className="size-11 rounded-xl" />
					<div className="min-w-0 flex-1 space-y-2">
						<Skeleton className="h-6 w-56 max-w-full" />
						<Skeleton className="h-4 w-96 max-w-full" />
						<Skeleton className="h-3 w-40" />
					</div>
				</div>
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
					{Array.from({ length: 4 }).map((_, i) => (
						<Skeleton key={i} className="h-24 w-full rounded-xl" />
					))}
				</div>
				<Skeleton className="h-40 w-full rounded-lg" />
			</div>
		);
	}

	const blockingScopeError = isAgentScope
		? shouldBlockQueryError(scopedBindings.error, scopedBindings.data)
			? scopedBindings.error
			: null
		: null;
	const blockingProjectError = shouldBlockQueryError(projects.error, projects.data)
		? projects.error
		: null;

	if (blockingProjectError || blockingScopeError) {
		const blockingError = blockingProjectError ?? blockingScopeError;
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<ProjectReturnLink target={projectsTarget} />
				{isApiNotFoundError(blockingError) ? (
					<DetailNotFound
						title="Project not found"
						message="This Project may have been removed, or your account no longer has access."
					/>
				) : (
					<ApiErrorPanel
						error={blockingError}
						onRetry={() => {
							if (blockingProjectError) void projects.refetch();
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
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<ProjectReturnLink target={projectsTarget} />
				<DetailNotFound
					title="Project not found"
					message="This Project may have been removed, or your account no longer has access."
				/>
			</div>
		);
	}

	if (isAgentScope && !scopedBinding) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<ProjectReturnLink target={projectsTarget} />
				<DetailNotFound
					title="Project not available to this Agent"
					message="The Project may have been removed from this Agent. It remains available in the resource library if your account still has access."
				/>
				<Button
					render={<Link to={managementTarget.href} />}
					nativeButton={false}
					variant="ghost"
					size="sm"
					className="w-fit text-muted-foreground"
				>
					<ExternalLink className="size-3.5" />
					{managementTarget.label}
				</Button>
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
	const blockingEnvironmentsError = shouldBlockQueryError(environments.error, environments.data)
		? environments.error
		: null;
	const blockingBoundAgentsError = shouldBlockQueryError(boundAgents.error, boundAgents.data)
		? boundAgents.error
		: null;
	const skillCount: CountValue | undefined =
		isWorkspace || project.kind === "environment"
			? undefined
			: blockingSkillsError
				? "unavailable"
				: skills.data?.items.length;
	const vaultCount: CountValue | undefined = blockingVaultsError
		? "unavailable"
		: vaults.data?.items.length;
	const peopleCount: CountValue | undefined = blockingMembersError
		? "unavailable"
		: members.data
			? members.data.length + 1
			: undefined; // +1 = owner
	const agentCount: CountValue | undefined =
		blockingEnvironmentsError || blockingBoundAgentsError
			? "unavailable"
			: boundAgents.data?.length;

	const addToAgentDialog = (trigger: ReactElement) => (
		<UseProjectWithAgentDialog
			project={project}
			environments={environments.data ?? []}
			isLoadingEnvironments={environments.isLoading}
			open={useWithAgentOpen}
			onOpenChange={handleUseWithAgentOpenChange}
		>
			{trigger}
		</UseProjectWithAgentDialog>
	);
	const projectIdentity = identityFor(displayProjectName(project));
	const workspaceIdentity = identityFor("Workspace");
	const focusedResourceIdentity = focus ? AGENT_SECTION_NAVIGATION_ITEMS[focus] : null;
	const FocusedResourceIcon = focusedResourceIdentity?.icon ?? null;

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6")}>
			<ProjectReturnLink target={pageReturnTarget} />

			<PageHeader
				title={
					focusedResourceIdentity?.label ??
					(isWorkspace ? "Workspace" : displayProjectName(project))
				}
				titleAdornment={focus || isWorkspace ? undefined : <ProjectKindBadge kind={project.kind} />}
				icon={
					focusedResourceIdentity && FocusedResourceIcon ? (
						<IconChip tint={focusedResourceIdentity.tint}>
							<FocusedResourceIcon />
						</IconChip>
					) : (
						<IconChip
							tint={isWorkspace ? workspaceIdentity.colorClasses : projectIdentity.colorClasses}
							className="text-xl"
						>
							{isWorkspace ? workspaceIdentity.emoji : projectIdentity.emoji}
						</IconChip>
					)
				}
				description={
					isAgentScope
						? isWorkspace
							? focus === "skills"
								? "Skills installed in this Agent's Workspace. Skills synced from the Agent are read-only."
								: focus === "vaults"
									? "Vaults attached to this Agent's Workspace."
									: "Skills and Vaults available directly to this Agent."
							: focus === "skills"
								? "Skills stored and managed in this Project. Linking it does not install them on the Agent."
								: focus === "vaults"
									? "Vaults available to this Agent through this Project."
									: "This Agent can use the Project's attached Vaults. Its Skills remain in the Project."
						: projectDetailDescription(project, isOwner, projectType?.label ?? "Project")
				}
				status={
					isWorkspace ? undefined : (
						<span
							className={
								focus ? "text-xs text-muted-foreground" : "font-mono text-xs text-muted-foreground"
							}
						>
							{focus ? `Project: ${displayProjectName(project)}` : project.slug}
						</span>
					)
				}
				actions={
					!isAgentScope && isShareableProject ? (
						<>
							{!joinedFromShare
								? addToAgentDialog(
										<Button size="sm">
											<Bot className="mr-1.5 size-3.5" />
											Link project
										</Button>,
									)
								: null}
							{isOwner && isShareableProject ? (
								<ShareProjectDialog
									projectId={project.id}
									projectName={displayProjectName(project)}
									projectKind={project.kind}
								>
									<Button variant="outline" size="sm">
										<Share2 className="mr-1.5 size-3.5" />
										Share
									</Button>
								</ShareProjectDialog>
							) : null}
						</>
					) : undefined
				}
			/>

			{joinedFromShare && isShareableProject ? (
				<Alert>
					<CheckCircle2 className="size-4" />
					<AlertTitle>Project added</AlertTitle>
					<AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<span>
							Linking makes attached Vaults available to an Agent. Project Skills remain separate
							until you install them on that Agent.
						</span>
						<Button type="button" size="sm" onClick={() => setUseWithAgentOpen(true)}>
							<Bot className="mr-1.5 size-3.5" />
							Link project
						</Button>
					</AlertDescription>
				</Alert>
			) : null}

			{/* Stat tiles — anchors into the sections below. */}
			{!isAgentScope ? (
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
					{project.kind !== "environment" ? (
						<StatTile label="Skills" value={skillCount} href="#skills" />
					) : null}
					<StatTile label="Vaults" value={vaultCount} href="#vaults" />
					{isOwner && isShareableProject ? (
						<StatTile label="People" value={peopleCount} href="#people" />
					) : null}
					<StatTile label="Agents" value={agentCount} href="#agents" />
				</div>
			) : null}

			<HubSection
				visible={showSkills}
				showHeading={!focus}
				id="skills"
				title="Skills"
				count={skillCount}
				description={
					isAgentScope
						? isWorkspace
							? "Skills installed in this Agent's Workspace."
							: "Skills are stored and managed in this Project; linking does not install them."
						: project.kind === "environment"
							? "Skills synced from this Agent. Manage them on the Agent."
							: isOwner
								? "Reusable instructions stored in this Project."
								: "Readable instructions shared by the owner."
				}
				action={
					(!focus && projectResourceTargets) || canManageProjectSkills ? (
						<>
							{!focus && projectResourceTargets ? (
								<ProjectResourceViewAllLink
									href={projectResourceTargets.skills}
									resource="Skills"
								/>
							) : null}
							{canManageProjectSkills ? (
								<Button variant="outline" size="sm" onClick={() => setInstallSkillOpen(true)}>
									<Plus className="size-3.5" />
									Install skill
								</Button>
							) : null}
						</>
					) : undefined
				}
			>
				{canManageProjectSkills ? (
					<InstallSkillInProjectDialog
						projectId={project.id}
						open={installSkillOpen}
						onOpenChange={setInstallSkillOpen}
						onChanged={refresh}
					/>
				) : null}
				{blockingWorkspaceAgentError ? (
					<ApiErrorPanel
						error={blockingWorkspaceAgentError}
						onRetry={() => {
							void workspaceAgent.refetch();
						}}
						title="Couldn't load the Agent identity"
					/>
				) : isWorkspace && scope.kind === "agent" ? (
					IS_HOSTED_BUILD && HostedWorkspaceSkillsPanel ? (
						<Suspense fallback={<Skeleton className="h-40 w-full rounded-lg" />}>
							<HostedWorkspaceSkillsPanel
								agentId={scope.agentId}
								projectId={project.id}
								routeSearch={scope.agentQuery}
								deploymentSelector={deploymentSelector}
								projections={workspaceSkillProjections}
								projectionsLoading={skills.isLoading}
								projectionError={blockingSkillsError}
								onRetryProjections={() => {
									void skills.refetch();
								}}
							/>
						</Suspense>
					) : workspaceAgent.data ? (
						<ConnectedWorkspaceSkillsPanel
							agentId={scope.agentId}
							projectId={project.id}
							routeSearch={scope.agentQuery}
							agentType={workspaceAgent.data.agent_type}
							projections={workspaceSkillProjections}
							isLoading={skills.isLoading}
							projectionError={blockingSkillsError}
							onRetryProjections={() => {
								void skills.refetch();
							}}
						/>
					) : (
						<Skeleton className="h-40 w-full rounded-lg" />
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
						emptyMessage="No skills are visible in this Project yet."
						emptyVariant="inset"
						capabilitiesFor={(skill) => skillCapabilities(skill, project)}
						onUninstall={
							canManageProjectSkills
								? (skillKey, skillProjectId) =>
										removeProjectSkill.mutate({ skillKey, skillProjectId })
								: undefined
						}
						uninstallPending={removeProjectSkill.isPending}
						skillLink={
							scope.kind === "agent"
								? (skill) =>
										agentSkillDetailLink(
											scope.agentId,
											skill.skill_key,
											project.id,
											scope.agentQuery,
										)
								: undefined
						}
					/>
				)}
			</HubSection>

			<HubSection
				visible={showVaults}
				showHeading={!focus}
				id="vaults"
				title="Vaults"
				count={vaultCount}
				description={
					isAgentScope
						? isWorkspace
							? "Vaults attached to this Agent's Workspace."
							: "Vaults available to this Agent through this Project."
						: isOwner
							? "API keys and secrets this Project can use."
							: "Read-only vaults shared through this Project."
				}
				action={
					(!focus && projectResourceTargets) || isOwner ? (
						<>
							{!focus && projectResourceTargets ? (
								<ProjectResourceViewAllLink
									href={projectResourceTargets.vaults}
									resource="Vaults"
								/>
							) : null}
							{isOwner ? (
								<ProjectVaultActions
									projectId={project.id}
									attachedVaultIds={new Set((vaults.data?.items ?? []).map((vault) => vault.id))}
									contextLabel={isWorkspace ? "Workspace" : "Project"}
									onChanged={refresh}
								/>
							) : null}
						</>
					) : undefined
				}
			>
				{vaults.isLoading ? (
					<div className={HERO_GRID_CLASS}>
						{Array.from({ length: 3 }).map((_, index) => (
							<VaultCardSkeleton key={index} />
						))}
					</div>
				) : blockingVaultsError ? (
					<ApiErrorPanel
						error={blockingVaultsError}
						onRetry={() => {
							void vaults.refetch();
						}}
						title={
							isWorkspaceContext ? "Couldn't load Workspace Vaults" : "Couldn't load Project vaults"
						}
					/>
				) : vaults.data?.items.length ? (
					<div className={HERO_GRID_CLASS}>
						{vaults.data.items.map((vault) => (
							<VaultCard
								key={vault.id}
								vault={vault}
								projectNameById={projectNameById}
								projectNamesUnavailable={false}
								visibleProjectIds={visibleProjectIds}
								navigationScope={scope}
								shared={vault.is_owner === false}
								actions={
									vault.is_owner !== false ? (
										<ConfirmAction
											title={`Detach ${vault.name} from ${isWorkspace ? "Workspace" : "Project"}?`}
											description={
												<p>The Vault remains in your account and attached to any other Projects.</p>
											}
											confirmLabel="Detach vault"
											destructive
											onConfirm={() => detachProjectVault.mutateAsync(vault)}
										>
											<Button
												variant="ghost"
												size="icon-sm"
												disabled={detachProjectVault.isPending}
												className="text-muted-foreground hover:text-destructive"
												aria-label={`Detach ${vault.name} from ${isWorkspace ? "Workspace" : "Project"}`}
											>
												<Trash2 className="size-3.5" />
											</Button>
										</ConfirmAction>
									) : undefined
								}
							/>
						))}
					</div>
				) : (
					<EmptyLine
						message={
							isWorkspaceContext
								? "No Vaults are attached to this Workspace yet."
								: "No Vaults are attached to this Project yet."
						}
					/>
				)}
			</HubSection>

			{!isAgentScope && isOwner && isShareableProject ? (
				<HubSection
					id="people"
					title="People"
					count={peopleCount}
					description="Members see skill and key names; their agents resolve key values through the CLI."
					action={
						<ShareProjectDialog
							projectId={project.id}
							projectName={displayProjectName(project)}
							projectKind={project.kind}
						>
							<Button variant="outline" size="sm">
								<Share2 className="mr-1.5 size-3.5" />
								Manage sharing
							</Button>
						</ShareProjectDialog>
					}
				>
					{members.isLoading ? (
						<Skeleton className="h-16 w-full" />
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
						<div className="divide-y overflow-hidden rounded-lg border bg-card">
							{(members.data ?? []).map((member) => (
								<div
									key={member.user_id}
									className="flex items-center justify-between gap-3 px-4 py-3"
								>
									<span className="truncate text-sm">
										{member.user_email ?? member.user_display ?? member.user_id}
									</span>
									<Badge variant="secondary">{member.role}</Badge>
								</div>
							))}
						</div>
					)}
				</HubSection>
			) : null}

			{!isAgentScope && !isOwner ? (
				<HubSection
					id="people"
					title="Your access"
					description="You can view this Project's Skills and Vault key names. Link the Project to let an Agent use its attached Vaults; install Skills separately."
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

			{!isAgentScope ? (
				<HubSection
					id="agents"
					title="Agents"
					count={agentCount}
					description={
						project.kind === "environment"
							? "Agent that owns this Workspace."
							: project.kind === "personal"
								? "This Global Project belongs to your account and is not linked to individual Agents."
								: "Agents that can use this Project's attached Vaults."
					}
				>
					{boundAgents.isLoading || environments.isLoading ? (
						<Skeleton className="h-16 w-full" />
					) : blockingEnvironmentsError ? (
						<ApiErrorPanel
							error={blockingEnvironmentsError}
							onRetry={() => {
								void environments.refetch();
							}}
							title="Couldn't load agents"
						/>
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
										? "Global Project belongs to your account and has no Agent links."
										: "No Agents are linked yet. Linking makes attached Vaults available; Skills are installed separately."
							}
						/>
					) : (
						<div className="divide-y overflow-hidden rounded-lg border bg-card">
							{(boundAgents.data ?? []).map(({ env, home }) => (
								<div key={env.id} className="group relative flex items-center gap-3 px-4 py-3">
									<AgentLabel
										machineName={env.machine_name}
										displayName={env.display_name}
										defaultName={env.default_name}
										type={env.agent_type}
										avatarUrl={env.avatar_url}
										size="sm"
										titleAdornment={<AgentSourceBadgeForEnvironment env={env} compact />}
										className="min-w-0 flex-1"
									/>
									{home ? (
										<Badge variant="secondary" className="shrink-0">
											Workspace
										</Badge>
									) : (
										<Badge variant="outline" className="shrink-0">
											Linked
										</Badge>
									)}
									<Link
										{...agentSectionLink(env.id, "projects")}
										className="absolute inset-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									>
										<span className="sr-only">Open agent {displayAgentName(env)}</span>
									</Link>
								</div>
							))}
						</div>
					)}
				</HubSection>
			) : null}

			{!isAgentScope && isOwner && isManaged ? (
				<ManagedProjectPanel project={project} agent={projectAgent} returnTarget={projectsTarget} />
			) : null}
		</div>
	);
}

const STAT_TILE_TINTS: Record<string, string> = {
	Skills: "bg-identity-2-bg/50",
	Vaults: "bg-identity-4-bg/50",
	People: "bg-identity-6-bg/50",
	Agents: "bg-identity-5-bg/50",
};

function StatTile({ label, value, href }: { label: string; value?: CountValue; href: string }) {
	return (
		<a
			href={href}
			className={cn(
				"group rounded-xl border border-transparent p-4 transition-all duration-150 hover:-translate-y-px hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring focus:outline-none",
				STAT_TILE_TINTS[label] ?? "bg-card",
			)}
		>
			<div className="text-2xl font-semibold tabular-nums">
				{value === undefined ? <Skeleton className="h-8 w-8" /> : formatCountValue(value)}
			</div>
			<div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
				{label}
				<ChevronRight className="size-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
			</div>
		</a>
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
		<section id={id} className="scroll-mt-20 space-y-3">
			{showHeading ? (
				<div className="flex items-end justify-between gap-2">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h2 className="text-sm font-semibold">{title}</h2>
							{count !== undefined ? (
								<Badge variant="secondary" className="tabular-nums">
									{formatCountValue(count)}
								</Badge>
							) : null}
						</div>
						<p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
					</div>
					{action ? (
						<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{action}</div>
					) : null}
				</div>
			) : action ? (
				<div className="flex flex-wrap items-center justify-end gap-2">{action}</div>
			) : null}
			{children}
		</section>
	);
}

function ProjectReturnLink({ target }: { target: ResourceNavigationTarget }) {
	return (
		<Button
			render={<Link to={target.href} />}
			nativeButton={false}
			variant="ghost"
			size="sm"
			className="w-fit"
		>
			<ArrowLeft className="mr-1.5 size-4" />
			{target.label}
		</Button>
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
			className="text-muted-foreground"
		>
			View all
			<ArrowRight />
		</Button>
	);
}

function projectDetailDescription(project: ProjectRow, isOwner: boolean, typeLabel: string) {
	const access = isOwner ? "you own" : "shared with you";
	if (project.kind === "workspace") {
		return isOwner
			? `${typeLabel} you own. Install Skills and attach Vaults here, share the Project, then link it to Agents when needed. Linking does not install its Skills.`
			: `${typeLabel} shared with you. Its Skills stay here; link the Project to let an Agent use its attached Vaults.`;
	}
	if (project.kind === "environment") {
		return `${typeLabel} ${access}. This Workspace belongs to one connected Agent and cannot be shared.`;
	}
	if (project.kind === "personal") {
		return `${typeLabel} ${access}. This is your account default for resources that are not tied to one workflow or agent.`;
	}
	return `${typeLabel} ${access}. Slug: ${project.slug}`;
}

function ManagedProjectPanel({
	project,
	agent,
	returnTarget,
}: {
	project: ProjectRow;
	agent?: ProjectAgentMetadata | null;
	returnTarget: { href: string; label: string };
}) {
	const description =
		project.kind === "environment"
			? "This Workspace is managed by the connected Agent and is not shareable. Create a Project when you need collaboration or reusable resources."
			: "This Global Project is your account default and is not shareable. Create a Project when you need collaboration or reusable resources.";
	return (
		<DetailPanel className="space-y-4">
			<div className="space-y-1">
				<div className="flex items-center gap-2">
					<BookOpen className="size-4 text-muted-foreground" />
					<h2 className="text-sm font-semibold">Managed Project</h2>
				</div>
				<p className="text-xs text-muted-foreground">{description}</p>
			</div>
			<div className="rounded-md border bg-background/60 p-3">
				<ProjectIdentity project={project} agent={agent} showKind={false} />
			</div>
			<Button
				render={<Link to={returnTarget.href} />}
				nativeButton={false}
				variant="outline"
				size="sm"
				className="w-full"
			>
				Back to {returnTarget.label}
			</Button>
		</DetailPanel>
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
		<DetailPanel className="space-y-4">
			<div className="space-y-1">
				<div className="flex items-center gap-2">
					<Eye className="size-4 text-muted-foreground" />
					<h2 className="text-sm font-semibold">You Have Viewer Access</h2>
				</div>
				<p className="text-xs text-muted-foreground">
					You can view this Project and link it to an Agent. The Agent can then use its attached
					Vaults; install Project Skills separately.
				</p>
			</div>
			<div className="rounded-md border bg-background/60 p-3">
				<div className="flex items-center justify-between gap-3">
					<ProjectIdentity project={project} agent={agent} showKind={false} className="flex-1" />
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
							className="w-full text-muted-foreground hover:text-destructive"
						/>
					}
				>
					<LogOut className="mr-1.5 size-3.5" />
					{isLeaving ? "Leaving…" : "Leave Project"}
				</AlertDialogTrigger>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Leave {displayProjectName(project)}?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes your read-only membership. Your Agents will lose access to Vaults through
							this Project; Project Skills remain separate from Agent installs.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={onLeave}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							Leave Project
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</DetailPanel>
	);
}

function UseProjectWithAgentDialog({
	project,
	environments,
	isLoadingEnvironments,
	open,
	onOpenChange,
	children,
}: {
	project: ProjectRow;
	environments: Env[];
	isLoadingEnvironments: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactElement;
}) {
	const api = useApi();
	const qc = useQueryClient();
	const router = useRouter();
	const projectName = displayProjectName(project);
	const [selectedAgentId, setSelectedAgentId] = useState("");
	const orderedEnvironments = useMemo(
		() => [...environments].sort(compareEnvironmentsForUse),
		[environments],
	);
	const agentItems = orderedEnvironments.map((env) => ({
		value: env.id,
		label: displayAgentName(env),
	}));
	const selectedEnv = orderedEnvironments.find((env) => env.id === selectedAgentId) ?? null;
	const projectIsHome = selectedEnv?.default_project_id === project.id;
	const selectedBindings = useAgentProjectBindings(selectedAgentId, { enabled: open });
	const blockingSelectedBindingsError = shouldBlockQueryError(
		selectedBindings.error,
		selectedBindings.data,
	);
	const existingBinding =
		selectedBindings.data?.find((binding) => binding.project_id === project.id) ?? null;
	const projectIsAlreadyAvailable = projectIsHome || !!existingBinding;

	useEffect(() => {
		if (!open) return;
		if (selectedAgentId && orderedEnvironments.some((env) => env.id === selectedAgentId)) return;
		setSelectedAgentId(orderedEnvironments[0]?.id ?? "");
	}, [open, orderedEnvironments, selectedAgentId]);

	const addProjectToAgent = useMutation({
		mutationFn: async () => {
			if (!selectedAgentId) throw new Error("Choose an agent first");
			return unwrap(
				await api.POST("/v1/agents/{agent_id}/project-bindings/context", {
					params: { path: { agent_id: selectedAgentId } },
					body: { project_id: project.id },
				}),
			);
		},
		onSuccess: () => {
			const agentName = selectedEnv ? displayAgentName(selectedEnv) : "the agent";
			qc.invalidateQueries({ queryKey: agentProjectBindingsQueryKey(selectedAgentId) });
			qc.invalidateQueries({ queryKey: ["get", "/v1/vault"] });
			toast.success("Project linked", {
				description: `${agentName} can now use ${projectName}'s attached Vaults. Project Skills remain separate until installed on the Agent.`,
				action: {
					label: "Open Agent",
					onClick: () =>
						void router.navigate({ href: agentSectionHref(selectedAgentId, "projects") }),
				},
			});
			onOpenChange(false);
		},
		onError: (e) => {
			toast.error("Couldn't link project", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogTrigger render={children} />
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Link project to Agent</DialogTitle>
					<DialogDescription>
						Link {projectName} to make its attached Vaults available to the Agent. Project Skills
						remain separate until you install them on the Agent.
					</DialogDescription>
				</DialogHeader>

				{isLoadingEnvironments ? (
					<Skeleton className="h-24 w-full" />
				) : orderedEnvironments.length === 0 ? (
					<Alert>
						<Bot className="size-4" />
						<AlertTitle>No agents connected</AlertTitle>
						<AlertDescription>
							Add an Agent from Overview first, then link this Project here or from the Agent&apos;s{" "}
							{AGENT_PROJECTS_SECTION_LABEL} section.
						</AlertDescription>
					</Alert>
				) : (
					<div className="space-y-4">
						<div className="space-y-2">
							<div className="text-sm font-medium">Agent</div>
							<Select
								items={agentItems}
								value={selectedAgentId}
								onValueChange={(value) => {
									if (value !== null) setSelectedAgentId(value);
								}}
							>
								<SelectTrigger
									aria-label="Agent to link this Project to"
									className="h-auto min-h-9 w-full justify-between py-2"
								>
									{selectedEnv ? (
										<AgentLabel
											machineName={selectedEnv.machine_name}
											displayName={selectedEnv.display_name}
											defaultName={selectedEnv.default_name}
											type={selectedEnv.agent_type}
											avatarUrl={selectedEnv.avatar_url}
											size="sm"
											titleAdornment={<AgentSourceBadgeForEnvironment env={selectedEnv} compact />}
											className="min-w-0 flex-1"
										/>
									) : (
										<SelectValue placeholder="Choose an agent…" />
									)}
								</SelectTrigger>
								<SelectContent align="start" alignItemWithTrigger={false}>
									{orderedEnvironments.map((env) => (
										<SelectItem
											key={env.id}
											value={env.id}
											label={displayAgentName(env)}
											className="py-2"
										>
											<AgentLabel
												machineName={env.machine_name}
												displayName={env.display_name}
												defaultName={env.default_name}
												type={env.agent_type}
												avatarUrl={env.avatar_url}
												size="sm"
												primary="machine"
												titleAdornment={<AgentSourceBadgeForEnvironment env={env} compact />}
												meta={[
													env.last_sync_at
														? `synced ${formatShortDate(env.last_sync_at, { includeYear: false })}`
														: "not synced yet",
												]}
											/>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="rounded-md border bg-muted/30 p-3 text-sm">
							{projectIsHome ? (
								<div className="flex items-start gap-2">
									<CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
									<div>
										<div className="font-medium">This Project Is the Agent&apos;s Workspace</div>
										<p className="mt-1 text-xs text-muted-foreground">
											No context link is needed. Workspace Skills and Vaults are managed from the
											Agent&apos;s Workspace section.
										</p>
									</div>
								</div>
							) : existingBinding ? (
								<div className="flex items-start gap-2">
									<CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
									<div>
										<div className="font-medium">Already Linked</div>
										<p className="mt-1 text-xs text-muted-foreground">
											Open the Agent&apos;s {AGENT_PROJECTS_SECTION_LABEL} section to review its
											Project order or unlink it.
										</p>
									</div>
								</div>
							) : (
								<div className="flex items-start gap-2">
									<Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
									<div>
										<div className="font-medium">Link as Project</div>
										<p className="mt-1 text-xs text-muted-foreground">
											The selected Agent can use attached Vaults. Project Skills remain separate
											until installed on the Agent.
										</p>
									</div>
								</div>
							)}
						</div>

						{blockingSelectedBindingsError ? (
							<ApiErrorPanel
								error={selectedBindings.error}
								onRetry={() => {
									void selectedBindings.refetch();
								}}
								title="Couldn't check this agent's Project list"
							/>
						) : null}

						<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
							<Button variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							{projectIsAlreadyAvailable && selectedEnv ? (
								<Button
									render={
										<Link
											to="/agents/$id/$section"
											params={{ id: selectedEnv.id, section: "project-access" }}
										/>
									}
									nativeButton={false}
								>
									Open Projects
								</Button>
							) : (
								<Button
									onClick={() => addProjectToAgent.mutate()}
									disabled={
										!selectedAgentId ||
										addProjectToAgent.isPending ||
										selectedBindings.isLoading ||
										blockingSelectedBindingsError ||
										projectIsAlreadyAvailable
									}
								>
									{addProjectToAgent.isPending ? <Spinner /> : <Plus className="mr-1.5 size-3.5" />}
									{addProjectToAgent.isPending ? "Linking…" : "Link project"}
								</Button>
							)}
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

function InstallSkillInProjectDialog({
	projectId,
	open,
	onOpenChange,
	onChanged,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onChanged: () => void;
}) {
	const api = useApi();
	const [repoInput, setRepoInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const install = useMutation({
		mutationFn: async ({ repo, path }: { repo: string; path?: string }) =>
			unwrap(
				await api.POST("/v1/projects/{project_id}/skills/install", {
					params: { path: { project_id: projectId } },
					body: { repo, path },
				}),
			),
		onSuccess: () => {
			setRepoInput("");
			setError(null);
			onOpenChange(false);
			onChanged();
			toast.success("Skill installed", { description: "Saved in this Project." });
		},
		onError: (e) => {
			setError(errorMessage(e));
		},
	});

	const submit = () => {
		setError(null);
		const trimmed = repoInput.trim();
		if (!trimmed) return;
		const clean = trimmed.replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
		const parts = clean.split("/").filter(Boolean);
		if (parts.length < 2) {
			setError("Enter as `owner/repo` or `owner/repo/path-to-skill`.");
			return;
		}
		install.mutate({
			repo: `${parts[0]}/${parts[1]}`,
			path: parts.length > 2 ? parts.slice(2).join("/") : undefined,
		});
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (install.isPending) return;
				onOpenChange(next);
			}}
			onOpenChangeComplete={(next) => {
				if (!next) {
					setRepoInput("");
					setError(null);
				}
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Install skill</DialogTitle>
					<DialogDescription>Install a GitHub Skill into this Project.</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					<Label htmlFor={`project-skill-repo-${projectId}`}>GitHub skill repository</Label>
					<Input
						id={`project-skill-repo-${projectId}`}
						name="project-skill-repo"
						value={repoInput}
						onChange={(e) => {
							setRepoInput(e.target.value);
							setError(null);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !install.isPending) submit();
						}}
						placeholder="owner/repo or owner/repo/path…"
						autoComplete="off"
						spellCheck={false}
						aria-invalid={!!error || undefined}
						className="min-w-0 flex-1"
					/>
					<p className="text-xs text-muted-foreground">
						Use owner/repo or owner/repo/path-to-skill.
					</p>
					{error ? <p className="text-xs text-destructive">{error}</p> : null}
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={install.isPending}
					>
						Cancel
					</Button>
					<Button onClick={submit} disabled={!repoInput.trim() || install.isPending}>
						{install.isPending ? <Spinner /> : <Plus className="size-3.5" />}
						Install skill
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ProjectVaultActions({
	projectId,
	attachedVaultIds,
	contextLabel,
	onChanged,
}: {
	projectId: string;
	attachedVaultIds: ReadonlySet<string>;
	contextLabel: "Workspace" | "Project";
	onChanged: () => void;
}) {
	const api = useApi();
	const [slug, setSlug] = useState("");
	const [selectedVaultId, setSelectedVaultId] = useState("");
	const [attachOpen, setAttachOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const accountVaults = useQuery({
		queryKey: ["vaults", "project-attachment-options", projectId],
		enabled: attachOpen,
		queryFn: async () =>
			fetchAllPages<VaultSummary>(
				async (page, pageSize) =>
					unwrap(
						await api.GET("/v1/vault", {
							params: { query: { page, page_size: pageSize } },
						}),
					),
				{ pageSize: 200, resourceName: "account Vaults" },
			),
	});
	const attachableVaults = (accountVaults.data?.items ?? []).filter(
		(vault) => vault.is_owner !== false && !attachedVaultIds.has(vault.id),
	);
	const attachableItems = attachableVaults.map((vault) => ({
		value: vault.id,
		label: vault.name,
	}));
	const blockingAccountVaultsError = shouldBlockQueryError(accountVaults.error, accountVaults.data)
		? accountVaults.error
		: null;
	const attach = useMutation({
		mutationFn: async (vaultId: string) => {
			const vault = attachableVaults.find((candidate) => candidate.id === vaultId);
			if (!vault) throw new Error("Choose an available Vault");
			return unwrap(
				await api.POST("/v1/vault", {
					params: { query: { project_id: projectId } },
					body: { slug: vault.slug, name: vault.name },
				}),
			);
		},
		onSuccess: () => {
			setSelectedVaultId("");
			setAttachOpen(false);
			onChanged();
			toast.success(`Vault attached to ${contextLabel}`);
		},
		onError: (error) =>
			toast.error(`Couldn't attach vault to ${contextLabel}`, {
				description: errorMessage(error),
			}),
	});
	const create = useMutation({
		mutationFn: async (nextSlug: string) =>
			unwrap(
				await api.POST("/v1/vault", {
					params: { query: { project_id: projectId, create_only: true } },
					body: { slug: nextSlug, name: nextSlug },
				}),
			),
		onSuccess: () => {
			setSlug("");
			setCreateOpen(false);
			onChanged();
			toast.success("Vault created", { description: `Attached to this ${contextLabel}.` });
		},
		onError: (e) => toast.error("Couldn't create vault", { description: errorMessage(e) }),
	});

	return (
		<>
			<div className="flex flex-wrap justify-end gap-2">
				<Button size="sm" onClick={() => setCreateOpen(true)}>
					<Plus className="size-3.5" />
					Create vault
				</Button>
				<Button size="sm" variant="outline" onClick={() => setAttachOpen(true)}>
					<Link2 className="size-3.5" />
					Attach vault
				</Button>
			</div>

			<Dialog
				open={attachOpen}
				onOpenChange={setAttachOpen}
				onOpenChangeComplete={(open) => {
					if (!open) setSelectedVaultId("");
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Attach vault</DialogTitle>
						<DialogDescription>
							Choose an account-owned Vault to attach to this {contextLabel}. The Vault remains
							available in your account.
						</DialogDescription>
					</DialogHeader>
					{accountVaults.isLoading ? (
						<Skeleton className="h-9 w-full" />
					) : blockingAccountVaultsError ? (
						<div className="space-y-4">
							<ApiErrorPanel
								error={blockingAccountVaultsError}
								onRetry={() => {
									void accountVaults.refetch();
								}}
								title="Couldn't load account Vaults"
							/>
							<DialogFooter>
								<Button type="button" variant="ghost" onClick={() => setAttachOpen(false)}>
									Cancel
								</Button>
							</DialogFooter>
						</div>
					) : attachableVaults.length === 0 ? (
						<div className="space-y-4">
							<p className="text-sm text-muted-foreground">
								All account-owned Vaults are already attached to this {contextLabel}.
							</p>
							<DialogFooter>
								<Button type="button" variant="ghost" onClick={() => setAttachOpen(false)}>
									Cancel
								</Button>
							</DialogFooter>
						</div>
					) : (
						<form
							className="space-y-4"
							onSubmit={(event) => {
								event.preventDefault();
								if (selectedVaultId && !attach.isPending) attach.mutate(selectedVaultId);
							}}
						>
							<Label htmlFor={`project-vault-attachment-${projectId}`}>Existing Vault</Label>
							<Select
								items={attachableItems}
								value={selectedVaultId}
								onValueChange={(value) => {
									if (value !== null) setSelectedVaultId(value);
								}}
							>
								<SelectTrigger
									id={`project-vault-attachment-${projectId}`}
									className="min-w-0 flex-1"
								>
									<SelectValue placeholder="Choose a Vault…" />
								</SelectTrigger>
								<SelectContent>
									{attachableVaults.map((vault) => (
										<SelectItem key={vault.id} value={vault.id}>
											{vault.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<DialogFooter>
								<Button type="button" variant="ghost" onClick={() => setAttachOpen(false)}>
									Cancel
								</Button>
								<Button type="submit" disabled={!selectedVaultId || attach.isPending}>
									{attach.isPending ? <Spinner /> : <Link2 className="size-3.5" />}
									Attach vault
								</Button>
							</DialogFooter>
						</form>
					)}
				</DialogContent>
			</Dialog>

			<Dialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				onOpenChangeComplete={(open) => {
					if (!open) setSlug("");
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Create vault</DialogTitle>
						<DialogDescription>
							Create an account-owned Vault and attach it to this {contextLabel}.
						</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (slug && !create.isPending) create.mutate(slug);
						}}
					>
						<div className="grid gap-2">
							<Label htmlFor={`project-vault-slug-${projectId}`}>Vault name</Label>
							<Input
								id={`project-vault-slug-${projectId}`}
								name="project-vault-slug"
								value={slug}
								onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
								placeholder="github…"
								autoComplete="off"
								spellCheck={false}
								className="min-w-0 flex-1"
							/>
							<p className="text-xs text-muted-foreground">
								Use lowercase letters, numbers, and hyphens. Add keys from the Vault library later.
							</p>
						</div>
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!slug || create.isPending}>
								{create.isPending ? <Spinner /> : <Plus className="size-3.5" />}
								Create vault
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

function compareEnvironmentsForUse(a: Env, b: Env) {
	return compareAgentEnvironments(a, b);
}

function displayAgentName(env: Env) {
	return agentDisplayName(env);
}

function EmptyLine({ message }: { message: string }) {
	return <EmptyState variant="inset" description={message} />;
}

function formatCountValue(value: CountValue) {
	return value === "unavailable" ? "—" : value;
}
