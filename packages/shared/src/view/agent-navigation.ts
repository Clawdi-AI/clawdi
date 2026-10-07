import { agentOverviewCopy } from "./agent-overview";
import { getProjectResourceDefinition } from "./project-resource-model";
export const agentSectionCopy = {
	overview: {
		label: "Overview",
		description: "Status, resources, and recent activity for this agent.",
	},
	sessions: {
		label: getProjectResourceDefinition("sessions").navLabel,
		description: "Conversation history from this agent.",
	},
	memories: {
		label: getProjectResourceDefinition("memories").navLabel,
		description: "Memories are shared across all agents.",
	},
	connectors: {
		label: getProjectResourceDefinition("connectors").navLabel,
		description: "Connectors are shared across all agents.",
	},
	projects: {
		label: getProjectResourceDefinition("projects").navLabel,
		description: "Projects linked to this agent.",
	},
	skills: {
		label: getProjectResourceDefinition("skills").navLabel,
		description: "Skills installed in this agent's workspace.",
	},
	vaults: {
		label: getProjectResourceDefinition("vaults").navLabel,
		description: "Vaults attached to this agent's workspace.",
	},
	ai: { label: "AI Providers", description: "AI provider and primary model used by this agent." },
	channels: { label: "Channels", description: "Channels linked to this agent." },
	plugins: { label: "Plugins", description: "Install skills and MCP servers for this agent." },
	settings: { label: "Settings", description: "Name, preferences, and agent controls." },
} as const;
export type MobileAgentSection = keyof typeof agentSectionCopy;

/** Hosted live tools. Console takes the runtime's browser UI label instead. */
export const agentToolSectionCopy = {
	files: { label: "Files", description: "Browse and edit files in this agent's workspace." },
	terminal: { label: "Terminal", description: "Use a terminal for this agent." },
} as const;

export const AGENT_NAVIGATION_GROUPS = [
	{
		id: "primary",
		label: null,
		itemIds: ["overview", "console", "channels", "ai", "sessions"],
		separated: false,
	},
	{
		id: "workspace",
		label: agentOverviewCopy.workspace,
		itemIds: ["projects", "plugins"],
		separated: false,
	},
	{
		id: "shared",
		label: agentOverviewCopy.shared,
		itemIds: ["memories", "connectors"],
		separated: false,
	},
	{
		id: "operate",
		label: agentOverviewCopy.tools,
		itemIds: ["files", "terminal"],
		separated: false,
	},
	{ id: "settings", label: null, itemIds: ["settings"], separated: true },
] as const;
