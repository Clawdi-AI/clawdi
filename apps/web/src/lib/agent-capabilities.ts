import type { AgentNavigationVariant, AgentSectionId } from "@/lib/navigation-model";

export type AgentOverviewCapability = {
	section: AgentSectionId;
	label: string;
	description: string;
};

export type AgentCapabilities = {
	variant: AgentNavigationVariant;
	label: string;
	description: string;
	management: string;
	overviewCapabilities: readonly AgentOverviewCapability[];
};

const AGENT_CAPABILITIES = {
	connected: {
		variant: "connected",
		label: "Connected agent",
		description: "Runs on your machine or server and syncs its work to Clawdi.",
		management: "Runtime controls stay on the machine where this agent runs.",
		overviewCapabilities: [
			{
				section: "sessions",
				label: "Synced activity",
				description: "Review sessions reported by this agent.",
			},
			{
				section: "projects",
				label: "Project access",
				description: "Control the Projects and resources this agent can use.",
			},
			{
				section: "settings",
				label: "Agent identity",
				description: "Rename or disconnect this agent from Clawdi.",
			},
		],
	},
	hosted: {
		variant: "hosted",
		label: "Hosted agent",
		description: "Runs in Clawdi Cloud with managed compute and runtime access.",
		management: "Start, stop, configure, and open this agent directly from Clawdi.",
		overviewCapabilities: [
			{
				section: "console",
				label: "Agent interface",
				description: "Open the agent's managed browser interface.",
			},
			{
				section: "channels",
				label: "Channel links",
				description: "Connect messaging channels directly to this agent.",
			},
			{
				section: "ai",
				label: "Model & provider",
				description: "Choose the AI provider and primary model it uses.",
			},
		],
	},
} as const satisfies Record<AgentNavigationVariant, AgentCapabilities>;

export function agentCapabilities(variant: AgentNavigationVariant): AgentCapabilities {
	return AGENT_CAPABILITIES[variant];
}
