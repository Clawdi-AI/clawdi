"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	BookOpen,
	Bot,
	CheckCircle2,
	ExternalLink,
	Eye,
	KeyRound,
	LogOut,
	type LucideIcon,
	Plus,
	Share2,
	Sparkles,
	Users,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { AgentLabel, agentTypeLabel, cleanMachineName } from "@/components/dashboard/agent-label";
import { PageHeader } from "@/components/page-header";
import {
	displayProjectName,
	isCustomProject,
	isManagedProject,
	type ProjectAgentMetadata,
	ProjectIdentity,
	ProjectKindBadge,
	projectAgentFor,
	projectAlias,
	projectKindMeta,
} from "@/components/projects/project-metadata";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
import { formatApiError } from "@/components/sharing/vault-conflicts";
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
import { ApiError, unwrap, useApi, useAuthedFetch } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import {
	projectDetailHref,
	projectManagedResourceDefinitions,
	projectResourceHref,
	projectResourcePathLabel,
	skillDetailHref,
} from "@/lib/project-resource-model";
import { errorMessage } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type VaultSummary = components["schemas"]["VaultResponse"];
type Env = components["schemas"]["EnvironmentResponse"];
type AgentProjectBinding = components["schemas"]["AgentProjectBindingResponse"];

interface ProjectRow {
	id: string;
	name: string;
	slug: string;
	kind: string;
	origin_environment_id: string | null;
	archived_at: string | null;
	created_at: string;
	is_owner?: boolean;
	owner_display?: string | null;
	owner_handle?: string | null;
}

export default function ProjectDetailPage() {
	const params = useParams<{ id: string }>();
	const projectId = params.id;
	const api = useApi();
	const authedFetch = useAuthedFetch();
	const qc = useQueryClient();
	const router = useRouter();
	const searchParams = useSearchParams();
	const [useWithAgentOpen, setUseWithAgentOpen] = useState(
		searchParams.get("useWithAgent") === "1",
	);

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => {
			const r = await authedFetch("/api/projects");
			return r.json();
		},
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
			unwrap(
				await api.GET("/api/skills", {
					params: { query: { project_id: projectId, page_size: 100 } },
				}),
			),
		enabled: !!project,
	});

	const vaults = useQuery({
		queryKey: ["vaults", "project-detail", projectId],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/vault", {
					params: { query: { project_id: projectId, page_size: 100 } },
				}),
			),
		enabled: !!project,
	});

	const refresh = () => {
		qc.invalidateQueries({ queryKey: ["projects"] });
		qc.invalidateQueries({ queryKey: ["skills"] });
		qc.invalidateQueries({ queryKey: ["vaults"] });
	};

	const leaveSharedProject = useMutation({
		mutationFn: async (): Promise<{ status: string }> => {
			const r = await authedFetch(`/api/projects/${projectId}/leave`, { method: "POST" });
			return r.json();
		},
		onSuccess: () => {
			refresh();
			qc.invalidateQueries({ queryKey: ["agent-project-bindings"] });
			toast.success("Left Shared Project", { description: "Membership removed." });
			router.push(projectResourceHref("projects"));
		},
		onError: (e) => {
			toast.error("Failed to Leave Shared Project", {
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

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<Button asChild variant="ghost" size="sm" className="w-fit">
				<Link href={projectResourceHref("projects")}>
					<ArrowLeft className="mr-1.5 size-4" />
					Projects
				</Link>
			</Button>

			<PageHeader
				title={displayProjectName(project)}
				description={projectDetailDescription(project, isOwner, projectType?.label ?? "Project")}
				actions={
					<div className="flex items-center gap-2">
						<ProjectKindBadge kind={project.kind} />
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
				}
			/>

			<OverviewCard
				project={project}
				agent={projectAgent}
				skillCount={skills.data?.items.length ?? 0}
				vaultCount={vaults.data?.items.length ?? 0}
			/>

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
				<div className="space-y-6">
					<section className="space-y-5 rounded-lg border bg-card/60 p-4">
						<ContentHeader
							title="Resources in This Project"
							description={
								isOwner
									? "Skills and vaults available in this Project."
									: "Shared resources you can read from this Project."
							}
							action={<ProjectResourceLinks projectId={project.id} />}
						/>
						<ProjectStatsStrip
							skillCount={skills.data?.items.length ?? 0}
							vaultCount={vaults.data?.items.length ?? 0}
						/>
						<div className="space-y-5">
							<div className="space-y-3">
								<ContentHeader
									title="Skills"
									description={
										isOwner
											? "Reusable instructions stored in this Project."
											: "Readable instructions shared by the owner."
									}
								/>
								{isOwner ? (
									<InstallSkillInProjectForm projectId={project.id} onChanged={refresh} />
								) : null}
								{skills.isLoading ? (
									<Skeleton className="h-24 w-full" />
								) : skills.error ? (
									<ErrorLine message={errorMessage(skills.error)} />
								) : skills.data?.items.length ? (
									<div className="divide-y rounded-lg border bg-background/50">
										{skills.data.items.map((skill) => (
											<SkillRow
												key={`${skill.project_id}:${skill.skill_key}`}
												skill={skill}
												ownProjectId={project.id}
											/>
										))}
									</div>
								) : (
									<EmptyLine message="No skills are visible in this Project yet." />
								)}
							</div>

							<div className="space-y-3">
								<ContentHeader
									title="Vaults"
									description={
										isOwner
											? "Vaults available in this Project."
											: "Read-only vaults shared through this Project."
									}
								/>
								{isOwner ? (
									<CreateVaultInProjectForm projectId={project.id} onChanged={refresh} />
								) : null}
								{vaults.isLoading ? (
									<Skeleton className="h-24 w-full" />
								) : vaults.error ? (
									<ErrorLine message={errorMessage(vaults.error)} />
								) : vaults.data?.items.length ? (
									<div className="divide-y rounded-lg border bg-background/50">
										{vaults.data.items.map((vault) => (
											<VaultRow key={vault.id} vault={vault} ownProjectId={project.id} />
										))}
									</div>
								) : (
									<EmptyLine message="No vaults are visible in this Project yet." />
								)}
							</div>
						</div>
					</section>
				</div>

				<aside className="space-y-4">
					{isOwner && isShareableProject ? (
						<OwnerAccessPanel
							project={project}
							useWithAgentControl={
								<UseProjectWithAgentDialog
									project={project}
									environments={environments.data ?? []}
									isLoadingEnvironments={environments.isLoading}
									open={useWithAgentOpen}
									onOpenChange={handleUseWithAgentOpenChange}
								>
									<Button variant="outline" className="w-full" size="sm">
										<Bot className="mr-1.5 size-3.5" />
										Attach to Agent
									</Button>
								</UseProjectWithAgentDialog>
							}
						/>
					) : isOwner && isManaged ? (
						<ManagedProjectPanel project={project} agent={projectAgent} />
					) : (
						<SharedAccessPanel
							project={project}
							agent={projectAgent}
							isLeaving={leaveSharedProject.isPending}
							onLeave={() => leaveSharedProject.mutate()}
							useWithAgentControl={
								<UseProjectWithAgentDialog
									project={project}
									environments={environments.data ?? []}
									isLoadingEnvironments={environments.isLoading}
									open={useWithAgentOpen}
									onOpenChange={handleUseWithAgentOpenChange}
								>
									<Button size="sm" className="w-full">
										<Bot className="mr-1.5 size-3.5" />
										Attach to Agent
									</Button>
								</UseProjectWithAgentDialog>
							}
						/>
					)}
				</aside>
			</div>
		</div>
	);
}

function OverviewCard({
	project,
	agent,
	skillCount,
	vaultCount,
}: {
	project: ProjectRow;
	agent?: ProjectAgentMetadata | null;
	skillCount: number;
	vaultCount: number;
}) {
	return (
		<section className="rounded-lg border bg-card/60 p-4">
			<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
				<div className="min-w-0 space-y-3">
					<div className="flex flex-wrap items-center gap-2">
						<BookOpen className="size-4 text-muted-foreground" />
						<h2 className="text-sm font-semibold">Overview</h2>
					</div>
					<ProjectIdentity project={project} agent={agent} titleClassName="text-base" />
				</div>
				<div className="grid min-w-52 gap-2 rounded-md border bg-background/60 p-3 text-xs text-muted-foreground">
					<div className="flex items-center justify-between gap-3">
						<span>Skills</span>
						<span className="font-semibold text-foreground">{skillCount}</span>
					</div>
					<div className="flex items-center justify-between gap-3">
						<span>Vaults</span>
						<span className="font-semibold text-foreground">{vaultCount}</span>
					</div>
					<div className="truncate font-mono" translate="no">
						{projectAlias(project)}
					</div>
				</div>
			</div>
		</section>
	);
}

function projectDetailDescription(project: ProjectRow, isOwner: boolean, typeLabel: string) {
	const access = isOwner ? "you own" : "shared with you";
	if (project.kind === "workspace") {
		return isOwner
			? `${typeLabel} you own. Add skills and vaults here, share the Project, then attach it to agents when needed.`
			: `${typeLabel} shared with you. You can read its skills and vaults and attach it to agents when needed.`;
	}
	if (project.kind === "environment") {
		return `${typeLabel} ${access}. This is the Agent Project for one connected agent. It is managed for you and cannot be shared.`;
	}
	if (project.kind === "personal") {
		return `${typeLabel} ${access}. This is your account default for resources that are not tied to one workflow or agent.`;
	}
	return `${typeLabel} ${access}. Slug: ${project.slug}`;
}

function OwnerAccessPanel({
	project,
	useWithAgentControl,
}: {
	project: ProjectRow;
	useWithAgentControl: ReactNode;
}) {
	const projectName = displayProjectName(project);
	return (
		<section className="space-y-4 rounded-lg border bg-card/60 p-4">
			<div className="space-y-1">
				<div className="flex items-center gap-2">
					<Users className="size-4 text-muted-foreground" />
					<h2 className="text-sm font-semibold">Custom Project Sharing</h2>
				</div>
				<p className="text-xs text-muted-foreground">
					Manage people, pending invites, and share links for this Custom Project. New members join
					as Viewers by default.
				</p>
			</div>
			<div className="grid gap-2 text-xs text-muted-foreground">
				<div className="flex items-center justify-between gap-3 rounded-md border bg-background/60 px-3 py-2">
					<span>Default role</span>
					<Badge variant="secondary">Viewer</Badge>
				</div>
				<div className="flex items-center justify-between gap-3 rounded-md border bg-background/60 px-3 py-2">
					<span>Manage</span>
					<span className="font-medium text-foreground">People, Invites, Links</span>
				</div>
			</div>
			<ShareProjectDialog
				projectId={project.id}
				projectName={projectName}
				projectKind={project.kind}
			>
				<Button className="w-full" size="sm">
					<Share2 className="mr-1.5 size-3.5" />
					Manage Sharing
				</Button>
			</ShareProjectDialog>
			{useWithAgentControl}
		</section>
	);
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
			? "This Agent Project is managed by the connected agent and is not shareable. Create a Custom Project when you need collaboration or reusable resources."
			: "This Global Project is your account default and is not shareable. Create a Custom Project when you need collaboration or reusable resources.";
	return (
		<section className="space-y-4 rounded-lg border bg-card/60 p-4">
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
		</section>
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
		<section className="space-y-4 rounded-lg border bg-card/60 p-4">
			<div className="space-y-1">
				<div className="flex items-center gap-2">
					<Eye className="size-4 text-muted-foreground" />
					<h2 className="text-sm font-semibold">You Have Viewer Access</h2>
				</div>
				<p className="text-xs text-muted-foreground">
					You can read this Project. Attach it to an agent when you want it available during a run.
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
		</section>
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

	const attach = useMutation({
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
			toast.success("Project Attached", {
				description: `${projectName} is now available to ${agentName}.`,
				action: {
					label: "Open Agent",
					onClick: () => router.push(`/agents/${selectedAgentId}?tab=projects`),
				},
			});
			onOpenChange(false);
		},
		onError: (e) => {
			toast.error("Failed to Attach Project", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Attach Project to Agent</DialogTitle>
					<DialogDescription>
						Add {projectName}
						{" to "}
						an agent&apos;s Attached Projects. The Agent Project stays the writable default; this
						Project is read by the agent.
					</DialogDescription>
				</DialogHeader>

				{isLoadingEnvironments ? (
					<Skeleton className="h-24 w-full" />
				) : orderedEnvironments.length === 0 ? (
					<Alert>
						<Bot className="size-4" />
						<AlertTitle>No Agents Connected</AlertTitle>
						<AlertDescription>
							Add an agent from Overview first, then attach this Project here or from the
							agent&apos;s Projects tab.
						</AlertDescription>
					</Alert>
				) : (
					<div className="space-y-4">
						<div className="space-y-2">
							<div className="text-sm font-medium">Agent</div>
							<Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
								<SelectTrigger
									aria-label="Agent to attach this Project to"
									className="h-auto min-h-9 w-full justify-between py-2"
								>
									{selectedEnv ? (
										<span className="flex min-w-0 items-center gap-2">
											<span className="truncate">{displayAgentName(selectedEnv)}</span>
											<span className="shrink-0 text-xs text-muted-foreground">
												{agentTypeLabel(selectedEnv.agent_type)}
											</span>
										</span>
									) : (
										<SelectValue placeholder="Choose an agent…" />
									)}
								</SelectTrigger>
								<SelectContent position="popper" align="start">
									{orderedEnvironments.map((env) => (
										<SelectItem key={env.id} value={env.id} className="py-2">
											<AgentLabel
												machineName={env.machine_name}
												type={env.agent_type}
												size="sm"
												primary="machine"
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
										<div className="font-medium">Already This Agent&apos;s Agent Project</div>
										<p className="mt-1 text-xs text-muted-foreground">
											No attach step is needed. Open the agent&apos;s Projects tab to review its
											read order.
										</p>
									</div>
								</div>
							) : existingBinding ? (
								<div className="flex items-start gap-2">
									<CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
									<div>
										<div className="font-medium">Already Attached to This Agent</div>
										<p className="mt-1 text-xs text-muted-foreground">
											Open the agent&apos;s Projects tab to review its read order or detach it.
										</p>
									</div>
								</div>
							) : (
								<div className="flex items-start gap-2">
									<Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
									<div>
										<div className="font-medium">Attach as Extra Project</div>
										<p className="mt-1 text-xs text-muted-foreground">
											Skills and vaults from this Project become available to the selected agent.
											Writes still land in the Agent Project.
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
									<Link href={`/agents/${selectedEnv.id}?tab=projects`}>Open Agent Projects</Link>
								</Button>
							) : (
								<Button
									onClick={() => attach.mutate()}
									disabled={
										!selectedAgentId ||
										attach.isPending ||
										selectedBindings.isLoading ||
										selectedBindings.isError ||
										projectIsAlreadyAvailable
									}
								>
									{attach.isPending ? <Spinner /> : <Plus className="mr-1.5 size-3.5" />}
									{attach.isPending ? "Attaching…" : "Attach Project"}
								</Button>
							)}
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

function ProjectStatsStrip({ skillCount, vaultCount }: { skillCount: number; vaultCount: number }) {
	return (
		<div className="grid divide-y rounded-md bg-muted/20 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
			<StatCell icon={Sparkles} label="Skills" value={skillCount} />
			<StatCell icon={KeyRound} label="Vaults" value={vaultCount} />
		</div>
	);
}

function StatCell({
	icon: Icon,
	label,
	value,
}: {
	icon: LucideIcon;
	label: string;
	value: number;
}) {
	return (
		<div className="flex items-center justify-between gap-3 px-4 py-3">
			<div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
				<Icon className="size-4 shrink-0" />
				<span className="truncate">{label}</span>
			</div>
			<div className="text-xl font-semibold">{value}</div>
		</div>
	);
}

function ContentHeader({
	title,
	description,
	action,
}: {
	title: string;
	description: string;
	action?: ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-start justify-between gap-3">
			<div className="space-y-1">
				<h2 className="text-base font-semibold">{title}</h2>
				<p className="text-xs text-muted-foreground">{description}</p>
			</div>
			{action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
		</div>
	);
}

function ProjectResourceLinks({ projectId }: { projectId: string }) {
	return (
		<>
			{projectManagedResourceDefinitions().map((resource) => {
				return (
					<Button asChild key={resource.id} variant="outline" size="sm">
						<Link
							href={projectResourceHref(resource.id, projectId)}
							title={projectResourcePathLabel(resource)}
						>
							<ExternalLink className="mr-1.5 size-3.5" />
							{resource.label}
						</Link>
					</Button>
				);
			})}
		</>
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
			toast.success("Skill Installed", { description: "Saved in this Project." });
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
					Install Skill
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
					params: { query: { project_id: projectId } },
					body: { slug: nextSlug, name: nextSlug },
				}),
			),
		onSuccess: () => {
			setSlug("");
			onChanged();
			toast.success("Vault Created", { description: "Available in this Project." });
		},
		onError: (e) => toast.error("Failed to Create Vault", { description: errorMessage(e) }),
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

function SkillRow({ skill, ownProjectId }: { skill: SkillSummary; ownProjectId: string }) {
	const savedHere = skill.project_id === ownProjectId;
	return (
		<div className="flex items-center justify-between gap-3 p-3">
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<span className="truncate text-sm font-medium">{skill.name}</span>
					<Badge variant={savedHere ? "secondary" : "outline"}>
						{savedHere ? "Saved Here" : "Linked"}
					</Badge>
				</div>
				<div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
					{skill.skill_key}
				</div>
			</div>
			<Button asChild variant="ghost" size="icon-sm">
				<Link
					href={skillDetailHref(skill.skill_key, skill.project_id ?? ownProjectId)}
					aria-label={`Open ${skill.name}`}
				>
					<ExternalLink className="size-3.5" />
				</Link>
			</Button>
		</div>
	);
}

function VaultRow({ vault, ownProjectId }: { vault: VaultSummary; ownProjectId: string }) {
	const savedHere = vault.project_id === ownProjectId;
	return (
		<div className="flex items-center justify-between gap-3 p-3">
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<span className="truncate text-sm font-medium">{vault.name}</span>
					<Badge variant={savedHere ? "secondary" : "outline"}>
						{savedHere ? "Available Here" : "Linked"}
					</Badge>
				</div>
				<div className="mt-0.5 font-mono text-xs text-muted-foreground">{vault.slug}</div>
			</div>
			<Button asChild variant="ghost" size="icon-sm">
				<Link
					href={projectResourceHref("vaults", vault.project_id ?? ownProjectId)}
					aria-label="Open vault page"
				>
					<ExternalLink className="size-3.5" />
				</Link>
			</Button>
		</div>
	);
}

function compareEnvironmentsForUse(a: Env, b: Env) {
	const timestamp = (env: Env) =>
		new Date(env.last_sync_at ?? env.last_seen_at ?? "1970-01-01T00:00:00.000Z").getTime();
	return timestamp(b) - timestamp(a);
}

function displayAgentName(env: Env) {
	return cleanMachineName(env.machine_name) || agentTypeLabel(env.agent_type);
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
