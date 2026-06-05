import type { ProjectResourceId } from "@/lib/project-resource-model";

/**
 * Tinted icon-chip classes per resource type — one vocabulary shared by
 * the nav sidebar, the overview Resources rail, and any future surface
 * that names a resource type. Static identity-palette strings (the
 * Tailwind scanner needs literals), aligned with the project-hub stat
 * tiles (Skills = identity-2, Vaults = identity-4) so a resource keeps
 * the same hue everywhere it appears.
 */
export const RESOURCE_TINT_CLASSES: Record<ProjectResourceId | "overview", string> = {
	overview: "bg-identity-8-bg text-identity-8-fg",
	projects: "bg-identity-1-bg text-identity-1-fg",
	skills: "bg-identity-2-bg text-identity-2-fg",
	vaults: "bg-identity-4-bg text-identity-4-fg",
	sessions: "bg-identity-3-bg text-identity-3-fg",
	memories: "bg-identity-6-bg text-identity-6-fg",
	connectors: "bg-identity-7-bg text-identity-7-fg",
};
