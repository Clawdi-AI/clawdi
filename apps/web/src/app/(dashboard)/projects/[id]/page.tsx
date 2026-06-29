"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	BookOpen,
	Bot,
	CheckCircle2,
	ChevronRight,
	Eye,
	LogOut,
	Plus,
	Share2,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import {
	AgentLabel,
	AgentSourceBadgeForEnvironment,
	agentDisplayName,
	compareAgentEnvironments,
} from "@/components/dashboard/agent-label";
import { DetailPanel } from "@/components/detail/layout";
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
import {
	Dialog,
	DialogContent,
	DialogDescription,
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
import { agentSectionHref } from "@/lib/agent-routes";
import { ApiError, unwrap, useApi } from "@/lib/api";
import { formatApiError } from "@/lib/api-errors";
import { fetchAllPages } from "@/lib/api-pagination";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { projectDetailHref, projectResourceHref } from "@/lib/project-resource-model";
import Link from "@/lib/router-link";
import { useParams, useRouter, useSearchParams } from "@/lib/router-navigation";
import { cn, errorMessage } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type VaultSummary = components["schemas"]["VaultResponse"];
type Env = components["schemas"]["EnvironmentResponse"];
type AgentProjectBinding = components["schemas"]["AgentProjectBindingResponse"];

type ProjectRow = components["schemas"]["ProjectResponse"];
type Member = components["schemas"]["MemberResponse"];

export default function ProjectDetailPage() {
	const params = useParams<{ id: string }>();
	const projectId = params.id;
	const api = useApi();
	const qc = useQueryClient();
	const router = useRouter();
	const searchParams = useSearchParams();
	const [useWithAgentOpen, setUseWithAgentOpen] = useState(
		searchParams.get("useWithAgent") === "1",
	);
	// Forms are progressive-disclosure (taste audit #2): content first,
	// inputs on demand.
	const [showInstallSkill, setShowInstallSkill] = useState(false);
	const [showCreateVault, setShowCreateVault] = useState(false);
	const joinedFromShare = searchParams.get("joined") === "share";

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => unwrap(await api.GET("/api/projects")),
	});

	const rows = projects.data ?? [];
	const project = rows.find((row) => row.id === projectId) ?? null;
	const isOwner = project?.is_owner !== false;
	const isShareableProject = project ? isCustomProject(project) : false;
	const isManaged = project ? isManagedProject(project) : false;

	useEffect(() => {
		if (searchParams.get("useWithAgent") === "1") setUseWithAgentOpen(true);
	}, [searchParams]);

	const handleUseWithAgentOpenChange = (open: boolean) => {
		setUseWithAgentOpen(open);
		if (!open && searchParams.get("useWithAgent") === "1") {
			router.replace(projectDetailHref(projectId), { scroll: false });
		}
	};

	const environments = useQuery({
		queryKey: ["environments"],
		queryFn: async () => unwrap(await api.GET("/api/environments")),
		enabled: !!project,
	});
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
						await api.GET("/api/skills", {
							params: { query: { project_id: projectId, page, page_size: pageSize } },
						}),
					),
				{ pageSize: 200, resourceName: "project skills" },
			),
		enabled: !!project,
	});

	const vaults = useQuery({
		queryKey: ["vaults", "project-detail", projectId],
		queryFn: async () =>
			fetchAllPages<VaultSummary>(
				async (page, pageSize) =>
					unwrap(
						await api.GET("/api/vault", {
							params: { query: { project_id: projectId, page, page_size: pageSize } },
						}),
					),
				{ pageSize: 200, resourceName: "project vaults" },
			),
		enabled: !!project,
	});

	// People tile/section — members list is owner-only on the API; viewers
	// simply don't get the section.
	const members = useQuery({
		queryKey: ["project-members", projectId],
		queryFn: async (): Promise<Member[]> =>
			unwrap(
				await api.GET("/api/projects/{project_id}/members", {
					params: { path: { project_id: projectId } },
				}),
			),
		enabled: !!project && isOwner && isShareableProject,
	});

	// Agents tile/section — which connected agents can use this project:
	// its home agent (default_project_id) plus every context binding.
	const boundAgents = useQuery({
		queryKey: ["project-bound-agents", projectId, (environments.data ?? []).length],
		enabled: !!project && !!environments.data,
		queryFn: async () => {
			const envs = environments.data ?? [];
			const results = await Promise.all(
				envs.map(async (env) => {
					if (env.default_project_id === projectId) return { env, home: true };
					try {
						const bindings = unwrap(
							await api.GET("/api/agents/{agent_id}/project-bindings", {
								params: { path: { agent_id: env.id } },
							}),
						);
						return bindings.some((b: AgentProjectBinding) => b.project_id === projectId)
							? { env, home: false }
							: null;
					} catch {
						return null;
					}
				}),
			);
			return results.filter((r): r is { env: Env; home: boolean } => r !== null);
		},
	});

	const refresh = () => {
		qc.invalidateQueries({ queryKey: ["projects"] });
		qc.invalidateQueries({ queryKey: ["skills"] });
		qc.invalidateQueries({ queryKey: ["vaults"] });
		qc.invalidateQueries({ queryKey: ["project-bound-agents", projectId] });
	};

	const leaveSharedProject = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.POST("/api/projects/{project_id}/leave", {
					params: { path: { project_id: projectId } },
				}),
			),
		onSuccess: () => {
			refresh();
			qc.invalidateQueries({ queryKey: ["agent-project-bindings"] });
			toast.success("Left Shared Project", { description: "Membership removed." });
			router.push(projectResourceHref("projects"));
		},
		onError: (e) => {
			toast.error("Couldn't leave shared project", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	useSetBreadcrumbTitle(project ? displayProjectName(project) : null);

	if (projects.isLoading) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<Skeleton className="h-10 w-52" />
				<Skeleton className="h-28 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	if (projects.error) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<Button asChild variant="ghost" size="sm" className="w-fit">
					<Link href={projectResourceHref("projects")}>
						<ArrowLeft className="mr-1.5 size-4" />
						Projects
					</Link>
				</Button>
				<Alert variant="destructive">
					<AlertTitle>Couldn&apos;t load project</AlertTitle>
					<AlertDescription>{errorMessage(projects.error)}</AlertDescription>
				</Alert>
			</div>
		);
	}

	if (!project) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<Button asChild variant="ghost" size="sm" className="w-fit">
					<Link href={projectResourceHref("projects")}>
						<ArrowLeft className="mr-1.5 size-4" />
						Projects
					</Link>
				</Button>
				<Alert>
					<AlertTitle>Project not found</AlertTitle>
					<AlertDescription>
						This Project may have been removed, or your account no longer has access.
					</AlertDescription>
				</Alert>
			</div>
		);
	}

	const skillCount = skills.data?.items.length;
	const vaultCount = vaults.data?.items.length;
	const peopleCount = members.data ? members.data.length + 1 : undefined; // +1 = owner
	const agentCount = boundAgents.data?.length;

	const addToAgentDialog = (trigger: ReactNode) => (
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

	return (
		<div className="space-y-6 px-4 lg:px-6">
			<Button asChild variant="ghost" size="sm" className="w-fit">
				<Link href={projectResourceHref("projects")}>
					<ArrowLeft className="mr-1.5 size-4" />
					Projects
				</Link>
			</Button>

			{/* Hub identity header — who this project is, in one glance. */}
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="flex min-w-0 items-start gap-3">
					<span
						className={cn(
							"flex size-11 shrink-0 select-none items-center justify-center rounded-xl text-2xl leading-none",
							identityFor(displayProjectName(project)).colorClasses,
						)}
					>
						{identityFor(displayProjectName(project)).emoji}
					</span>
					<div className="min-w-0">
						<div className="flex min-w-0 flex-wrap items-center gap-2">
							<h1 className="truncate text-xl font-semibold tracking-tight">
								{displayProjectName(project)}
							</h1>
							<ProjectKindBadge kind={project.kind} />
						</div>
						<p className="mt-1 text-sm text-muted-foreground">
							{projectDetailDescription(project, isOwner, projectType?.label ?? "Project")}
						</p>
						<p className="mt-0.5 font-mono text-xs text-muted-foreground">{project.slug}</p>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{addToAgentDialog(
						<Button size="sm">
							<Bot className="mr-1.5 size-3.5" />
							Add to agent
						</Button>,
					)}
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
				</div>
			</div>

			{joinedFromShare ? (
				<Alert>
					<CheckCircle2 className="size-4" />
					<AlertTitle>Project added</AlertTitle>
					<AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<span>
							Skills and Vault keys are used by agents. Add this Project to an agent to make them
							available.
						</span>
						<Button type="button" size="sm" onClick={() => setUseWithAgentOpen(true)}>
							<Bot className="mr-1.5 size-3.5" />
							Add to agent
						</Button>
					</AlertDescription>
				</Alert>
			) : null}

			{/* Stat tiles — anchors into the sections below. */}
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<StatTile label="Skills" value={skillCount} href="#skills" />
				<StatTile label="Vaults" value={vaultCount} href="#vaults" />
				{isOwner && isShareableProject ? (
					<StatTile label="People" value={peopleCount} href="#people" />
				) : null}
				<StatTile label="Agents" value={agentCount} href="#agents" />
			</div>

			<HubSection
				id="skills"
				title="Skills"
				count={skillCount}
				description={
					isOwner
						? "Reusable instructions stored in this Project."
						: "Readable instructions shared by the owner."
				}
				action={
					isOwner ? (
						<Button
							variant="outline"
							size="sm"
							aria-expanded={showInstallSkill}
							onClick={() => setShowInstallSkill((v) => !v)}
						>
							<Plus className="size-3.5" />
							Install skill
						</Button>
					) : null
				}
			>
				{isOwner && showInstallSkill ? (
					<InstallSkillInProjectForm projectId={project.id} onChanged={refresh} />
				) : null}
				{skills.error ? (
					<ErrorLine message={errorMessage(skills.error)} />
				) : (
					<SkillCardGrid
						skills={skills.data?.items ?? []}
						isLoading={skills.isLoading}
						emptyMessage="No skills are visible in this Project yet."
					/>
				)}
			</HubSection>

			<HubSection
				id="vaults"
				title="Vaults"
				count={vaultCount}
				description={
					isOwner
						? "API keys and secrets this Project can use."
						: "Read-only vaults shared through this Project."
				}
				action={
					isOwner ? (
						<Button
							variant="outline"
							size="sm"
							aria-expanded={showCreateVault}
							onClick={() => setShowCreateVault((v) => !v)}
						>
							<Plus className="size-3.5" />
							New vault
						</Button>
					) : null
				}
			>
				{isOwner && showCreateVault ? (
					<CreateVaultInProjectForm projectId={project.id} onChanged={refresh} />
				) : null}
				{vaults.isLoading ? (
					<Skeleton className="h-24 w-full" />
				) : vaults.error ? (
					<ErrorLine message={errorMessage(vaults.error)} />
				) : vaults.data?.items.length ? (
					<div className="divide-y overflow-hidden rounded-lg border bg-card">
						{vaults.data.items.map((vault) => (
							<VaultRow key={vault.id} vault={vault} ownProjectId={project.id} />
						))}
					</div>
				) : (
					<EmptyLine message="No vaults are visible in this Project yet." />
				)}
			</HubSection>

			{isOwner && isShareableProject ? (
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

			{!isOwner ? (
				<HubSection
					id="people"
					title="Your access"
					description="You have viewer access — read skills, see key names, and use them with your agents."
				>
					<SharedAccessPanel
						project={project}
						agent={projectAgent}
						isLeaving={leaveSharedProject.isPending}
						onLeave={() => leaveSharedProject.mutate()}
						useWithAgentControl={addToAgentDialog(
							<Button size="sm" className="w-fit">
								<Bot className="mr-1.5 size-3.5" />
								Add to agent
							</Button>,
						)}
					/>
				</HubSection>
			) : null}

			<HubSection
				id="agents"
				title="Agents"
				count={agentCount}
				description="Agents that can use this Project at runtime."
				action={addToAgentDialog(
					<Button variant="outline" size="sm">
						<Bot className="mr-1.5 size-3.5" />
						Add to agent
					</Button>,
				)}
			>
				{boundAgents.isLoading || environments.isLoading ? (
					<Skeleton className="h-16 w-full" />
				) : (boundAgents.data?.length ?? 0) === 0 ? (
					<EmptyLine message="No agents use this Project yet. Add it to an agent to sync its skills and keys." />
				) : (
					<div className="divide-y overflow-hidden rounded-lg border bg-card">
						{(boundAgents.data ?? []).map(({ env, home }) => (
							<div key={env.id} className="group relative flex items-center gap-3 px-4 py-3">
								<AgentLabel
									machineName={env.machine_name}
									displayName={env.display_name}
									type={env.agent_type}
									avatarUrl={env.avatar_url}
									size="sm"
									titleAdornment={<AgentSourceBadgeForEnvironment env={env} compact />}
									className="min-w-0 flex-1"
								/>
								{home ? (
									<Badge variant="secondary" className="shrink-0">
										Home project
									</Badge>
								) : (
									<Badge variant="outline" className="shrink-0">
										Added
									</Badge>
								)}
								<Link
									href={agentSectionHref(env.id)}
									className="absolute inset-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<span className="sr-only">Open agent {displayAgentName(env)}</span>
								</Link>
							</div>
						))}
					</div>
				)}
			</HubSection>

			{isOwner && isManaged ? <ManagedProjectPanel project={project} agent={projectAgent} /> : null}
		</div>
	);
}

const STAT_TILE_TINTS: Record<string, string> = {
	Skills: "bg-identity-2-bg/50",
	Vaults: "bg-identity-4-bg/50",
	People: "bg-identity-6-bg/50",
	Agents: "bg-identity-5-bg/50",
};

function StatTile({ label, value, href }: { label: string; value?: number; href: string }) {
	return (
		<a
			href={href}
			className={cn(
				"group rounded-xl border border-transparent p-4 transition-all duration-150 hover:-translate-y-px hover:border-foreground/15 focus-visible:ring-2 focus-visible:ring-ring focus:outline-none",
				STAT_TILE_TINTS[label] ?? "bg-card",
			)}
		>
			<div className="text-2xl font-semibold tabular-nums">
				{value === undefined ? <Skeleton className="h-8 w-8" /> : value}
			</div>
			<div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
				{label}
				<ChevronRight className="size-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
			</div>
		</a>
	);
}

function HubSection({
	id,
	title,
	count,
	description,
	action,
	children,
}: {
	id: string;
	title: string;
	count?: number;
	description: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section id={id} className="scroll-mt-20 space-y-3">
			<div className="flex items-end justify-between gap-2">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<h2 className="text-sm font-semibold">{title}</h2>
						{count !== undefined ? (
							<Badge variant="secondary" className="tabular-nums">
								{count}
							</Badge>
						) : null}
					</div>
					<p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
				</div>
				{action ? <div className="shrink-0">{action}</div> : null}
			</div>
			{children}
		</section>
	);
}

function projectDetailDescription(project: ProjectRow, isOwner: boolean, typeLabel: string) {
	const access = isOwner ? "you own" : "shared with you";
	if (project.kind === "workspace") {
		return isOwner
			? `${typeLabel} you own. Add skills and vaults here, share the Project, then add it to agents when needed.`
			: `${typeLabel} shared with you. You can read its skills and vaults and add it to agents when needed.`;
	}
	if (project.kind === "environment") {
		return `${typeLabel} ${access}. This is the Agent Project for one connected agent. It is managed for you and cannot be shared.`;
	}
	if (project.kind === "personal") {
		return `${typeLabel} ${access}. This is your account default for resources that are not tied to one workflow or agent.`;
	}
	return `${typeLabel} ${access}. Slug: ${project.slug}`;
}

function ManagedProjectPanel({
	project,
	agent,
}: {
	project: ProjectRow;
	agent?: ProjectAgentMetadata | null;
}) {
	const description =
		project.kind === "environment"
			? "This Agent Project is managed by the connected agent and is not shareable. Create a Project when you need collaboration or reusable resources."
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
			<Button asChild variant="outline" size="sm" className="w-full">
				<Link href={projectResourceHref("projects")}>Back to Projects</Link>
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
					You can read this Project. Add it to an agent when you want it available during a run.
				</p>
			</div>
			<div className="rounded-md border bg-background/60 p-3">
				<div className="flex items-center justify-between gap-3">
					<ProjectIdentity project={project} agent={agent} showKind={false} className="flex-1" />
				</div>
			</div>
			{useWithAgentControl}
			<AlertDialog>
				<AlertDialogTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						disabled={isLeaving}
						className="w-full text-muted-foreground hover:text-destructive"
					>
						<LogOut className="mr-1.5 size-3.5" />
						{isLeaving ? "Leaving…" : "Leave Project"}
					</Button>
				</AlertDialogTrigger>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Leave {displayProjectName(project)}?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes your read-only membership. Agents will no longer be able to use this
							Project through your account.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={onLeave}
							className="bg-destructive text-white hover:bg-destructive/90"
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
	children: ReactNode;
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
	const selectedEnv = orderedEnvironments.find((env) => env.id === selectedAgentId) ?? null;
	const projectIsHome = selectedEnv?.default_project_id === project.id;
	const selectedBindings = useQuery({
		queryKey: ["agent-project-bindings", selectedAgentId],
		queryFn: async (): Promise<AgentProjectBinding[]> =>
			unwrap(
				await api.GET("/api/agents/{agent_id}/project-bindings", {
					params: { path: { agent_id: selectedAgentId } },
				}),
			),
		enabled: open && !!selectedAgentId,
	});
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
				await api.POST("/api/agents/{agent_id}/project-bindings/context", {
					params: { path: { agent_id: selectedAgentId } },
					body: { project_id: project.id },
				}),
			);
		},
		onSuccess: () => {
			const agentName = selectedEnv ? displayAgentName(selectedEnv) : "the agent";
			qc.invalidateQueries({ queryKey: ["agent-project-bindings", selectedAgentId] });
			qc.invalidateQueries({ queryKey: ["skills"] });
			qc.invalidateQueries({ queryKey: ["vaults"] });
			toast.success("Project Added", {
				description: `Done. ${agentName} can now use ${projectName}'s skills and Vault keys.`,
				action: {
					label: "Open Agent",
					onClick: () => router.push(agentSectionHref(selectedAgentId, "projects")),
				},
			});
			onOpenChange(false);
		},
		onError: (e) => {
			toast.error("Couldn't add project", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add Project to Agent</DialogTitle>
					<DialogDescription>
						Add {projectName} as an extra Project for an agent. The agent&apos;s main Project stays
						the writable default; this Project is read by the agent.
					</DialogDescription>
				</DialogHeader>

				{isLoadingEnvironments ? (
					<Skeleton className="h-24 w-full" />
				) : orderedEnvironments.length === 0 ? (
					<Alert>
						<Bot className="size-4" />
						<AlertTitle>No agents connected</AlertTitle>
						<AlertDescription>
							Add an agent from Overview first, then add this Project here or from the agent&apos;s
							Project Access section.
						</AlertDescription>
					</Alert>
				) : (
					<div className="space-y-4">
						<div className="space-y-2">
							<div className="text-sm font-medium">Agent</div>
							<Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
								<SelectTrigger
									aria-label="Agent to add this Project to"
									className="h-auto min-h-9 w-full justify-between py-2"
								>
									{selectedEnv ? (
										<AgentLabel
											machineName={selectedEnv.machine_name}
											displayName={selectedEnv.display_name}
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
								<SelectContent position="popper" align="start">
									{orderedEnvironments.map((env) => (
										<SelectItem
											key={env.id}
											value={env.id}
											textValue={displayAgentName(env)}
											className="py-2"
										>
											<AgentLabel
												machineName={env.machine_name}
												displayName={env.display_name}
												type={env.agent_type}
												avatarUrl={env.avatar_url}
												size="sm"
												primary="machine"
												titleAdornment={<AgentSourceBadgeForEnvironment env={env} compact />}
												meta={[
													env.last_sync_at
														? `synced ${formatShortDate(env.last_sync_at)}`
														: "not synced yet",
												]}
											/>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="rounded-md border bg-muted/20 p-3 text-sm">
							{projectIsHome ? (
								<div className="flex items-start gap-2">
									<CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
									<div>
										<div className="font-medium">This Is the Agent&apos;s Main Project</div>
										<p className="mt-1 text-xs text-muted-foreground">
											No extra step is needed. Open the agent&apos;s Project Access section to
											review its read order.
										</p>
									</div>
								</div>
							) : existingBinding ? (
								<div className="flex items-start gap-2">
									<CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
									<div>
										<div className="font-medium">Already Added as Extra</div>
										<p className="mt-1 text-xs text-muted-foreground">
											Open the agent&apos;s Project Access section to review its read order or
											remove it.
										</p>
									</div>
								</div>
							) : (
								<div className="flex items-start gap-2">
									<Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
									<div>
										<div className="font-medium">Add as Extra</div>
										<p className="mt-1 text-xs text-muted-foreground">
											Skills and vaults from this Project become available to the selected agent.
											Writes still land in the agent&apos;s main Project.
										</p>
									</div>
								</div>
							)}
						</div>

						{selectedBindings.error ? (
							<ErrorLine message="Couldn’t check this agent’s project list. Refresh and retry." />
						) : null}

						<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
							<Button variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							{projectIsAlreadyAvailable && selectedEnv ? (
								<Button asChild>
									<Link href={agentSectionHref(selectedEnv.id, "projects")}>
										Open Agent Projects
									</Link>
								</Button>
							) : (
								<Button
									onClick={() => addProjectToAgent.mutate()}
									disabled={
										!selectedAgentId ||
										addProjectToAgent.isPending ||
										selectedBindings.isLoading ||
										selectedBindings.isError ||
										projectIsAlreadyAvailable
									}
								>
									{addProjectToAgent.isPending ? <Spinner /> : <Plus className="mr-1.5 size-3.5" />}
									{addProjectToAgent.isPending ? "Adding…" : "Add Project"}
								</Button>
							)}
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

function InstallSkillInProjectForm({
	projectId,
	onChanged,
}: {
	projectId: string;
	onChanged: () => void;
}) {
	const api = useApi();
	const [repoInput, setRepoInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const install = useMutation({
		mutationFn: async ({ repo, path }: { repo: string; path?: string }) =>
			unwrap(
				await api.POST("/api/projects/{project_id}/skills/install", {
					params: { path: { project_id: projectId } },
					body: { repo, path },
				}),
			),
		onSuccess: () => {
			setRepoInput("");
			setError(null);
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
		<div className="grid max-w-3xl gap-2 rounded-lg border bg-muted/20 p-3">
			<Label htmlFor={`project-skill-repo-${projectId}`} className="text-xs font-medium">
				GitHub skill repository
			</Label>
			<div className="flex flex-col gap-2 sm:flex-row">
				<Input
					id={`project-skill-repo-${projectId}`}
					name="project-skill-repo"
					value={repoInput}
					onChange={(e) => {
						setRepoInput(e.target.value);
						setError(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") submit();
					}}
					placeholder="owner/repo or owner/repo/path…"
					autoComplete="off"
					spellCheck={false}
					aria-invalid={!!error || undefined}
					className="min-w-0 flex-1"
				/>
				<Button
					size="sm"
					disabled={!repoInput.trim() || install.isPending}
					onClick={submit}
					variant={repoInput.trim() ? "default" : "outline"}
					className="w-full sm:w-auto"
				>
					{install.isPending ? <Spinner /> : <Plus className="mr-1.5 size-3.5" />}
					Install skill
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">Paste a GitHub skill path to add it here.</p>
			{error ? <p className="text-xs text-destructive">{error}</p> : null}
		</div>
	);
}

function CreateVaultInProjectForm({
	projectId,
	onChanged,
}: {
	projectId: string;
	onChanged: () => void;
}) {
	const api = useApi();
	const [slug, setSlug] = useState("");
	const create = useMutation({
		mutationFn: async (nextSlug: string) =>
			unwrap(
				await api.POST("/api/vault", {
					params: { query: { project_id: projectId, create_only: true } },
					body: { slug: nextSlug, name: nextSlug },
				}),
			),
		onSuccess: () => {
			setSlug("");
			onChanged();
			toast.success("Vault created", { description: "Added to this Project." });
		},
		onError: (e) => toast.error("Couldn't create vault", { description: errorMessage(e) }),
	});

	return (
		<div className="grid max-w-3xl gap-2 rounded-lg border bg-muted/20 p-3">
			<Label htmlFor={`project-vault-slug-${projectId}`} className="text-xs font-medium">
				Vault name
			</Label>
			<div className="flex flex-col gap-2 sm:flex-row">
				<Input
					id={`project-vault-slug-${projectId}`}
					name="project-vault-slug"
					value={slug}
					onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
					onKeyDown={(e) => {
						if (e.key === "Enter" && slug) create.mutate(slug);
					}}
					placeholder="github…"
					autoComplete="off"
					spellCheck={false}
					className="min-w-0 flex-1"
				/>
				<Button
					size="sm"
					disabled={!slug || create.isPending}
					onClick={() => slug && create.mutate(slug)}
					variant={slug ? "default" : "outline"}
					className="w-full sm:w-auto"
				>
					{create.isPending ? <Spinner /> : <Plus className="mr-1.5 size-3.5" />}
					Create Vault
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				Use lowercase letters, numbers, and hyphens. Add keys from the Vaults page after creation.
			</p>
		</div>
	);
}

function VaultRow({ vault }: { vault: VaultSummary; ownProjectId: string }) {
	const id = identityFor(vault.name);
	return (
		<div className="group relative flex items-center gap-3 p-3 transition-colors hover:bg-muted/30">
			<span
				className={cn(
					"flex size-7 shrink-0 select-none items-center justify-center rounded-md text-sm leading-none",
					id.colorClasses,
				)}
			>
				{id.emoji}
			</span>
			<div className="min-w-0 flex-1">
				<span className="block truncate text-sm font-medium">{vault.name}</span>
				<span className="mt-0.5 block font-mono text-xs text-muted-foreground">{vault.slug}</span>
			</div>
			<ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
			<Link
				href={`/vault/${encodeURIComponent(vault.slug)}`}
				aria-label={`Open vault ${vault.name}`}
				className="absolute inset-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			/>
		</div>
	);
}

function compareEnvironmentsForUse(a: Env, b: Env) {
	return compareAgentEnvironments(a, b);
}

function displayAgentName(env: Env) {
	return agentDisplayName(env);
}

function formatShortDate(value: string) {
	return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
		new Date(value),
	);
}

function EmptyLine({ message }: { message: string }) {
	return (
		<div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
			{message}
		</div>
	);
}

function ErrorLine({ message }: { message: string }) {
	return (
		<div className="rounded-lg border border-dashed border-destructive/40 px-4 py-4 text-sm text-destructive">
			{message}
		</div>
	);
}
