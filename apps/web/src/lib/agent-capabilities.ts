import {
	AGENT_OVERVIEW_WORKSPACE_SECTION_IDS,
	AGENT_SHARED_SECTION_IDS,
	type AgentNavigationVariant,
	type AgentSectionId,
} from "@/lib/navigation-model";

export type AgentOverviewModuleId =
	| "projects"
	| "skills"
	| "plugins"
	| "memories"
	| "vaults"
	| "connectors";

export type AgentOverviewGroupId = "workspace" | "shared";

export type AgentOverviewModule = {
	id: AgentOverviewModuleId;
	section: AgentSectionId;
};

export type AgentOverviewGroup = {
	id: AgentOverviewGroupId;
	label: string;
	modules: readonly AgentOverviewModule[];
};

const WORKSPACE_RESOURCES = AGENT_OVERVIEW_WORKSPACE_SECTION_IDS.map((section) => ({
	id: section,
	section,
}));

const HOSTED_WORKSPACE_RESOURCES = [
	...WORKSPACE_RESOURCES,
	{ id: "plugins", section: "plugins" },
] as const;

const SHARED_RESOURCES = AGENT_SHARED_SECTION_IDS.map((section) => ({
	id: section,
	section,
}));

const AGENT_OVERVIEW_GROUPS = {
	connected: [
		{
			id: "workspace",
			label: "Workspace",
			modules: WORKSPACE_RESOURCES,
		},
		{
			id: "shared",
			label: "Shared",
			modules: SHARED_RESOURCES,
		},
	],
	hosted: [
		{
			id: "workspace",
			label: "Workspace",
			modules: HOSTED_WORKSPACE_RESOURCES,
		},
		{
			id: "shared",
			label: "Shared",
			modules: SHARED_RESOURCES,
		},
	],
} as const satisfies Record<AgentNavigationVariant, readonly AgentOverviewGroup[]>;

export function agentOverviewGroups(
	variant: AgentNavigationVariant,
): readonly AgentOverviewGroup[] {
	return AGENT_OVERVIEW_GROUPS[variant];
}
