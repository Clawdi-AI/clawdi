import { literalSearchRank, searchExcerpt, searchTerms } from "../api/search-highlight";
import { agentIdentity } from "./agent-label";

export interface ProjectMetadata {
	id?: string;
	name: string;
	slug: string;
	description?: string | null;
	kind?: string;
	origin_environment_id?: string | null;
	is_owner?: boolean;
	owner_display?: string | null;
	owner_handle?: string | null;
}

export interface ProjectAgentMetadata {
	id: string;
	name?: string | null;
	display_name?: string | null;
	default_name?: string | null;
	machine_name?: string | null;
	agent_type?: string | null;
}

export function isProjectOwner(project: Pick<ProjectMetadata, "is_owner">): boolean {
	return project.is_owner !== false;
}

export function displayProjectName(project: Pick<ProjectMetadata, "kind" | "name" | "slug">) {
	return project.name;
}

export function projectOwnerLabel(project: ProjectMetadata) {
	if (isProjectOwner(project)) return "You";
	return project.owner_display ?? project.owner_handle ?? "Unknown";
}

export function projectSupportingText(project: ProjectMetadata) {
	const description = project.description?.trim();
	if (description) return description;
	if (!isProjectOwner(project)) return `Shared by ${projectOwnerLabel(project)}`;
	if (project.kind === "environment") return "Private Agent Workspace";
	return "Project you own";
}

export function projectSearchRank(project: ProjectMetadata, query: string): number | null {
	const ownerIdentity = isProjectOwner(project)
		? undefined
		: `${project.owner_display ?? ""}\n${project.owner_handle ?? ""}`;
	return literalSearchRank(
		query,
		[displayProjectName(project), project.slug],
		[project.description, ownerIdentity],
	);
}

export function projectMatchesSearch(project: ProjectMetadata, query: string): boolean {
	return projectSearchRank(project, query) !== null;
}

export function projectSearchSupportingText(project: ProjectMetadata, query: string): string {
	const terms = searchTerms(query).map((term) => term.toLocaleLowerCase());
	if (terms.length === 0) return projectSupportingText(project);
	const title = displayProjectName(project).toLocaleLowerCase();
	const supportingTerms = terms.filter((term) => !title.includes(term));
	const relevantTerms = supportingTerms.length > 0 ? supportingTerms : terms;

	if (relevantTerms.some((term) => project.slug.toLocaleLowerCase().includes(term))) {
		return `Slug: ${project.slug}`;
	}

	const description = project.description?.trim();
	if (description && relevantTerms.some((term) => description.toLocaleLowerCase().includes(term))) {
		return searchExcerpt(description, query, 160);
	}

	const matchingOwner = [project.owner_display, project.owner_handle].find((owner) =>
		relevantTerms.some((term) => owner?.toLocaleLowerCase().includes(term)),
	);
	if (!isProjectOwner(project) && matchingOwner) {
		return `Shared by ${matchingOwner}`;
	}
	return projectSupportingText(project);
}

export function isCustomProject(project: Pick<ProjectMetadata, "kind">): boolean {
	return project.kind === "workspace" || !project.kind;
}

export function canManageCustomProject(
	project: Pick<ProjectMetadata, "is_owner" | "kind">,
): boolean {
	return isProjectOwner(project) && isCustomProject(project);
}

export function projectKindSortRank(kind?: string): number {
	if (kind === "workspace" || !kind) return 0;
	if (kind === "personal") return 1;
	if (kind === "environment") return 2;
	return 4;
}

export function compareProjectsForUse(a: ProjectMetadata, b: ProjectMetadata) {
	const rank = (project: ProjectMetadata) => {
		if (!isProjectOwner(project)) return 3;
		return projectKindSortRank(project.kind);
	};
	const byRank = rank(a) - rank(b);
	if (byRank !== 0) return byRank;
	return displayProjectName(a).localeCompare(displayProjectName(b));
}

export function projectCompactKindText(project: ProjectMetadata) {
	if (project.is_owner === false) return "Shared";
	return ownedProjectKindText(project, "compact");
}

export function ownedProjectKindText(
	project: Pick<ProjectMetadata, "kind">,
	_variant: "full" | "compact" | "badge",
) {
	if (project.kind === "workspace" || !project.kind) {
		return "Project";
	}
	if (project.kind === "personal") return "Private resources";
	if (project.kind === "environment") return "Workspace";
	return "Project";
}

export function projectPickerAccessText(project: ProjectMetadata) {
	if (project.is_owner === false) return "Viewer";
	if (project.kind === "workspace" || !project.kind) return "Owner";
	return "Owner";
}

export function projectAgentLabel(agent: ProjectAgentMetadata) {
	const hasIdentity = Boolean(
		agent.display_name ||
			agent.default_name ||
			agent.name ||
			agent.machine_name ||
			agent.agent_type,
	);
	if (!hasIdentity) return "Agent";
	return agentIdentity(agent).primaryLabel;
}

export function projectAgentFor(
	project: Pick<ProjectMetadata, "origin_environment_id">,
	agentsById: ReadonlyMap<string, ProjectAgentMetadata>,
): ProjectAgentMetadata | null {
	return project.origin_environment_id
		? (agentsById.get(project.origin_environment_id) ?? null)
		: null;
}

export function projectPickerGroups(projects: ProjectMetadata[]) {
	const owned = projects.filter((project) => isProjectOwner(project));
	const shared = projects.filter((project) => !isProjectOwner(project));
	const groups = [
		{
			id: "projects",
			label: "Projects",
			projects: owned.filter(isCustomProject),
		},
		{
			id: "workspaces",
			label: "Agent Workspaces",
			projects: owned.filter((project) => project.kind === "environment"),
		},
		{
			id: "other",
			label: "Other Projects",
			projects: owned.filter(
				(project) =>
					!!project.kind &&
					project.kind !== "workspace" &&
					project.kind !== "environment" &&
					project.kind !== "personal",
			),
		},
		{
			id: "shared",
			label: "Shared by others",
			projects: shared,
		},
	];
	return groups.filter((group) => group.projects.length > 0);
}
