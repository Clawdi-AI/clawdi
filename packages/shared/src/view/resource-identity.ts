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
	"identity-1": "bg-identity-1-bg text-identity-1-fg",
	"identity-2": "bg-identity-2-bg text-identity-2-fg",
	"identity-3": "bg-identity-3-bg text-identity-3-fg",
	"identity-4": "bg-identity-4-bg text-identity-4-fg",
	"identity-6": "bg-identity-6-bg text-identity-6-fg",
	"identity-7": "bg-identity-7-bg text-identity-7-fg",
	"identity-8": "bg-identity-8-bg text-identity-8-fg",
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
