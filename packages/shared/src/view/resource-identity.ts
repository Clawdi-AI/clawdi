import { resourceIdentityClasses } from "../ui/resource-identity";
import type { ProjectResourceId } from "./project-resource-model";

/** Palette tokens shared by native and web resource identities. */
export const RESOURCE_TINT_TOKENS = {
	overview: "identity-8",
	projects: "identity-1",
	skills: "identity-2",
	vaults: "identity-4",
	sessions: "identity-3",
	memories: "identity-6",
	connectors: "identity-7",
} as const satisfies Record<ProjectResourceId | "overview", string>;

export type ResourceTintToken = (typeof RESOURCE_TINT_TOKENS)[keyof typeof RESOURCE_TINT_TOKENS];

const TINT_CLASSES = {
	"identity-1": resourceIdentityClasses.projects,
	"identity-2": resourceIdentityClasses.skills,
	"identity-3": resourceIdentityClasses.sessions,
	"identity-4": resourceIdentityClasses.vaults,
	"identity-6": resourceIdentityClasses.memories,
	"identity-7": resourceIdentityClasses.connectors,
	"identity-8": resourceIdentityClasses.overview,
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
