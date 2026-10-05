import { resourceIdentityClasses } from "@clawdi/shared/ui";
import type { ProjectResourceId } from "@clawdi/shared/view";
import { RESOURCE_TINT_TOKENS } from "@clawdi/shared/view";

/**
 * Tinted icon-chip classes per resource type — one vocabulary shared by
 * the nav sidebar, the overview Resources rail, and any future surface
 * that names a resource type. Static identity-palette strings (the
 * Tailwind scanner needs literals), aligned with the project-hub stat
 * tiles (Skills = identity-2, Vaults = identity-4) so a resource keeps
 * the same hue everywhere it appears.
 */
const TINT_CLASSES = {
	"identity-1": resourceIdentityClasses.bgIdentity1BgText,
	"identity-2": resourceIdentityClasses.bgIdentity2BgText,
	"identity-3": resourceIdentityClasses.bgIdentity3BgText,
	"identity-4": resourceIdentityClasses.bgIdentity4BgText,
	"identity-6": resourceIdentityClasses.bgIdentity6BgText,
	"identity-7": resourceIdentityClasses.bgIdentity7BgText,
	"identity-8": resourceIdentityClasses.bgIdentity8BgText,
} as const;

export const RESOURCE_TINT_CLASSES: Record<ProjectResourceId | "overview", string> = {
	overview: TINT_CLASSES[RESOURCE_TINT_TOKENS.overview],
	projects: TINT_CLASSES[RESOURCE_TINT_TOKENS.projects],
	skills: TINT_CLASSES[RESOURCE_TINT_TOKENS.skills],
	vaults: TINT_CLASSES[RESOURCE_TINT_TOKENS.vaults],
	sessions: TINT_CLASSES[RESOURCE_TINT_TOKENS.sessions],
	memories: TINT_CLASSES[RESOURCE_TINT_TOKENS.memories],
	connectors: TINT_CLASSES[RESOURCE_TINT_TOKENS.connectors],
};
