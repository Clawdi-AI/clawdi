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
