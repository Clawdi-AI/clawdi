"use client";

import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Plus, Share2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { displayProjectName, isCustomProject } from "@/components/projects/project-metadata";
import {
	ProjectResourceCard,
	ProjectResourceCardSkeleton,
} from "@/components/projects/project-resource-card";
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
import { ApiError, useOpenApi } from "@/lib/api";
import { formatApiError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";
import { getProjectResourceDefinition, projectDetailHref } from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn, errorMessage } from "@/lib/utils";

type ProjectCreate = components["schemas"]["ProjectCreate"];
type ProjectRow = components["schemas"]["ProjectResponse"];

const PROJECTS_RESOURCE = getProjectResourceDefinition("projects");

export default function ProjectsPage() {
	const $api = useOpenApi();
	const qc = useQueryClient();
	const router = useRouter();
	const [newProjectName, setNewProjectName] = useState("");
	const [newProjectSlug, setNewProjectSlug] = useState("");
	const [newProjectDescription, setNewProjectDescription] = useState("");
	const [createOpen, setCreateOpen] = useState(false);
	const [search, setSearch] = useState("");

	const projects = $api.useQuery(
		"get",
		"/v1/projects",
		{},
		{
			placeholderData: keepPreviousData,
		},
	);

	const rows = projects.data ?? [];

	const ownedProjects = useMemo(() => rows.filter((s) => s.is_owner !== false), [rows]);
	const sharedProjects = useMemo(
		() =>
			rows
				.filter((project) => project.is_owner === false && isCustomProject(project))
				.sort(compareProjectsForProductUse),
		[rows],
	);
	const customProjects = useMemo(
		() => ownedProjects.filter(isCustomProject).sort(compareProjectsForProductUse),
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
			toast.success("Project created");
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
		setNewProjectDescription("");
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
						Create Project
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
						setNewProjectDescription("");
					}
				}}
			>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>Create Project</DialogTitle>
						<DialogDescription>
							Create a shareable resource bundle for a team, workflow, or repository. Add Skills,
							attach Vaults, then link the whole Project to Agents that should use it.
						</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (!newProjectName.trim() || createProject.isPending) return;
							const body: ProjectCreate = {
								name: newProjectName.trim(),
								description: newProjectDescription.trim() || null,
							};
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
						<div className="space-y-1.5">
							<Label htmlFor="project-description">Description</Label>
							<Input
								id="project-description"
								name="project-description"
								value={newProjectDescription}
								maxLength={2000}
								placeholder="What should Agents use this Project for?"
								autoComplete="off"
								onChange={(event) => setNewProjectDescription(event.target.value)}
							/>
						</div>
						<div className="flex justify-end gap-2">
							<Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!newProjectName.trim() || createProject.isPending}>
								<Plus className="size-3.5" />
								{createProject.isPending ? "Creating…" : "Create Project"}
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
								formatCountLabel(project.skill_count, "skill"),
								formatCountLabel(project.vault_count, "vault"),
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
		</div>
	);
}

function ProjectShareAction({ project }: { project: ProjectRow }) {
	const projectName = displayProjectName(project);
	return (
		<div className="opacity-100 transition-opacity duration-150 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
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

function formatCountLabel(value: number, noun: string) {
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
	return a.name.localeCompare(b.name);
}
