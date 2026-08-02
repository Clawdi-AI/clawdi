"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ChevronDown, Plus, Share2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import {
	displayProjectName,
	isCustomProject,
	type ProjectAgentMetadata,
	projectAgentFor,
	projectAgentLabel,
	projectKindSortRank,
} from "@/components/projects/project-metadata";
import {
	ProjectResourceCard,
	ProjectResourceCardSkeleton,
} from "@/components/projects/project-resource-card";
import { SectionLabel } from "@/components/section-label";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
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
import { ApiError, unwrap, useApi, useOpenApi } from "@/lib/api";
import { formatApiError } from "@/lib/api-errors";
import { fetchAllPages } from "@/lib/api-pagination";
import type { components } from "@/lib/api-schemas";
import { getProjectResourceDefinition, projectDetailHref } from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn, errorMessage } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type ProjectCreate = components["schemas"]["ProjectCreate"];
type ProjectRow = components["schemas"]["ProjectResponse"];
type CountValue = number | "unavailable";

const PROJECTS_RESOURCE = getProjectResourceDefinition("projects");

export default function ProjectsPage() {
	const api = useApi();
	const $api = useOpenApi();
	const qc = useQueryClient();
	const router = useRouter();
	const [newProjectName, setNewProjectName] = useState("");
	const [newProjectSlug, setNewProjectSlug] = useState("");
	const [createOpen, setCreateOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [systemOpen, setSystemOpen] = useState(false);

	const projects = $api.useQuery(
		"get",
		"/v1/projects",
		{},
		{
			placeholderData: keepPreviousData,
		},
	);

	const rows = projects.data ?? [];
	const environments = $api.useQuery(
		"get",
		"/v1/agents",
		{},
		{
			enabled: rows.some((project) => project.kind === "environment"),
		},
	);
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
					unwrap(await api.GET("/v1/skills", { params: { query: { page, page_size: pageSize } } })),
				{ pageSize: 200, resourceName: "skills" },
			),
		placeholderData: keepPreviousData,
	});
	const vaults = $api.useQuery(
		"get",
		"/v1/vault",
		{
			params: { query: { page_size: 200 } },
		},
		{
			placeholderData: keepPreviousData,
		},
	);
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
	const skillCountsUnavailable = shouldBlockQueryError(skills.error, skills.data);
	const vaultCountsUnavailable = shouldBlockQueryError(vaults.error, vaults.data);

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

	const createProject = $api.useMutation("post", "/v1/projects", {
		onSuccess: (project) => {
			setCreateOpen(false);
			qc.invalidateQueries({ queryKey: ["get", "/v1/projects"] });
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
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6")}>
				<PageHeader title="Projects" description={PROJECTS_RESOURCE.managementDescription} />
				<div className={HERO_GRID_CLASS}>
					{Array.from({ length: 6 }).map((_, i) => (
						<ProjectResourceCardSkeleton key={i} />
					))}
				</div>
			</div>
		);
	}

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6")}>
			<PageHeader title="Projects" description={PROJECTS_RESOURCE.managementDescription} />

			<ListToolbar
				search={<SearchInput value={search} onChange={setSearch} placeholder="Search projects…" />}
				actions={
					<Button size="sm" onClick={openCreateDialog}>
						<Plus className="size-3.5" />
						New project
					</Button>
				}
			/>

			{shouldBlockQueryError(projects.error, projects.data) ? (
				<ApiErrorPanel
					error={projects.error}
					onRetry={() => {
						void projects.refetch();
					}}
					title="Couldn't load projects"
				/>
			) : null}

			<Dialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				onOpenChangeComplete={(open) => {
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
							const body: ProjectCreate = { name: newProjectName.trim() };
							const slug = normalizeSlugInput(newProjectSlug);
							if (slug) body.slug = slug;
							createProject.mutate({ body });
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
				<div className={HERO_GRID_CLASS} data-testid="project-grid">
					{gridProjects.map(({ project, shared }) => (
						<ProjectResourceCard
							key={project.id}
							project={project}
							footer={[
								formatCountLabel(
									skillCountsUnavailable ? "unavailable" : (skillCounts.get(project.id) ?? 0),
									"skill",
								),
								formatCountLabel(
									vaultCountsUnavailable ? "unavailable" : (vaultCounts.get(project.id) ?? 0),
									"vault",
								),
								shared && project.owner_display ? `by ${project.owner_display}` : null,
							]}
							actions={
								!shared && isCustomProject(project) ? (
									<ProjectShareAction project={project} />
								) : null
							}
						/>
					))}
				</div>
			)}

			{systemProjects.length > 0 ? (
				<section className="space-y-2">
					<button
						type="button"
						onClick={() => setSystemOpen((v) => !v)}
						className="flex w-full items-start gap-1.5 text-left text-muted-foreground transition-colors hover:text-foreground"
						aria-expanded={systemOpen}
					>
						<ChevronDown
							className={cn(
								"mt-0.5 size-4 shrink-0 transition-transform duration-150",
								!systemOpen && "-rotate-90",
							)}
						/>
						<span className="min-w-0">
							<SectionLabel className="px-0" count={systemProjects.length}>
								System projects
							</SectionLabel>
							<span className="block text-xs">
								Account default and one per connected agent — managed automatically
							</span>
						</span>
					</button>
					{systemOpen ? (
						<div className={HERO_GRID_CLASS}>
							{systemProjects.map((project) => (
								<SystemProjectCard
									key={project.id}
									project={project}
									agent={projectAgentFor(project, agentsById)}
									skillCount={
										skillCountsUnavailable ? "unavailable" : (skillCounts.get(project.id) ?? 0)
									}
									vaultCount={
										vaultCountsUnavailable ? "unavailable" : (vaultCounts.get(project.id) ?? 0)
									}
								/>
							))}
						</div>
					) : null}
				</section>
			) : null}
		</div>
	);
}

function SystemProjectCard({
	project,
	agent,
	skillCount,
	vaultCount,
}: {
	project: ProjectRow;
	agent: ProjectAgentMetadata | null;
	skillCount: CountValue;
	vaultCount: CountValue;
}) {
	return (
		<ProjectResourceCard
			project={project}
			showKind
			footer={[
				formatCountLabel(skillCount, "skill"),
				formatCountLabel(vaultCount, "vault"),
				project.kind === "environment" && agent ? `Agent: ${projectAgentLabel(agent)}` : null,
			]}
		/>
	);
}

function ProjectShareAction({ project }: { project: ProjectRow }) {
	const projectName = displayProjectName(project);
	return (
		<div className="opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
			<ShareProjectDialog
				projectId={project.id}
				projectName={projectName}
				projectKind={project.kind}
			>
				<Button variant="ghost" size="icon-sm" aria-label={`Share ${projectName}`}>
					<Share2 className="size-3.5" />
				</Button>
			</ShareProjectDialog>
		</div>
	);
}

function normalizeSlugInput(value: string) {
	return normalizeSlugDraft(value).replace(/-+$/, "");
}

function formatCountLabel(value: CountValue, noun: string) {
	if (value === "unavailable") return `— ${noun}s`;
	return `${value} ${value === 1 ? noun : `${noun}s`}`;
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
