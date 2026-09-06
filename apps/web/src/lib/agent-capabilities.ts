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
	| "connectors"
	| "model-provider"
	| "channels";

export type AgentOverviewGroupId = "workspace" | "shared" | "operate";

export type AgentOverviewModule = {
	id: AgentOverviewModuleId;
	section: AgentSectionId;
};

export type AgentOverviewGroup = {
	id: AgentOverviewGroupId;
	label: string;
	layout: "three-column" | "two-column";
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
			layout: "three-column",
			modules: WORKSPACE_RESOURCES,
		},
		{
			id: "shared",
			label: "Shared",
			layout: "three-column",
			modules: SHARED_RESOURCES,
		},
	],
	hosted: [
		{
			id: "operate",
			label: "Connections",
			layout: "two-column",
			modules: [
				{ id: "channels", section: "channels" },
				{ id: "model-provider", section: "ai" },
			],
		},
		{
			id: "workspace",
			label: "Workspace",
			layout: "two-column",
			modules: HOSTED_WORKSPACE_RESOURCES,
		},
		{
			id: "shared",
			label: "Shared",
			layout: "two-column",
			modules: SHARED_RESOURCES,
		},
	],
} as const satisfies Record<AgentNavigationVariant, readonly AgentOverviewGroup[]>;

export function agentOverviewGroups(
	variant: AgentNavigationVariant,
): readonly AgentOverviewGroup[] {
	return AGENT_OVERVIEW_GROUPS[variant];
}
