"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import {
	ArrowRight,
	Bot,
	CheckCircle2,
	ChevronRight,
	ExternalLink,
	Eye,
	Link2,
	LogOut,
	Pencil,
	Plus,
	Save,
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
	useRef,
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
import { DetailBackLink } from "@/components/detail/back-link";
import { DetailNotFound, DetailPanel } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { HeaderActionGroup } from "@/components/header-action-group";
import { IconChip } from "@/components/icon-chip";
import { PageHeader, type PageHeaderProps, PageHeaderSkeleton } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import {
	displayProjectName,
	isCustomProject,
	type ProjectAgentMetadata,
	ProjectIdentity,
	projectAgentFor,
} from "@/components/projects/project-metadata";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { slugFromVaultName } from "@/components/vault/vault-slug";
import { VaultCard, VaultCardSkeleton } from "@/components/vault/vaults-surface";
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
import { formatShortDate } from "@/lib/format";
import { identityFor } from "@/lib/identity";
import { AGENT_SECTION_NAVIGATION_ITEMS } from "@/lib/navigation-model";
import { projectResourceHref } from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import {
	libraryManagementTarget,
	projectDetailHrefForScope,
	type ResourceNavigationScope,
	type ResourceNavigationTarget,
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

const PROJECT_LOCAL_TABS: readonly { id: ProjectLocalTab; label: string }[] = [
	{ id: "overview", label: "Overview" },
	{ id: "skills", label: "Skills" },
	{ id: "vaults", label: "Vaults" },
	{ id: "agents", label: "Agents" },
	{ id: "access", label: "Access" },
];

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
	// Committed-match location, not the pending target: this page stays
	// mounted while an outgoing navigation loads, and the rendered tab must
	// keep matching the URL the user is still looking at.
	const { pathname, search } = useCommittedLocation();
	const searchParams = useMemo(() => searchRecordToSearchParams(search), [search]);
	const requestedTab = searchParams.get("tab");
	const localTab: ProjectLocalTab = PROJECT_LOCAL_TABS.some((tab) => tab.id === requestedTab)
		? (requestedTab as ProjectLocalTab)
		: "overview";
	const projectsTarget = resourceCollectionTarget(scope, "projects");
	const managementTarget = libraryManagementTarget("projects", { projectId });
	const isAgentScope = scope.kind === "agent";
	const showSkills = isAgentScope ? focus !== "vaults" : localTab === "skills";
	const showVaults = isAgentScope ? focus !== "skills" : localTab === "vaults";
	const [useWithAgentOpen, setUseWithAgentOpen] = useState(
		searchParams.get("useWithAgent") === "1",
	);
	const [skillsPage, setSkillsPage] = useState(1);
	const [vaultsPage, setVaultsPage] = useState(1);
	const joinedFromShare = !isAgentScope && searchParams.get("joined") === "share";
	const returnHref = searchParams.get("from");
	const safeAgentReturnHref = returnHref?.startsWith("/agents/") ? returnHref : null;
	useEffect(() => {
		setSkillsPage(1);
		setVaultsPage(1);
	}, [projectId]);

	const projectQuery = $api.useQuery("get", "/v1/projects/{project_id}", {
		params: { path: { project_id: projectId } },
	});

	const project = projectQuery.data ?? null;
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
	const projectNameById = useMemo(
		() => new Map(project ? [[project.id, displayProjectName(project)]] : []),
		[project],
	);
	const visibleProjectIds = useMemo(() => new Set([projectId]), [projectId]);
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
	const isWorkspace = isAgentScope && scopedBinding?.binding_type === "primary";
	const isWorkspaceContext = isWorkspace || project?.kind === "environment";
	const canManageProjectSkills = canManageSkills && !isWorkspace;
	const pageReturnTarget: ResourceNavigationTarget =
		focus && scope.kind === "agent"
			? isWorkspace
				? {
						href: agentSectionHref(scope.agentId, "overview"),
						label: "Agent Overview",
					}
				: {
						href: projectDetailHrefForScope(scope, projectId),
						label: projectName ?? "Project",
					}
			: safeAgentReturnHref
				? { href: safeAgentReturnHref, label: "Agent Projects" }
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
		{ enabled: !isAgentScope && !!project && useWithAgentOpen },
	);
	const agentsById = useMemo(
		() => new Map((environments.data ?? []).map((agent) => [agent.id, agent])),
		[environments.data],
	);
	const projectAgent = project ? projectAgentFor(project, agentsById) : null;
	const localTabHref = (tab: ProjectLocalTab) => projectLocalTabHref(pathname, searchParams, tab);
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
		enabled: showSkills && (!isAgentScope || !!scopedBinding) && !(IS_HOSTED_BUILD && isWorkspace),
	});
	const workspaceSkillProjections = useMemo(
		() => (skills.data?.items ?? []).filter((skill) => skill.authority === "agent_sync"),
		[skills.data?.items],
	);

	const vaults = useQuery({
		queryKey: ["vaults", "project-detail", projectId, vaultsPage],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/vault", {
					params: {
						query: {
							project_id: projectId,
							page: vaultsPage,
							page_size: PROJECT_RESOURCE_PAGE_SIZE,
						},
					},
				}),
			),
		enabled: showVaults && (!isAgentScope || !!scopedBinding),
	});
	useEffect(() => {
		if (skills.data?.total === undefined) return;
		const pageCount = Math.max(1, Math.ceil(skills.data.total / PROJECT_RESOURCE_PAGE_SIZE));
		setSkillsPage((page) => Math.min(page, pageCount));
	}, [skills.data?.total]);
	useEffect(() => {
		if (vaults.data?.total === undefined) return;
		const pageCount = Math.max(1, Math.ceil(vaults.data.total / PROJECT_RESOURCE_PAGE_SIZE));
		setVaultsPage((page) => Math.min(page, pageCount));
	}, [vaults.data?.total]);

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
		enabled: !isAgentScope && !!project && isOwner && isShareableProject && localTab === "access",
	});

	const boundAgents = $api.useQuery(
		"get",
		"/v1/agents",
		{ params: { query: { project_id: projectId } } },
		{ enabled: !isAgentScope && !!project && (localTab === "agents" || useWithAgentOpen) },
	);

	const refresh = () => {
		qc.invalidateQueries({ queryKey: ["get", "/v1/projects"] });
		qc.invalidateQueries({ queryKey: ["skills"] });
		qc.invalidateQueries({ queryKey: ["vaults"] });
		qc.invalidateQueries({ queryKey: ["get", "/v1/vault"] });
		qc.invalidateQueries({ queryKey: ["get", "/v1/agents"] });
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
				{ description: normalizeApiError(error) },
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

	if (projectQuery.isLoading || (isAgentScope && scopedBindings.isLoading)) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<DetailBackLink
					href={projectsTarget.href}
					label={projectsTarget.label}
					mobileOnly={false}
				/>
				<PageHeaderSkeleton icon actions />
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
	const blockingProjectError = shouldBlockQueryError(projectQuery.error, projectQuery.data)
		? projectQuery.error
		: null;

	if (blockingProjectError || blockingScopeError) {
		const blockingError = blockingProjectError ?? blockingScopeError;
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<DetailBackLink
					href={projectsTarget.href}
					label={projectsTarget.label}
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
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<DetailBackLink
					href={projectsTarget.href}
					label={projectsTarget.label}
					mobileOnly={false}
				/>
				<DetailNotFound
					title="Project not found"
					message="This Project may have been removed, or your account no longer has access."
				/>
			</div>
		);
	}

	if (!isAgentScope && project.kind !== "workspace") {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<DetailBackLink
					href={projectsTarget.href}
					label={projectsTarget.label}
					mobileOnly={false}
				/>
				<DetailNotFound
					title="Project not found"
					message="This page is for user-created Projects. Open an Agent to manage its private Workspace."
				/>
			</div>
		);
	}

	if (isAgentScope && !scopedBinding) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<DetailBackLink
					href={projectsTarget.href}
					label={projectsTarget.label}
					mobileOnly={false}
				/>
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
	const blockingBoundAgentsError = shouldBlockQueryError(boundAgents.error, boundAgents.data)
		? boundAgents.error
		: null;
	const blockingEnvironmentsError = shouldBlockQueryError(environments.error, environments.data)
		? environments.error
		: null;
	const skillCount: CountValue | undefined = isAgentScope
		? isWorkspace || project.kind === "environment"
			? undefined
			: blockingSkillsError
				? "unavailable"
				: skills.data?.total
		: project.skill_count;
	const vaultCount: CountValue | undefined = isAgentScope
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
	const focusedResourceIdentity = focus ? AGENT_SECTION_NAVIGATION_ITEMS[focus] : null;
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
		<div className="space-y-6">
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
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6")}>
			<DetailBackLink href={pageReturnTarget.href} label={pageReturnTarget.label} />

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
									? "Skills available in this Agent's Workspace. Skills synced from the Agent are read-only."
									: focus === "vaults"
										? "Vaults attached to this Agent's Workspace."
										: "This Agent's fixed Workspace for installed Skills and attached Vaults."
								: focus === "skills"
									? "Skills this Agent uses through this linked Project."
									: focus === "vaults"
										? "Vaults this Agent can use through this Project. Key values stay protected."
										: "This Agent uses the Project's Skills and attached Vaults as one bundle."
							: projectDetailDescription(project, isOwner)
					}
					status={
						focus && !isWorkspace ? (
							<span className="text-xs text-muted-foreground">
								Project: {displayProjectName(project)}
							</span>
						) : undefined
					}
					actions={
						focus === "skills" && canManageProjectSkills ? (
							<Button
								render={<Link to="/skills" search={{ project: project.id, add: 1 }} />}
								nativeButton={false}
								size="sm"
							>
								<Plus className="size-3.5" />
								Add skill
							</Button>
						) : focus === "vaults" && isOwner ? (
							<ProjectVaultActions
								projectId={project.id}
								contextLabel={isWorkspace ? "Workspace" : "Project"}
								onChanged={refresh}
							/>
						) : !focus && !isAgentScope && isShareableProject ? (
							<>
								{!joinedFromShare
									? manageAgentsDialog(
											<Button size="sm">
												<Bot className="mr-1.5 size-3.5" />
												Manage agents
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
			)}

			{joinedFromShare && isShareableProject ? (
				<Alert>
					<CheckCircle2 className="size-4" />
					<AlertTitle>Project added</AlertTitle>
					<AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<span>
							Linking lets an Agent use this Project&apos;s Skills and attached Vaults together.
						</span>
						<Button type="button" size="sm" onClick={() => setUseWithAgentOpen(true)}>
							<Bot className="mr-1.5 size-3.5" />
							Manage agents
						</Button>
					</AlertDescription>
				</Alert>
			) : null}

			{!isAgentScope ? (
				<Tabs
					value={localTab}
					onValueChange={(value) => {
						if (isProjectLocalTab(value)) selectLocalTab(value);
					}}
				>
					<TabsList
						aria-label="Project pages"
						activateOnFocus
						className="grid h-auto w-full grid-cols-5 gap-1 rounded-xl border bg-muted/30 p-1 group-data-horizontal/tabs:h-auto"
					>
						{PROJECT_LOCAL_TABS.map((tab) => (
							<TabsTrigger
								key={tab.id}
								value={tab.id}
								className="min-w-0 px-1 py-2 text-xs sm:px-2 sm:text-sm"
							>
								{tab.label}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
			) : null}

			{!isAgentScope && localTab === "overview" ? (
				<DetailPanel className="space-y-5">
					<div className="space-y-1">
						<h2 className="text-sm font-semibold">Project bundle</h2>
						<p className="text-sm text-muted-foreground">
							{project.description ||
								"Keep reusable Skills and Vault access together, then link the whole Project to any Agent that needs it."}
						</p>
					</div>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
						<StatTile label="Skills" value={skillCount} href={localTabHref("skills")} />
						<StatTile label="Vaults" value={vaultCount} href={localTabHref("vaults")} />
						<StatTile label="People" value={peopleCount} href={localTabHref("access")} />
						<StatTile label="Agents" value={agentCount} href={localTabHref("agents")} />
					</div>
				</DetailPanel>
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
							? "Installed Skills in this Agent's fixed Workspace."
							: "Skills this Agent uses through this linked Project."
						: project.kind === "environment"
							? "Skills synced from this Agent. Manage them on the Agent."
							: isOwner
								? "Reusable instructions that belong to this Project."
								: "Readable instructions shared by the owner."
				}
				action={
					!focus && (projectResourceTargets || canManageProjectSkills) ? (
						<>
							{!focus && projectResourceTargets ? (
								<ProjectResourceViewAllLink
									href={projectResourceTargets.skills}
									resource="Skills"
								/>
							) : null}
							{canManageProjectSkills ? (
								<Button
									render={<Link to="/skills" search={{ project: project.id, add: 1 }} />}
									nativeButton={false}
									variant="outline"
									size="sm"
								>
									<Plus className="size-3.5" />
									Add skill
								</Button>
							) : null}
						</>
					) : undefined
				}
			>
				{workspaceAgentErrorPanel ? (
					focusedWorkspaceSkillsPageHeader ? (
						<div className="space-y-6">
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
						emptyMessage="No skills are visible in this Project yet."
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
				showHeading={!focus}
				id="vaults"
				title="Vaults"
				count={vaultCount}
				description={
					isAgentScope
						? isWorkspace
							? "Vaults attached to this Agent's Workspace."
							: "Vaults this Agent can use through this Project."
						: isOwner
							? "API keys and secrets this Project can use."
							: "Read-only vaults shared through this Project."
				}
				action={
					!focus && (projectResourceTargets || isOwner) ? (
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
				<ResourcePageControls
					page={vaultsPage}
					total={vaults.data?.total}
					pageSize={PROJECT_RESOURCE_PAGE_SIZE}
					isFetching={vaults.isFetching}
					onPageChange={setVaultsPage}
				/>
			</HubSection>

			{!isAgentScope && localTab === "access" && isOwner ? (
				<ProjectOwnerPanel
					project={project}
					onUpdated={() => {
						refresh();
						void projectQuery.refetch();
					}}
					onArchived={() => void router.navigate({ href: projectsTarget.href })}
				/>
			) : null}

			{!isAgentScope && localTab === "access" && isOwner && isShareableProject ? (
				<HubSection
					id="people"
					title="People"
					count={peopleCount}
					description="Members see Skills and key names. Key values stay protected, and their linked Agents can use them."
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

			{!isAgentScope && localTab === "access" && !isOwner ? (
				<HubSection
					id="people"
					title="Your access"
					description="You have viewer access. Linked Agents use this Project's Skills and attached Vaults together."
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

			{!isAgentScope && localTab === "agents" ? (
				<HubSection
					id="agents"
					title="Your Agents"
					count={agentCount}
					description={
						project.kind === "environment"
							? "Agent that owns this Workspace."
							: project.kind === "personal"
								? "Private library items are not linked to individual Agents."
								: "Agents you own that use this Project's Skills and attached Vaults."
					}
				>
					{boundAgents.isLoading ? (
						<Skeleton className="h-16 w-full" />
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
										: "None of your Agents are linked yet. Link this Project to let one use its Skills and attached Vaults."
							}
						/>
					) : (
						<div className="divide-y overflow-hidden rounded-lg border bg-card">
							{(boundAgents.data ?? []).map((env) => (
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
									{env.default_project_id === project.id ? (
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
										<span className="sr-only">Open agent {agentDisplayName(env)}</span>
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

const STAT_TILE_TINTS: Record<string, string> = {
	Skills: "bg-identity-2-bg/50",
	Vaults: "bg-identity-4-bg/50",
	People: "bg-identity-6-bg/50",
	Agents: "bg-identity-5-bg/50",
};

function StatTile({ label, value, href }: { label: string; value?: CountValue; href: string }) {
	return (
		<Link
			to={href}
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
		<nav
			aria-label="Resource pages"
			className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"
		>
			<p className="text-sm text-muted-foreground tabular-nums">
				Page {page} of {pageCount}
			</p>
			<div className="flex items-center gap-2">
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
		<section id={id} className="scroll-mt-20 space-y-3">
			{showHeading ? (
				<div className="flex flex-col items-start gap-3 sm:flex-row sm:items-end sm:justify-between">
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
			className="text-muted-foreground"
		>
			View all
			<ArrowRight />
		</Button>
	);
}

function projectDetailDescription(project: ProjectRow, isOwner: boolean) {
	const access = isOwner ? "you own" : "shared with you";
	if (project.kind === "workspace") {
		return isOwner
			? "Project you own. Add Skills and attach Vaults, then link the whole bundle to Agents that need it."
			: "Project shared with you. Linked Agents use its Skills and attached Vaults together.";
	}
	if (project.kind === "environment") {
		return `Workspace ${access}. This private Workspace belongs to one Agent and cannot be shared.`;
	}
	if (project.kind === "personal") {
		return `Private resources ${access}.`;
	}
	return `Project ${access}.`;
}

function ProjectOwnerPanel({
	project,
	onUpdated,
	onArchived,
}: {
	project: ProjectRow;
	onUpdated: () => void;
	onArchived: () => void;
}) {
	const api = useApi();
	const [editOpen, setEditOpen] = useState(false);
	const [name, setName] = useState(project.name);
	const [description, setDescription] = useState(project.description ?? "");
	const update = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.PATCH("/v1/projects/{project_id}", {
					params: { path: { project_id: project.id } },
					body: { name: name.trim(), description: description.trim() || null },
				}),
			),
		onSuccess: () => {
			setEditOpen(false);
			onUpdated();
			toast.success("Project updated");
		},
		onError: (error) =>
			toast.error("Couldn't update Project", { description: normalizeApiError(error) }),
	});
	const archive = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.DELETE("/v1/projects/{project_id}", {
					params: { path: { project_id: project.id } },
				}),
			),
		onSuccess: () => {
			toast.success("Project archived");
			onArchived();
		},
		onError: (error) =>
			toast.error("Couldn't archive Project", { description: normalizeApiError(error) }),
	});

	return (
		<DetailPanel className="space-y-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="space-y-1">
					<h2 className="text-sm font-semibold">Project settings</h2>
					<p className="text-xs text-muted-foreground">
						Update the name and description, or archive this Project when it is no longer used.
					</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						setName(project.name);
						setDescription(project.description ?? "");
						setEditOpen(true);
					}}
				>
					<Pencil className="size-3.5" />
					Edit project
				</Button>
			</div>
			<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div>
						<p className="text-sm font-medium">Archive project</p>
						<p className="mt-1 text-xs text-muted-foreground">
							This immediately unlinks every Agent and removes the Project from active views.
						</p>
					</div>
					<ConfirmAction
						title={`Archive ${displayProjectName(project)}?`}
						description={
							<p>
								Agents will stop using this Project&apos;s Skills and attached Vaults. Historical
								resource records are retained.
							</p>
						}
						confirmLabel="Archive project"
						destructive
						onConfirm={() => archive.mutateAsync()}
					>
						<Button variant="destructive" size="sm" disabled={archive.isPending}>
							{archive.isPending ? <Spinner /> : <Trash2 className="size-3.5" />}
							Archive project
						</Button>
					</ConfirmAction>
				</div>
			</div>

			<Dialog open={editOpen} onOpenChange={setEditOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Edit project</DialogTitle>
						<DialogDescription>
							These details help people recognize the resource bundle. Existing Agent links stay
							connected.
						</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (name.trim()) update.mutate();
						}}
					>
						<div className="space-y-1.5">
							<Label htmlFor={`project-name-${project.id}`}>Name</Label>
							<Input
								id={`project-name-${project.id}`}
								value={name}
								onChange={(event) => setName(event.target.value)}
								maxLength={200}
								autoComplete="off"
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={`project-description-${project.id}`}>Description</Label>
							<Textarea
								id={`project-description-${project.id}`}
								value={description}
								onChange={(event) => setDescription(event.target.value)}
								maxLength={2000}
								rows={4}
							/>
						</div>
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!name.trim() || update.isPending}>
								{update.isPending ? <Spinner /> : null}
								Save changes
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
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
					<h2 className="text-sm font-semibold">You have viewer access</h2>
				</div>
				<p className="text-xs text-muted-foreground">
					You can read this Project and link it to an Agent. The Agent then uses the Project&apos;s
					Skills and attached Vaults together.
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
					{isLeaving ? "Leaving…" : "Leave project"}
				</AlertDialogTrigger>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Leave {displayProjectName(project)}?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes your access and unlinks the Project from your Agents. Those Agents will
							stop using its Skills and attached Vaults.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={onLeave}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
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
						queryKey: ["get", "/v1/agents/{agent_id}", { params: { path: { agent_id: agentId } } }],
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
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Manage agents</DialogTitle>
					<DialogDescription>Choose which Agents can use this Project.</DialogDescription>
				</DialogHeader>

				{isLoadingAgents ? (
					<Skeleton className="h-24 w-full" />
				) : agentsError ? (
					<ApiErrorPanel error={agentsError} onRetry={onRetryAgents} title="Couldn't load Agents" />
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
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							submitAgentChanges();
						}}
					>
						<div className="max-h-80 divide-y overflow-y-auto rounded-md border">
							{orderedEnvironments.map((environment) => {
								const name = agentDisplayName(environment);
								const checkboxId = `project-agent-${environment.id}`;
								const isSelected = managedAgentIds.has(environment.id);
								return (
									<label
										key={environment.id}
										htmlFor={checkboxId}
										className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/20"
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
											meta={[
												environment.last_sync_at
													? `synced ${formatShortDate(environment.last_sync_at, { includeYear: false })}`
													: "not synced yet",
											]}
											className="min-w-0 flex-1"
										/>
									</label>
								);
							})}
						</div>

						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!hasAgentChanges || updateProjectAgents.isPending}>
								{updateProjectAgents.isPending ? <Spinner /> : <Save className="size-3.5" />}
								Save changes
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

function ProjectVaultActions({
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
	const [selectedVaultId, setSelectedVaultId] = useState("");
	const [attachSearch, setAttachSearch] = useState("");
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
	const availableVaults = (accountVaults.data?.items ?? []).filter(
		(vault) => vault.is_owner !== false && !(vault.project_ids ?? []).includes(projectId),
	);
	const normalizedAttachSearch = attachSearch.trim().toLowerCase();
	const attachableVaults = normalizedAttachSearch
		? availableVaults.filter((vault) =>
				[vault.name, vault.slug].join(" ").toLowerCase().includes(normalizedAttachSearch),
			)
		: availableVaults;
	const attachableItems = attachableVaults.map((vault) => ({
		value: vault.id,
		label: vault.name,
	}));
	const blockingAccountVaultsError = shouldBlockQueryError(accountVaults.error, accountVaults.data)
		? accountVaults.error
		: null;
	const newVaultSlug = slugFromVaultName(vaultName);
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
			toast.success(`Vault attached to ${contextLabel}`, {
				description:
					"Its key values stay protected, and attached Projects and Agents can use them.",
			});
		},
		onError: (error) =>
			toast.error(`Couldn't attach vault to ${contextLabel}`, {
				description: normalizeApiError(error),
			}),
	});
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
				<Plus className="size-3.5" />
				Create vault
			</Button>
			<Button size="sm" onClick={() => setAttachOpen(true)}>
				<Link2 className="size-3.5" />
				Attach vault
			</Button>

			<Dialog
				open={attachOpen}
				onOpenChange={setAttachOpen}
				onOpenChangeComplete={(open) => {
					if (!open) {
						setSelectedVaultId("");
						setAttachSearch("");
					}
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
					) : availableVaults.length === 0 ? (
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
							<div className="space-y-1.5">
								<Label htmlFor={`project-vault-search-${projectId}`}>Search Vaults</Label>
								<Input
									id={`project-vault-search-${projectId}`}
									value={attachSearch}
									onChange={(event) => {
										setAttachSearch(event.target.value);
										setSelectedVaultId("");
									}}
									placeholder="Search Vaults…"
								/>
							</div>
							{attachableVaults.length === 0 ? (
								<p className="text-sm text-muted-foreground">No Vaults match that search.</p>
							) : (
								<>
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
								</>
							)}
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
					if (!open) setVaultName("");
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Create vault</DialogTitle>
						<DialogDescription>
							Create an account-owned Vault for this {contextLabel}. It will also remain available
							in your Vault library.
						</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (vaultName.trim() && newVaultSlug && !create.isPending) {
								create.mutate(vaultName);
							}
						}}
					>
						<div className="grid gap-2">
							<Label htmlFor={`project-vault-name-${projectId}`}>Vault name</Label>
							<Input
								id={`project-vault-name-${projectId}`}
								name="project-vault-name"
								value={vaultName}
								onChange={(event) => setVaultName(event.target.value)}
								placeholder="Production credentials…"
								autoComplete="off"
								className="min-w-0 flex-1"
							/>
							{vaultName.trim() && !newVaultSlug ? (
								<p className="text-xs text-destructive">
									Use a name containing letters or numbers.
								</p>
							) : null}
						</div>
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={!vaultName.trim() || !newVaultSlug || create.isPending}
							>
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
