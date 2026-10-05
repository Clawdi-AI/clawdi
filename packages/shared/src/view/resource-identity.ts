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
