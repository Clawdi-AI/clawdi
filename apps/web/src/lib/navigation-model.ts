import {
	LayoutDashboard,
	Link2,
	type LucideIcon,
	MessageSquare,
	MessagesSquare,
	MonitorPlay,
	Settings,
	Sparkles,
	TerminalSquare,
	Zap,
} from "lucide-react";
import { PROJECT_RESOURCE_ICONS } from "@/components/project-resource-icons";
import {
	getProjectResourceDefinition,
	projectResourcePathLabel,
	projectResourceScopeLabel,
} from "@/lib/project-resource-model";
import { RESOURCE_TINT_CLASSES } from "@/lib/resource-identity";

export type AgentSectionId =
	| "overview"
	| "sessions"
	| "skills"
	| "projects"
	| "console"
	| "terminal"
	| "ai"
	| "channels"
	| "settings";

export type AgentNavigationVariant = "connected" | "hosted";

export type NavigationItemMetadata<Id extends string> = {
	id: Id;
	label: string;
	href: string;
	icon: LucideIcon;
	tint: string;
	description: string;
	tooltip: string;
};

export type NavigationGroupMetadata<GroupId extends string, ItemId extends string> = {
	id: GroupId;
	label: string;
	items: readonly NavigationItemMetadata<ItemId>[];
};

type ConsoleNavigationItemId =
	| "overview"
	| "agents"
	| "projects"
	| "skills"
	| "vaults"
	| "sessions"
	| "memories"
	| "connectors"
	| "channels"
	| "ai-providers";

type ConsoleNavigationGroupId = "primary" | "projects" | "activity" | "integrations";

type ConsoleCommandPaletteMetadata = {
	subtitle: string;
	searchText: string;
};

export type ConsoleNavigationItemMetadata = NavigationItemMetadata<ConsoleNavigationItemId> & {
	availability: "all" | "cloud";
	commandPalette?: ConsoleCommandPaletteMetadata;
};

export type ConsoleNavigationGroup = Omit<
	NavigationGroupMetadata<ConsoleNavigationGroupId, ConsoleNavigationItemId>,
	"items"
> & {
	items: readonly ConsoleNavigationItemMetadata[];
};

function projectResourceNavigationItem(
	id: "projects" | "skills" | "vaults" | "sessions" | "memories" | "connectors",
): ConsoleNavigationItemMetadata {
	const definition = getProjectResourceDefinition(id);
	const commandGroupLabel =
		id === "projects"
			? "Projects"
			: id === "skills" || id === "vaults"
				? "Project resources"
				: "Account resources";
	return {
		id,
		label: definition.navLabel,
		href: definition.href,
		icon: PROJECT_RESOURCE_ICONS[id],
		tint: RESOURCE_TINT_CLASSES[id],
		description: definition.managementDescription,
		tooltip: `${definition.navLabel} — ${projectResourceScopeLabel(definition.projectScope)}`,
		availability: "all",
		commandPalette: {
			subtitle: projectResourcePathLabel(definition),
			searchText: `${definition.navLabel} ${definition.label} ${commandGroupLabel} ${projectResourceScopeLabel(definition.projectScope)} ${projectResourcePathLabel(definition)}`,
		},
	};
}

export const CONSOLE_NAVIGATION_ITEMS: Record<
	ConsoleNavigationItemId,
	ConsoleNavigationItemMetadata
> = {
	overview: {
		id: "overview",
		label: "Overview",
		href: "/",
		icon: LayoutDashboard,
		tint: RESOURCE_TINT_CLASSES.overview,
		description: "Account inventory and recent activity.",
		tooltip: "Console overview",
		availability: "all",
		commandPalette: {
			subtitle: "Dashboard",
			searchText: "overview dashboard",
		},
	},
	agents: {
		id: "agents",
		label: "Agents",
		href: "/agents",
		icon: MonitorPlay,
		tint: "bg-identity-6-bg text-identity-6-fg",
		description: "Every agent connected to this account.",
		tooltip: "All agents",
		availability: "all",
	},
	projects: projectResourceNavigationItem("projects"),
	skills: projectResourceNavigationItem("skills"),
	vaults: projectResourceNavigationItem("vaults"),
	sessions: projectResourceNavigationItem("sessions"),
	memories: projectResourceNavigationItem("memories"),
	connectors: projectResourceNavigationItem("connectors"),
	channels: {
		id: "channels",
		label: "Channels",
		href: "/channels",
		icon: MessagesSquare,
		tint: "bg-identity-5-bg text-identity-5-fg",
		description: "Account channel inventory and connections.",
		tooltip: "Channels — Account integrations",
		availability: "cloud",
		commandPalette: {
			subtitle: "Account resources",
			searchText: "channels telegram discord whatsapp bots messaging",
		},
	},
	"ai-providers": {
		id: "ai-providers",
		label: "AI Providers",
		href: "/ai-providers",
		icon: Sparkles,
		tint: "bg-identity-2-bg text-identity-2-fg",
		description: "Account AI provider connections and credentials.",
		tooltip: "AI Providers — Account integrations",
		availability: "cloud",
		commandPalette: {
			subtitle: "Account resources",
			searchText:
				"model providers ai providers models openai anthropic openrouter gemini mistral byok api key",
		},
	},
} satisfies Record<ConsoleNavigationItemId, ConsoleNavigationItemMetadata>;

const CONSOLE_NAVIGATION_GROUPS = [
	{ id: "primary", label: "Primary", itemIds: ["overview", "agents"] },
	{ id: "projects", label: "Projects", itemIds: ["projects", "skills", "vaults"] },
	{ id: "activity", label: "Activity", itemIds: ["sessions", "memories"] },
	{
		id: "integrations",
		label: "Integrations",
		itemIds: ["connectors", "channels", "ai-providers"],
	},
] as const satisfies readonly {
	id: ConsoleNavigationGroupId;
	label: string;
	itemIds: readonly ConsoleNavigationItemId[];
}[];

export function consoleNavigationGroups(showCloudFeatures: boolean): ConsoleNavigationGroup[] {
	return CONSOLE_NAVIGATION_GROUPS.map((group) => ({
		id: group.id,
		label: group.label,
		items: group.itemIds
			.map((id) => CONSOLE_NAVIGATION_ITEMS[id])
			.filter((item) => item.availability === "all" || showCloudFeatures),
	}));
}

export function consoleCommandPaletteItems(
	showCloudFeatures: boolean,
): Array<ConsoleNavigationItemMetadata & { commandPalette: ConsoleCommandPaletteMetadata }> {
	return consoleNavigationGroups(showCloudFeatures)
		.flatMap((group) => group.items)
		.filter(
			(
				item,
			): item is ConsoleNavigationItemMetadata & {
				commandPalette: ConsoleCommandPaletteMetadata;
			} => Boolean(item.commandPalette),
		);
}

type AgentNavigationGroupId =
	| "primary"
	| "runtime"
	| "activity"
	| "context"
	| "integrations"
	| "manage";

export type AgentNavigationItemMetadata = NavigationItemMetadata<AgentSectionId> & {
	variants: readonly AgentNavigationVariant[];
};

export type AgentNavigationGroup = Omit<
	NavigationGroupMetadata<AgentNavigationGroupId, AgentSectionId>,
	"items"
> & {
	items: readonly AgentNavigationItemMetadata[];
};

export const AGENT_SECTION_NAVIGATION_ITEMS: Record<AgentSectionId, AgentNavigationItemMetadata> = {
	overview: {
		id: "overview",
		label: "Overview",
		href: "",
		icon: LayoutDashboard,
		tint: RESOURCE_TINT_CLASSES.overview,
		description: "Status, resources, and recent activity for this agent.",
		tooltip: "Agent overview",
		variants: ["connected", "hosted"],
	},
	console: {
		id: "console",
		label: "Agent Interface",
		href: "console",
		icon: MonitorPlay,
		tint: "bg-identity-6-bg text-identity-6-fg",
		description: "Open this agent's browser interface.",
		tooltip: "Open this agent's browser interface",
		variants: ["hosted"],
	},
	terminal: {
		id: "terminal",
		label: "Terminal",
		href: "terminal",
		icon: TerminalSquare,
		tint: "bg-identity-7-bg text-identity-7-fg",
		description: "Open a terminal for this agent.",
		tooltip: "Open a terminal for this agent",
		variants: ["hosted"],
	},
	sessions: {
		id: "sessions",
		label: "Sessions",
		href: "sessions",
		icon: MessageSquare,
		tint: RESOURCE_TINT_CLASSES.sessions,
		description: "Conversation history from this agent.",
		tooltip: "Sessions from this agent",
		variants: ["connected", "hosted"],
	},
	skills: {
		id: "skills",
		label: "Skills",
		href: "skills",
		icon: Sparkles,
		tint: RESOURCE_TINT_CLASSES.skills,
		description: "Skills synced from this agent's filesystem.",
		tooltip: "Skills synced from this agent's filesystem",
		variants: ["connected", "hosted"],
	},
	projects: {
		id: "projects",
		label: "Projects",
		href: "project-access",
		icon: PROJECT_RESOURCE_ICONS.projects,
		tint: RESOURCE_TINT_CLASSES.projects,
		description: "Agent Project, added Projects, and read order.",
		tooltip: "Projects available to this agent",
		variants: ["connected"],
	},
	ai: {
		id: "ai",
		label: "AI & Model",
		href: "model-provider",
		icon: Zap,
		tint: "bg-identity-2-bg text-identity-2-fg",
		description: "Provider binding and primary model used by this agent.",
		tooltip: "Configure this agent's provider binding and primary model",
		variants: ["hosted"],
	},
	channels: {
		id: "channels",
		label: "Channels",
		href: "channel-links",
		icon: Link2,
		tint: "bg-identity-5-bg text-identity-5-fg",
		description: "Channels linked to this agent.",
		tooltip: "Channels linked to this agent",
		variants: ["hosted"],
	},
	settings: {
		id: "settings",
		label: "Settings",
		href: "settings",
		icon: Settings,
		tint: "bg-identity-4-bg text-identity-4-fg",
		description: "Name, preferences, and agent controls.",
		tooltip: "Manage this agent",
		variants: ["connected", "hosted"],
	},
};

const AGENT_NAVIGATION_GROUPS = [
	{ id: "primary", label: "Primary", itemIds: ["overview"] },
	{ id: "runtime", label: "Runtime", itemIds: ["console", "terminal"] },
	{ id: "activity", label: "Activity", itemIds: ["sessions"] },
	{ id: "context", label: "Context", itemIds: ["skills", "projects"] },
	{ id: "integrations", label: "Integrations", itemIds: ["ai", "channels"] },
	{ id: "manage", label: "Manage", itemIds: ["settings"] },
] as const satisfies readonly {
	id: AgentNavigationGroupId;
	label: string;
	itemIds: readonly AgentSectionId[];
}[];

export function agentNavigationSectionIds(variant: AgentNavigationVariant): AgentSectionId[] {
	return AGENT_NAVIGATION_GROUPS.flatMap((group) =>
		group.itemIds.filter((id) => AGENT_SECTION_NAVIGATION_ITEMS[id].variants.includes(variant)),
	);
}

export const CONNECTED_AGENT_SECTION_IDS: readonly AgentSectionId[] =
	agentNavigationSectionIds("connected");
export const HOSTED_AGENT_SECTION_IDS: readonly AgentSectionId[] =
	agentNavigationSectionIds("hosted");

export function agentNavigationGroups(
	variant: AgentNavigationVariant,
	visibleSectionIds?: readonly AgentSectionId[],
): AgentNavigationGroup[] {
	const visibleSections = visibleSectionIds ? new Set(visibleSectionIds) : null;
	return AGENT_NAVIGATION_GROUPS.map((group) => ({
		id: group.id,
		label: group.label,
		items: group.itemIds
			.map((id) => AGENT_SECTION_NAVIGATION_ITEMS[id])
			.filter(
				(item) =>
					item.variants.includes(variant) && (!visibleSections || visibleSections.has(item.id)),
			),
	})).filter((group) => group.items.length > 0);
}
