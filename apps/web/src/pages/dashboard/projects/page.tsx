"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { ChevronDown, Key, Plus, Share2, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import {
	displayProjectName,
	isCustomProject,
	type ProjectAgentMetadata,
	ProjectIdentity,
	projectAgentFor,
	projectKindSortRank,
} from "@/components/projects/project-metadata";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
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
import { ApiError, unwrap, useApi } from "@/lib/api";
import { formatApiError } from "@/lib/api-errors";
import { fetchAllPages } from "@/lib/api-pagination";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { getProjectResourceDefinition, projectDetailHref } from "@/lib/project-resource-model";
import { cn, errorMessage } from "@/lib/utils";

type Env = components["schemas"]["EnvironmentResponse"];
type SkillSummary = components["schemas"]["SkillSummaryResponse"];

type ProjectRow = components["schemas"]["ProjectResponse"];

const PROJECTS_RESOURCE = getProjectResourceDefinition("projects");

export default function ProjectsPage() {
	const api = useApi();
	const qc = useQueryClient();
	const router = useRouter();
	const [newProjectName, setNewProjectName] = useState("");
	const [newProjectSlug, setNewProjectSlug] = useState("");
	const [createOpen, setCreateOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [systemOpen, setSystemOpen] = useState(false);

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => unwrap(await api.GET("/api/projects")),
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

	// Per-project resource counts for the cards. Shares the skills cache with
	// the Skills page (same queryKey); vault list carries project_ids.
	const skills = useQuery({
		queryKey: ["skills", "all-projects"],
		queryFn: async () =>
			fetchAllPages<SkillSummary>(
				async (page, pageSize) =>
					unwrap(
						await api.GET("/api/skills", { params: { query: { page, page_size: pageSize } } }),
					),
				{ pageSize: 200, resourceName: "skills" },
			),
	});
	const vaults = useQuery({
		queryKey: ["vaults", "all"],
		queryFn: async () =>
			unwrap(await api.GET("/api/vault", { params: { query: { page_size: 200 } } })),
	});
	const skillCounts = useMemo(() => {
		const m = new Map<string, number>();
		for (const s of skills.data?.items ?? []) {
			if (s.project_id) m.set(s.project_id, (m.get(s.project_id) ?? 0) + 1);
		}
		return m;
	}, [skills.data]);
	const vaultCounts = useMemo(() => {
		const m = new Map<string, number>();
		for (const v of vaults.data?.items ?? []) {
			for (const pid of v.project_ids ?? []) m.set(pid, (m.get(pid) ?? 0) + 1);
		}
		return m;
	}, [vaults.data]);

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
	// "System projects": account default (personal/Global) + per-agent managed
	// projects + anything this UI version doesn't classify. Collapsed by
	// default — visible enough for CLI users, quiet enough to keep the card
	// grid about the user's own work.
	const systemProjects = useMemo(
		() => ownedProjects.filter((project) => !isCustomProject(project)),
		[ownedProjects],
	);

	const gridProjects = useMemo(() => {
		const all = [
			...customProjects.map((project) => ({ project, shared: false })),
			...sharedProjects.map((project) => ({ project, shared: true })),
		];
		const q = search.trim().toLowerCase();
		if (!q) return all;
		return all.filter(({ project }) =>
			[displayProjectName(project), project.slug, project.owner_display ?? ""]
				.join(" ")
				.toLowerCase()
				.includes(q),
		);
	}, [customProjects, sharedProjects, search]);

	const createProject = useMutation({
		mutationFn: async (): Promise<ProjectRow> => {
			const payload: { name: string; slug?: string } = { name: newProjectName.trim() };
			const slug = normalizeSlugInput(newProjectSlug);
			if (slug) payload.slug = slug;
			return unwrap(await api.POST("/api/projects", { body: payload }));
		},
		onSuccess: (project) => {
			setNewProjectName("");
			setNewProjectSlug("");
			setCreateOpen(false);
			qc.invalidateQueries({ queryKey: ["projects"] });
			toast.success("Project created", {
				description: `${project.name} is ready for skills, vaults, and sharing.`,
			});
			void router.navigate({ href: projectDetailHref(project.id) });
		},
		onError: (e) => {
			toast.error("Couldn't create project", {
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
			<div className="space-y-6 px-4 lg:px-6">
				<PageHeader title="Projects" description={PROJECTS_RESOURCE.managementDescription} />
				<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
					{Array.from({ length: 6 }).map((_, i) => (
						<Skeleton key={i} className="h-40 w-full rounded-xl" />
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6 px-4 lg:px-6">
			<PageHeader
				title="Projects"
				description={PROJECTS_RESOURCE.managementDescription}
				actions={
					<>
						<SearchInput
							value={search}
							onChange={setSearch}
							placeholder="Search projects…"
							className="w-full sm:w-56"
						/>
						<Button size="sm" onClick={openCreateDialog}>
							<Plus className="size-3.5" />
							New project
						</Button>
					</>
				}
			/>

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
						<DialogTitle>New project</DialogTitle>
						<DialogDescription>
							Create a Project for a team, workflow, repo, or shareable resources. Add skills,
							vaults, and sharing settings after it is created.
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
								{createProject.isPending ? "Creating…" : "Create project"}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>

			{gridProjects.length === 0 && search.trim() ? (
				<p className="py-12 text-center text-sm text-muted-foreground">
					No projects match “{search.trim()}”.
				</p>
			) : (
				<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
					{gridProjects.map(({ project, shared }) => (
						<ProjectCard
							key={project.id}
							project={project}
							shared={shared}
							skillCount={skillCounts.get(project.id) ?? 0}
							vaultCount={vaultCounts.get(project.id) ?? 0}
						/>
					))}
					{!search.trim() ? <NewProjectCard onClick={openCreateDialog} /> : null}
				</div>
			)}

			{systemProjects.length > 0 ? (
				<section className="space-y-2">
					<button
						type="button"
						onClick={() => setSystemOpen((v) => !v)}
						className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
						aria-expanded={systemOpen}
					>
						<ChevronDown
							className={cn(
								"size-4 transition-transform duration-150",
								!systemOpen && "-rotate-90",
							)}
						/>
						System projects
						<Badge variant="secondary" className="tabular-nums">
							{systemProjects.length}
						</Badge>
						<span className="ml-1 font-normal text-xs">
							account default and one per connected agent — managed automatically
						</span>
					</button>
					{systemOpen ? (
						<div className="divide-y overflow-hidden rounded-lg border bg-card">
							{systemProjects.map((project) => (
								<SystemProjectRow
									key={project.id}
									project={project}
									agent={projectAgentFor(project, agentsById)}
									skillCount={skillCounts.get(project.id) ?? 0}
									vaultCount={vaultCounts.get(project.id) ?? 0}
								/>
							))}
						</div>
					) : null}
				</section>
			) : null}
		</div>
	);
}

function ProjectCard({
	project,
	shared,
	skillCount,
	vaultCount,
}: {
	project: ProjectRow;
	shared: boolean;
	skillCount: number;
	vaultCount: number;
}) {
	const projectName = displayProjectName(project);
	return (
		<div className="group relative z-0 flex min-h-36 flex-col gap-3 rounded-xl border bg-card p-5 transition-all duration-150 hover:-translate-y-px hover:border-foreground/20">
			<div className="flex items-start justify-between gap-2">
				<span
					className={cn(
						"flex size-10 shrink-0 select-none items-center justify-center rounded-lg text-xl leading-none",
						identityFor(projectName).colorClasses,
					)}
				>
					{identityFor(projectName).emoji}
				</span>
				{!shared && isCustomProject(project) ? (
					<span className="relative z-10 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
						<ShareProjectDialog
							projectId={project.id}
							projectName={projectName}
							projectKind={project.kind}
						>
							<Button variant="ghost" size="icon-sm" aria-label={`Share ${projectName}`}>
								<Share2 className="size-3.5" />
							</Button>
						</ShareProjectDialog>
					</span>
				) : null}
			</div>
			<div className="min-w-0">
				<div className="flex min-w-0 items-center gap-2">
					<h3 className="truncate text-base font-semibold tracking-tight">{projectName}</h3>
					{shared ? <StatusChip>Shared with you</StatusChip> : null}
				</div>
				<p className="truncate font-mono text-xs text-muted-foreground">{project.slug}</p>
			</div>
			<div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
				<span className="inline-flex items-center gap-1">
					<Sparkles className="size-3" />
					{skillCount} {skillCount === 1 ? "skill" : "skills"}
				</span>
				<span className="inline-flex items-center gap-1">
					<Key className="size-3" />
					{vaultCount} {vaultCount === 1 ? "vault" : "vaults"}
				</span>
				{shared && project.owner_display ? (
					<span className="truncate">by {project.owner_display}</span>
				) : null}
			</div>
			<Link
				to="/projects/$id"
				params={{ id: project.id }}
				className="absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span className="sr-only">Open {projectName}</span>
			</Link>
		</div>
	);
}

function StatusChip({ children }: { children: React.ReactNode }) {
	return (
		<span className="shrink-0 rounded-sm bg-info-muted px-1.5 py-0.5 text-[11px] font-medium text-info-muted-foreground">
			{children}
		</span>
	);
}

function NewProjectCard({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-muted-foreground transition-colors duration-150 hover:border-foreground/25 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus:outline-none"
		>
			<span className="flex size-9 items-center justify-center rounded-lg bg-muted">
				<Plus className="size-4" />
			</span>
			<span className="text-sm font-medium">New project</span>
		</button>
	);
}

function SystemProjectRow({
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
	const isGlobal = project.kind === "personal";
	return (
		<div className="group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/20">
			<span
				className={cn(
					"flex size-7 shrink-0 select-none items-center justify-center rounded-md text-sm leading-none",
					identityFor(displayProjectName(project)).colorClasses,
				)}
			>
				{isGlobal ? "🌐" : identityFor(displayProjectName(project)).emoji}
			</span>
			<div className="min-w-0 flex-1">
				<ProjectIdentity
					project={project}
					agent={agent}
					showOwner={false}
					showAccess={false}
					showIcon={false}
				/>
			</div>
			<span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline">
				{skillCount} skills · {vaultCount} vaults
			</span>
			<Link
				to="/projects/$id"
				params={{ id: project.id }}
				className="absolute inset-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span className="sr-only">Open {displayProjectName(project)}</span>
			</Link>
		</div>
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
	const byRank = projectKindSortRank(a.kind) - projectKindSortRank(b.kind);
	if (byRank !== 0) return byRank;
	return a.name.localeCompare(b.name);
}
