import type { AgentNavigationVariant, AgentSectionId } from "@/lib/navigation-model";

export type AgentOverviewModuleId =
	| "sessions"
	| "live-sync"
	| "agent-interface"
	| "projects"
	| "skills"
	| "memories"
	| "vaults"
	| "connectors"
	| "model-provider"
	| "channels"
	| "compute";

export type AgentOverviewGroupId = "now" | "resources" | "operate";

export type AgentOverviewModule = {
	id: AgentOverviewModuleId;
	section: AgentSectionId;
	size: "standard" | "wide";
};

export type AgentOverviewGroup = {
	id: AgentOverviewGroupId;
	label: string;
	columns: 3 | 4;
	modules: readonly AgentOverviewModule[];
};

const SHARED_RESOURCES = [
	{ id: "projects", section: "projects", size: "wide" },
	{ id: "skills", section: "skills", size: "standard" },
	{ id: "memories", section: "memories", size: "standard" },
	{ id: "vaults", section: "vaults", size: "standard" },
	{ id: "connectors", section: "connectors", size: "standard" },
] as const satisfies readonly AgentOverviewModule[];

const AGENT_OVERVIEW_GROUPS = {
	connected: [
		{
			id: "now",
			label: "Now",
			columns: 3,
			modules: [
				{ id: "sessions", section: "sessions", size: "wide" },
				{ id: "live-sync", section: "settings", size: "standard" },
			],
		},
		{
			id: "resources",
			label: "Resources",
			columns: 3,
			modules: SHARED_RESOURCES,
		},
	],
	hosted: [
		{
			id: "now",
			label: "Now",
			columns: 4,
			modules: [
				{ id: "sessions", section: "sessions", size: "wide" },
				{ id: "agent-interface", section: "console", size: "standard" },
				{ id: "compute", section: "settings", size: "standard" },
			],
		},
		{
			id: "resources",
			label: "Resources",
			columns: 3,
			modules: SHARED_RESOURCES,
		},
		{
			id: "operate",
			label: "Operate",
			columns: 3,
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
