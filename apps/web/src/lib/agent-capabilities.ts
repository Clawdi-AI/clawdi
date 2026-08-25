import {
	AGENT_OVERVIEW_WORKSPACE_SECTION_IDS,
	AGENT_SHARED_SECTION_IDS,
	type AgentNavigationVariant,
	type AgentSectionId,
	HOSTED_AGENT_SECTION_IDS,
	hostedAgentVisibleSectionIds,
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

const HOSTED_NAVIGATION_SECTIONS = new Set<AgentSectionId>(HOSTED_AGENT_SECTION_IDS);

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
			modules: HOSTED_WORKSPACE_RESOURCES,
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
	visibleSectionIds?: readonly AgentSectionId[],
): readonly AgentOverviewGroup[] {
	const groups = AGENT_OVERVIEW_GROUPS[variant];
	if (variant !== "hosted") return groups;

	const visibleSections = new Set(visibleSectionIds ?? hostedAgentVisibleSectionIds(true));
	return groups.map((group) => {
		const modules = group.modules.filter(
			(module) =>
				!HOSTED_NAVIGATION_SECTIONS.has(module.section) || visibleSections.has(module.section),
		);
		return {
			...group,
			layout:
				group.id === "workspace" && modules.some((module) => module.id === "plugins")
					? "two-column"
					: group.layout,
			modules,
		};
	});
}
