import { ALL_AGENTS_ACCESS_LABEL } from "@/lib/agent-resource-access";
import {
	AGENT_RESOURCE_SECTION_IDS,
	type AgentNavigationVariant,
	type AgentSectionId,
	isAllAgentsSection,
} from "@/lib/navigation-model";

export type AgentOverviewModuleId =
	| "projects"
	| "skills"
	| "memories"
	| "vaults"
	| "connectors"
	| "model-provider"
	| "channels";

export type AgentOverviewGroupId = "resources" | "operate";

export type AgentOverviewModule = {
	id: AgentOverviewModuleId;
	section: AgentSectionId;
	accessLabel?: string;
};

export type AgentOverviewGroup = {
	id: AgentOverviewGroupId;
	label: string;
	layout: "three-column";
	modules: readonly AgentOverviewModule[];
};

const AGENT_RESOURCES = AGENT_RESOURCE_SECTION_IDS.map((section) => ({
	id: section,
	section,
	...(isAllAgentsSection(section) ? { accessLabel: ALL_AGENTS_ACCESS_LABEL } : {}),
}));

const AGENT_OVERVIEW_GROUPS = {
	connected: [
		{
			id: "resources",
			label: "Resources",
			layout: "three-column",
			modules: AGENT_RESOURCES,
		},
	],
	hosted: [
		{
			id: "resources",
			label: "Resources",
			layout: "three-column",
			modules: AGENT_RESOURCES,
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
