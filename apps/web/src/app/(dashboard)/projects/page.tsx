"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowRight,
	Bot,
	FolderKanban,
	type LucideIcon,
	Plus,
	Settings2,
	Share2,
	Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import {
	displayProjectName,
	isCustomProject,
	isManagedProject,
	type ProjectAgentMetadata,
	ProjectIdentity,
	projectAgentFor,
} from "@/components/projects/project-metadata";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
import { formatApiError } from "@/components/sharing/vault-conflicts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, unwrap, useApi, useAuthedFetch } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { getProjectResourceDefinition, projectDetailHref } from "@/lib/project-resource-model";
import { cn, errorMessage } from "@/lib/utils";

type Env = components["schemas"]["EnvironmentResponse"];

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

const PROJECTS_RESOURCE = getProjectResourceDefinition("projects");

export default function ProjectsPage() {
	const api = useApi();
	const authedFetch = useAuthedFetch();
	const qc = useQueryClient();
	const router = useRouter();
	const [newProjectName, setNewProjectName] = useState("");
	const [newProjectSlug, setNewProjectSlug] = useState("");
	const [createOpen, setCreateOpen] = useState(false);
	const [customProjectSearch, setCustomProjectSearch] = useState("");

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => {
			const r = await authedFetch("/api/projects");
			return r.json();
		},
	});

	const rows = projects.data ?? [];
	const environments = useQuery({
		queryKey: ["environments"],
		queryFn: async (): Promise<Env[]> => unwrap(await api.GET("/api/environments")),
		enabled: rows.some((project) => project.kind === "environment"),
	});
	const agentsById = useMemo(
		() => new Map((environments.data ?? []).map((agent) => [agent.id, agent])),
		[environments.data],
	);
	const ownedProjects = useMemo(
		() => rows.filter((s) => s.is_owner !== false).sort(compareProjectsForProductUse),
		[rows],
	);
	const sharedProjects = useMemo(
		() =>
			rows
				.filter((project) => project.is_owner === false && isCustomProject(project))
				.sort(compareProjectsForProductUse),
		[rows],
	);
	const customProjects = useMemo(() => ownedProjects.filter(isCustomProject), [ownedProjects]);
	const managedProjects = useMemo(() => ownedProjects.filter(isManagedProject), [ownedProjects]);
	const otherOwnedProjects = useMemo(
		() =>
			ownedProjects.filter(
				(project) => !isCustomProject(project) && !isManagedProject(project) && !!project.kind,
			),
		[ownedProjects],
	);
	const filteredCustomProjects = useMemo(
		() => filterProjects(customProjects, customProjectSearch, agentsById),
		[customProjects, customProjectSearch, agentsById],
	);

	const createProject = useMutation({
		mutationFn: async (): Promise<ProjectRow> => {
			const payload: { name: string; slug?: string } = { name: newProjectName.trim() };
			const slug = normalizeSlugInput(newProjectSlug);
			if (slug) payload.slug = slug;
			const r = await authedFetch("/api/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			return r.json();
		},
		onSuccess: (project) => {
			setNewProjectName("");
			setNewProjectSlug("");
			setCreateOpen(false);
			qc.invalidateQueries({ queryKey: ["projects"] });
			toast.success("Project Created", {
				description: `${project.name} is ready for skills, vaults, and sharing.`,
			});
			router.push(projectDetailHref(project.id));
		},
		onError: (e) => {
			toast.error("Failed to Create Project", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	const openCreateDialog = () => {
		setNewProjectName("");
		setNewProjectSlug("");
		setCreateOpen(true);
	};

	if (projects.isLoading) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<PageHeader title="Projects" description={PROJECTS_RESOURCE.managementDescription} />
				<Skeleton className="h-36 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader title="Projects" description={PROJECTS_RESOURCE.managementDescription} />

			{projects.error ? (
				<Alert variant="destructive">
					<AlertTitle>Couldn&apos;t load projects</AlertTitle>
					<AlertDescription>{errorMessage(projects.error)}</AlertDescription>
				</Alert>
			) : null}

			<Dialog
				open={createOpen}
				onOpenChange={(open) => {
					setCreateOpen(open);
					if (!open) {
						setNewProjectName("");
						setNewProjectSlug("");
					}
				}}
			>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>New Custom Project</DialogTitle>
						<DialogDescription>
							Create a Custom Project for a team, workflow, repo, or shareable resources. Add
							skills, vaults, and sharing settings after it is created.
						</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (!newProjectName.trim() || createProject.isPending) return;
							createProject.mutate();
						}}
					>
						<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
							<div className="space-y-1.5">
								<Label htmlFor="project-name">Name</Label>
								<Input
									id="project-name"
									name="project-name"
									value={newProjectName}
									maxLength={200}
									placeholder="Project name…"
									autoComplete="off"
									onChange={(event) => setNewProjectName(event.target.value)}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="project-slug">Slug</Label>
								<Input
									id="project-slug"
									name="project-slug"
									value={newProjectSlug}
									maxLength={80}
									placeholder="auto-generated…"
									autoComplete="off"
									spellCheck={false}
									onChange={(event) => setNewProjectSlug(normalizeSlugDraft(event.target.value))}
								/>
							</div>
						</div>
						<div className="flex justify-end gap-2">
							<Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={!newProjectName.trim() || createProject.isPending}
								variant={newProjectName.trim() ? "default" : "outline"}
							>
								<Plus className="size-3.5" />
								{createProject.isPending ? "Creating…" : "Create Custom Project"}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>

			<ProjectGroupSection
				icon={FolderKanban}
				title="Custom Projects"
				count={
					customProjectSearch.trim()
						? `${filteredCustomProjects.length}/${customProjects.length}`
						: customProjects.length
				}
				description="Projects you create for workflows, teams, repos, or resources you want to share."
				projects={filteredCustomProjects}
				agentsById={agentsById}
				emptyTitle={
					customProjectSearch.trim()
						? "No Matching Custom Projects"
						: "Create Your First Custom Project"
				}
				emptyMessage={
					customProjectSearch.trim()
						? "Try a different Project name, slug, or owner."
						: "Use Custom Projects for resources you want to share or reuse across people and agents."
				}
				toolbar={
					<>
						<SearchInput
							value={customProjectSearch}
							onChange={setCustomProjectSearch}
							placeholder="Search custom projects…"
							className="w-full sm:w-64"
						/>
						<NewProjectButton onClick={openCreateDialog} />
					</>
				}
				priority="primary"
			/>

			<ProjectGroupSection
				icon={Settings2}
				title="Managed Projects"
				count={managedProjects.length}
				description="Global and Agent Projects are managed for you. They are not shareable; use Custom Projects for collaboration."
				projects={managedProjects}
				agentsById={agentsById}
				emptyTitle="No Managed Projects"
				emptyMessage="Your Global Project and Agent Projects appear here when they exist."
				priority="secondary"
			/>

			{otherOwnedProjects.length > 0 ? (
				<ProjectGroupSection
					icon={FolderKanban}
					title="Other Projects"
					count={otherOwnedProjects.length}
					description="Projects with a newer type that this UI does not classify yet."
					projects={otherOwnedProjects}
					agentsById={agentsById}
					emptyTitle=""
					emptyMessage=""
					priority="quiet"
				/>
			) : null}

			<section className="overflow-hidden rounded-lg border bg-card/60">
				<SectionHeader
					icon={Users}
					title="Shared With Me"
					count={sharedProjects.length}
					description="Custom Projects other people shared with you. Open one or attach it to an agent when needed."
					priority="quiet"
				/>
				{sharedProjects.length === 0 ? (
					<EmptyLine
						title="No Shared Projects Yet"
						message="Accepted invites and share links appear here with Viewer access. Pending invites are in the inbox in the top bar."
					/>
				) : (
					<div className="divide-y">
						{sharedProjects.map((project) => (
							<SharedProjectRow
								key={project.id}
								project={project}
								agent={projectAgentFor(project, agentsById)}
							/>
						))}
					</div>
				)}
			</section>
		</div>
	);
}

function ProjectGroupSection({
	icon,
	title,
	count,
	description,
	projects,
	agentsById,
	emptyTitle,
	emptyMessage,
	toolbar,
	compact = false,
	priority = "secondary",
}: {
	icon: LucideIcon;
	title: string;
	count: React.ReactNode;
	description: string;
	projects: ProjectRow[];
	agentsById: ReadonlyMap<string, ProjectAgentMetadata>;
	emptyTitle: string;
	emptyMessage: string;
	toolbar?: React.ReactNode;
	compact?: boolean;
	priority?: ProjectSectionPriority;
}) {
	return (
		<section
			className={cn(
				"overflow-hidden rounded-lg border bg-card/60",
				priority === "primary" && "border-foreground/15 bg-card",
			)}
		>
			<SectionHeader
				icon={icon}
				title={title}
				count={count}
				description={description}
				toolbar={toolbar}
				priority={priority}
			/>
			{projects.length === 0 ? (
				<EmptyLine title={emptyTitle} message={emptyMessage} />
			) : (
				<div className="divide-y">
					{projects.map((project) => (
						<OwnedProjectRow
							key={project.id}
							project={project}
							agent={projectAgentFor(project, agentsById)}
							compact={compact}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function OwnedProjectRow({
	project,
	agent,
	compact = false,
}: {
	project: ProjectRow;
	agent?: ProjectAgentMetadata | null;
	compact?: boolean;
}) {
	const projectName = displayProjectName(project);
	const canShare = isCustomProject(project);
	return (
		<div className="group px-4 py-4 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-muted/20">
			<div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
				<div className="min-w-0">
					<ProjectIdentity project={project} agent={agent} showOwner={false} showAccess={false} />
					{compact ? null : (
						<p className="mt-1 pl-9 text-xs text-muted-foreground">
							{ownedProjectDescription(project)}
						</p>
					)}
				</div>
				<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
					<Button asChild variant="outline" size="sm">
						<Link href={projectDetailHref(project.id)}>
							Open
							<ArrowRight className="size-3.5" />
						</Link>
					</Button>
					{canShare ? (
						<ShareProjectDialog
							projectId={project.id}
							projectName={projectName}
							projectKind={project.kind}
						>
							<Button variant="outline" size="sm" aria-label={`Share ${projectName}`}>
								<Share2 className="mr-1.5 size-3.5" />
								Share
							</Button>
						</ShareProjectDialog>
					) : null}
				</div>
			</div>
		</div>
	);
}

function SharedProjectRow({
	project,
	agent,
}: {
	project: ProjectRow;
	agent?: ProjectAgentMetadata | null;
}) {
	return (
		<div className="group px-4 py-4 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-muted/20">
			<div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
				<div className="min-w-0">
					<ProjectIdentity project={project} agent={agent} />
					<p className="mt-1 pl-9 text-xs text-muted-foreground">
						Viewer access is read-only. Attach it to an agent when you choose.
					</p>
				</div>
				<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
					<Button asChild variant="outline" size="sm">
						<Link href={projectDetailHref(project.id)}>
							Open
							<ArrowRight className="size-3.5" />
						</Link>
					</Button>
					<Button asChild variant="outline" size="sm">
						<Link href={`${projectDetailHref(project.id)}?useWithAgent=1`}>
							<Bot className="mr-1.5 size-3.5" />
							Attach to Agent
						</Link>
					</Button>
				</div>
			</div>
		</div>
	);
}

function SectionHeader({
	icon: Icon,
	title,
	count,
	description,
	toolbar,
	priority = "secondary",
}: {
	icon: LucideIcon;
	title: string;
	count: React.ReactNode;
	description: string;
	toolbar?: React.ReactNode;
	priority?: ProjectSectionPriority;
}) {
	return (
		<div
			className={cn(
				"flex flex-col gap-3 border-b px-4 py-4 sm:flex-row sm:items-start sm:justify-between",
				priority === "quiet" && "bg-muted/15",
				priority === "primary" && "bg-muted/25",
			)}
		>
			<div className="min-w-0 space-y-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
						<Icon className="size-3.5" />
					</span>
					<h2 className="truncate text-base font-semibold">{title}</h2>
					<Badge variant="secondary" className="text-xs">
						{count}
					</Badge>
				</div>
				<p className="max-w-3xl text-xs text-muted-foreground">{description}</p>
			</div>
			{toolbar ? (
				<div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-0 sm:flex-row sm:items-center">
					{toolbar}
				</div>
			) : null}
		</div>
	);
}

type ProjectSectionPriority = "primary" | "secondary" | "quiet";

function NewProjectButton({ onClick }: { onClick: () => void }) {
	return (
		<Button size="sm" variant="outline" onClick={onClick}>
			<Plus className="size-3.5" />
			New Custom Project
		</Button>
	);
}

function normalizeSlugInput(value: string) {
	return normalizeSlugDraft(value).replace(/-+$/, "");
}

function normalizeSlugDraft(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+/, "");
}

function compareProjectsForProductUse(a: ProjectRow, b: ProjectRow) {
	const rank = (kind: string) =>
		kind === "workspace" ? 0 : kind === "personal" ? 1 : kind === "environment" ? 2 : 3;
	const byRank = rank(a.kind) - rank(b.kind);
	if (byRank !== 0) return byRank;
	return a.name.localeCompare(b.name);
}

function filterProjects(
	projects: ProjectRow[],
	query: string,
	agentsById: ReadonlyMap<string, ProjectAgentMetadata>,
) {
	const q = query.trim().toLowerCase();
	if (!q) return projects;
	return projects.filter((project) => {
		const agent = projectAgentFor(project, agentsById);
		return [
			displayProjectName(project),
			project.slug,
			project.owner_display ?? "",
			project.owner_handle ?? "",
			agent?.machine_name ?? "",
			agent?.agent_type ?? "",
		]
			.join(" ")
			.toLowerCase()
			.includes(q);
	});
}

function ownedProjectDescription(project: ProjectRow) {
	if (project.kind === "personal") {
		return "Managed Project. Account default for resources that are not tied to one custom workflow or one agent.";
	}
	if (project.kind === "environment") {
		return "Managed Project. Writable default for one connected agent.";
	}
	if (project.kind === "workspace") {
		return "Custom Project. Add skills and vaults, invite people, share links, and attach it to agents.";
	}
	return "You own this Project. Open it to review resources.";
}

function EmptyLine({ title, message }: { title: string; message: string }) {
	return (
		<div className="rounded-lg border border-dashed px-4 py-6">
			<div className="space-y-1">
				<h3 className="text-sm font-medium">{title}</h3>
				<p className="max-w-2xl text-sm text-muted-foreground">{message}</p>
			</div>
		</div>
	);
}
