"use client";

import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Plus, Share2 } from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
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
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchInput } from "@/components/ui/search-input";
import { Textarea } from "@/components/ui/textarea";
import { useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";
import {
	formatResourceCount,
	getProjectResourceDefinition,
	projectDetailHref,
} from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";

type ProjectCreate = components["schemas"]["ProjectCreate"];
type ProjectRow = components["schemas"]["ProjectResponse"];

const PROJECTS_RESOURCE = getProjectResourceDefinition("projects");

export default function ProjectsPage() {
	const $api = useOpenApi();
	const qc = useQueryClient();
	const router = useRouter();
	const [newProjectName, setNewProjectName] = useState("");
	const [newProjectDescription, setNewProjectDescription] = useState("");
	const [createOpen, setCreateOpen] = useState(false);
	// URL-backed like the other lists: open a project and come back with the
	// filter text intact.
	const [search, setSearch] = useQueryState(
		"q",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true, history: "replace" }),
	);

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
	const blockingProjectsError = shouldBlockQueryError(projects.error, projects.data);

	const createProject = $api.useMutation("post", "/v1/projects", {
		onSuccess: (project) => {
			setCreateOpen(false);
			qc.invalidateQueries({ queryKey: ["get", "/v1/projects"] });
			toast.success("Project created");
			void router.navigate({ href: projectDetailHref(project.id) });
		},
		onError: (error) => {
			toast.error("Couldn't create project", {
				description: normalizeApiError(error),
			});
		},
	});

	const openCreateDialog = () => {
		setNewProjectName("");
		setNewProjectDescription("");
		setCreateOpen(true);
	};

	if (projects.isLoading) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6")}>
				<PageHeader
					title="Projects"
					description={PROJECTS_RESOURCE.managementDescription}
					actions={
						<Button size="sm" onClick={openCreateDialog} disabled>
							<Plus className="size-3.5" />
							Create project
						</Button>
					}
				/>
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
			<PageHeader
				title="Projects"
				description={PROJECTS_RESOURCE.managementDescription}
				actions={
					<Button size="sm" onClick={openCreateDialog}>
						<Plus className="size-3.5" />
						Create project
					</Button>
				}
			/>

			<ListToolbar
				search={<SearchInput value={search} onChange={setSearch} placeholder="Search projects…" />}
			/>

			{blockingProjectsError ? (
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
						setNewProjectDescription("");
					}
				}}
			>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>Create project</DialogTitle>
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
							createProject.mutate({ body });
						}}
					>
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
							<Label htmlFor="project-description">Description</Label>
							<Textarea
								id="project-description"
								name="project-description"
								value={newProjectDescription}
								maxLength={2000}
								placeholder="What should Agents use this Project for?"
								autoComplete="off"
								onChange={(event) => setNewProjectDescription(event.target.value)}
								className="min-h-24"
							/>
						</div>
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!newProjectName.trim() || createProject.isPending}>
								<Plus className="size-3.5" />
								{createProject.isPending ? "Creating…" : "Create project"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			{blockingProjectsError ? null : gridProjects.length === 0 ? (
				<EmptyState
					title={search.trim() ? "No matching Projects" : "No Projects yet"}
					description={
						search.trim()
							? `Nothing matches “${search.trim()}”. Try a different search.`
							: "Create a Project to bundle Skills and Vaults for your Agents."
					}
				/>
			) : (
				<div className={HERO_GRID_CLASS} data-testid="project-grid">
					{gridProjects.map(({ project, shared }) => (
						<ProjectResourceCard
							key={project.id}
							project={project}
							footer={[
								formatResourceCount(project.skill_count, "skill"),
								formatResourceCount(project.vault_count, "vault"),
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
		<ShareProjectDialog projectId={project.id} projectName={projectName} projectKind={project.kind}>
			<Button variant="ghost" size="icon-sm" aria-label={`Share ${projectName}`}>
				<Share2 className="size-3.5" />
			</Button>
		</ShareProjectDialog>
	);
}

function compareProjectsForProductUse(a: ProjectRow, b: ProjectRow) {
	return a.name.localeCompare(b.name);
}
