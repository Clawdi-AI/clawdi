"use client";

import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import { useMemo } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { CreateProjectDialog } from "@/components/projects/create-project-dialog";
import { ProjectActions } from "@/components/projects/project-actions";
import {
	canManageCustomProject,
	displayProjectName,
	isCustomProject,
} from "@/components/projects/project-metadata";
import {
	ProjectResourceCard,
	ProjectResourceCardSkeleton,
} from "@/components/projects/project-resource-card";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { useOpenApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import {
	formatResourceCount,
	getProjectResourceDefinition,
	projectDetailHref,
} from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";

type ProjectRow = components["schemas"]["ProjectResponse"];

const PROJECTS_RESOURCE = getProjectResourceDefinition("projects");

export default function ProjectsPage() {
	const $api = useOpenApi();
	const qc = useQueryClient();
	const router = useRouter();
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

	if (projects.isLoading) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6")}>
				<PageHeader
					title="Projects"
					description={PROJECTS_RESOURCE.managementDescription}
					actions={
						<Button size="sm" disabled>
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
					<CreateProjectDialog
						onCreated={(project) => {
							qc.invalidateQueries({ queryKey: ["get", "/v1/projects"] });
							toast.success("Project created", {
								description: "It is ready for Skills, Vaults, and Agent links.",
								action: {
									label: "Open project",
									onClick: () => void router.navigate({ href: projectDetailHref(project.id) }),
								},
							});
						}}
					>
						<Button size="sm">
							<Plus className="size-3.5" />
							Create project
						</Button>
					</CreateProjectDialog>
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
								canManageCustomProject(project) ? <ProjectActions project={project} /> : null
							}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function compareProjectsForProductUse(a: ProjectRow, b: ProjectRow) {
	return a.name.localeCompare(b.name);
}
