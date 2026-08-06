import {
	AGENT_OVERVIEW_WORKSPACE_SECTION_IDS,
	AGENT_SHARED_SECTION_IDS,
	type AgentNavigationVariant,
	type AgentSectionId,
} from "@/lib/navigation-model";

export type AgentOverviewModuleId =
	| "projects"
	| "skills"
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
		{
			id: "operate",
			label: "Tools",
			layout: "three-column",
			modules: [
				{ id: "model-provider", section: "ai" },
				{ id: "channels", section: "channels" },
			],
		},
	],
} as const satisfies Record<AgentNavigationVariant, readonly AgentOverviewGroup[]>;

export function agentOverviewGroups(
	variant: AgentNavigationVariant,
): readonly AgentOverviewGroup[] {
	return AGENT_OVERVIEW_GROUPS[variant];
}
