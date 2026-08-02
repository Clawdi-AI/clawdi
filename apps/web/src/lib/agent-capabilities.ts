import type { AgentNavigationVariant, AgentSectionId } from "@/lib/navigation-model";

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
	size: "standard" | "wide";
};

export type AgentOverviewGroup = {
	id: AgentOverviewGroupId;
	label: string;
	columns: 2 | 3;
	modules: readonly AgentOverviewModule[];
};

const SHARED_RESOURCES = [
	{ id: "projects", section: "projects", size: "standard" },
	{ id: "skills", section: "skills", size: "standard" },
	{ id: "memories", section: "memories", size: "standard" },
	{ id: "connectors", section: "connectors", size: "wide" },
	{ id: "vaults", section: "vaults", size: "standard" },
] as const satisfies readonly AgentOverviewModule[];

const AGENT_OVERVIEW_GROUPS = {
	connected: [
		{
			id: "resources",
			label: "Resources",
			columns: 3,
			modules: SHARED_RESOURCES,
		},
	],
	hosted: [
		{
			id: "resources",
			label: "Resources",
			columns: 3,
			modules: SHARED_RESOURCES,
		},
		{
			id: "operate",
			label: "Operate",
			columns: 2,
			modules: [
				{ id: "model-provider", section: "ai", size: "standard" },
				{ id: "channels", section: "channels", size: "standard" },
			],
		},
	],
} as const satisfies Record<AgentNavigationVariant, readonly AgentOverviewGroup[]>;

export function agentOverviewGroups(
	variant: AgentNavigationVariant,
): readonly AgentOverviewGroup[] {
	return AGENT_OVERVIEW_GROUPS[variant];
}
