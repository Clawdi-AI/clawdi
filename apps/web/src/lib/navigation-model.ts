import {
	LayoutDashboard,
	type LucideIcon,
	MessagesSquare,
	MonitorPlay,
	Settings,
	Sparkles,
	TerminalSquare,
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
	| "vaults"
	| "console"
	| "terminal"
	| "connectors"
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
	label: string | null;
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

type ConsoleNavigationGroupId = "primary" | "resources";

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
	separated: boolean;
};

type CanonicalNavigationConceptId =
	| "overview"
	| "sessions"
	| "memories"
	| "skills"
	| "projects"
	| "vaults"
	| "connectors"
	| "channels"
	| "ai-providers"
	| "settings";

/** Shared visible identity for concepts that appear in more than one navigation scope. */
export const CANONICAL_NAVIGATION_IDENTITIES = {
	overview: { label: "Overview", icon: LayoutDashboard },
	sessions: {
		label: getProjectResourceDefinition("sessions").navLabel,
		icon: PROJECT_RESOURCE_ICONS.sessions,
	},
	memories: {
		label: getProjectResourceDefinition("memories").navLabel,
		icon: PROJECT_RESOURCE_ICONS.memories,
	},
	skills: {
		label: getProjectResourceDefinition("skills").navLabel,
		icon: PROJECT_RESOURCE_ICONS.skills,
	},
	projects: {
		label: getProjectResourceDefinition("projects").navLabel,
		icon: PROJECT_RESOURCE_ICONS.projects,
	},
	vaults: {
		label: getProjectResourceDefinition("vaults").navLabel,
		icon: PROJECT_RESOURCE_ICONS.vaults,
	},
	connectors: {
		label: getProjectResourceDefinition("connectors").navLabel,
		icon: PROJECT_RESOURCE_ICONS.connectors,
	},
	channels: { label: "Channels", icon: MessagesSquare },
	"ai-providers": { label: "AI Providers", icon: Sparkles },
	settings: { label: "Settings", icon: Settings },
} satisfies Record<CanonicalNavigationConceptId, { label: string; icon: LucideIcon }>;

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
		...CANONICAL_NAVIGATION_IDENTITIES[id],
		href: definition.href,
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
		...CANONICAL_NAVIGATION_IDENTITIES.overview,
		href: "/",
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
		...CANONICAL_NAVIGATION_IDENTITIES.channels,
		href: "/channels",
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
		...CANONICAL_NAVIGATION_IDENTITIES["ai-providers"],
		href: "/ai-providers",
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
	{
		id: "primary",
		label: null,
		itemIds: ["overview", "agents", "sessions", "memories"],
		separated: false,
	},
	{
		id: "resources",
		label: "Resources",
		itemIds: ["channels", "ai-providers", "connectors", "projects", "skills", "vaults"],
		separated: false,
	},
] as const satisfies readonly {
	id: ConsoleNavigationGroupId;
	label: string | null;
	itemIds: readonly ConsoleNavigationItemId[];
	separated: boolean;
}[];

export function consoleNavigationGroups(showCloudFeatures: boolean): ConsoleNavigationGroup[] {
	return CONSOLE_NAVIGATION_GROUPS.map((group) => ({
		id: group.id,
		label: group.label,
		separated: group.separated,
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

type AgentNavigationGroupId = "primary" | "resources" | "settings";

export type AgentNavigationItemMetadata = Omit<NavigationItemMetadata<AgentSectionId>, "href"> & {
	variants: readonly AgentNavigationVariant[];
};

export type AgentNavigationGroup = Omit<
	NavigationGroupMetadata<AgentNavigationGroupId, AgentSectionId>,
	"items"
> & {
	items: readonly AgentNavigationItemMetadata[];
	separated: boolean;
};

export const AGENT_SECTION_NAVIGATION_ITEMS: Record<AgentSectionId, AgentNavigationItemMetadata> = {
	overview: {
		id: "overview",
		...CANONICAL_NAVIGATION_IDENTITIES.overview,
		tint: RESOURCE_TINT_CLASSES.overview,
		description: "Status, resources, and recent activity for this agent.",
		tooltip: "Agent overview",
		variants: ["connected", "hosted"],
	},
	console: {
		id: "console",
		label: "Agent Interface",
		icon: MonitorPlay,
		tint: "bg-identity-6-bg text-identity-6-fg",
		description: "Open this agent's browser interface.",
		tooltip: "Open this agent's browser interface",
		variants: ["hosted"],
	},
	terminal: {
		id: "terminal",
		label: "Terminal",
		icon: TerminalSquare,
		tint: "bg-identity-7-bg text-identity-7-fg",
		description: "Open a terminal for this agent.",
		tooltip: "Open a terminal for this agent",
		variants: ["hosted"],
	},
	sessions: {
		id: "sessions",
		...CANONICAL_NAVIGATION_IDENTITIES.sessions,
		tint: RESOURCE_TINT_CLASSES.sessions,
		description: "Conversation history from this agent.",
		tooltip: "Sessions from this agent",
		variants: ["connected", "hosted"],
	},
	skills: {
		id: "skills",
		...CANONICAL_NAVIGATION_IDENTITIES.skills,
		tint: RESOURCE_TINT_CLASSES.skills,
		description: "Skills available through this agent's Projects.",
		tooltip: "View Skills available through this agent's Projects",
		variants: ["connected", "hosted"],
	},
	projects: {
		id: "projects",
		...CANONICAL_NAVIGATION_IDENTITIES.projects,
		tint: RESOURCE_TINT_CLASSES.projects,
		description: "Agent Project, added Projects, and read order.",
		tooltip: "Projects available to this agent",
		variants: ["connected", "hosted"],
	},
	vaults: {
		id: "vaults",
		...CANONICAL_NAVIGATION_IDENTITIES.vaults,
		tint: RESOURCE_TINT_CLASSES.vaults,
		description: "Vaults available through this agent's Projects.",
		tooltip: "Vaults available through this agent's Projects",
		variants: ["connected", "hosted"],
	},
	connectors: {
		id: "connectors",
		...CANONICAL_NAVIGATION_IDENTITIES.connectors,
		tint: RESOURCE_TINT_CLASSES.connectors,
		description: "Account-wide connectors available across all agents.",
		tooltip: "Account-wide connectors available across all agents",
		variants: ["connected", "hosted"],
	},
	ai: {
		id: "ai",
		...CANONICAL_NAVIGATION_IDENTITIES["ai-providers"],
		tint: "bg-identity-2-bg text-identity-2-fg",
		description: "Provider binding and primary model used by this agent.",
		tooltip: "Configure this agent's provider binding and primary model",
		variants: ["hosted"],
	},
	channels: {
		id: "channels",
		...CANONICAL_NAVIGATION_IDENTITIES.channels,
		tint: "bg-identity-5-bg text-identity-5-fg",
		description: "Channels linked to this agent.",
		tooltip: "Channels linked to this agent",
		variants: ["hosted"],
	},
	settings: {
		id: "settings",
		...CANONICAL_NAVIGATION_IDENTITIES.settings,
		tint: "bg-identity-4-bg text-identity-4-fg",
		description: "Name, preferences, and agent controls.",
		tooltip: "Manage this agent",
		variants: ["connected", "hosted"],
	},
};

const AGENT_NAVIGATION_GROUPS = [
	{
		id: "primary",
		label: null,
		itemIds: ["overview", "sessions", "console", "terminal"],
		separated: false,
	},
	{
		id: "resources",
		label: "Resources",
		itemIds: ["channels", "ai", "connectors", "projects", "skills", "vaults"],
		separated: false,
	},
	{ id: "settings", label: null, itemIds: ["settings"], separated: true },
] as const satisfies readonly {
	id: AgentNavigationGroupId;
	label: string | null;
	itemIds: readonly AgentSectionId[];
	separated: boolean;
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
		separated: group.separated,
		items: group.itemIds
			.map((id) => AGENT_SECTION_NAVIGATION_ITEMS[id])
			.filter(
				(item) =>
					item.variants.includes(variant) && (!visibleSections || visibleSections.has(item.id)),
			),
	})).filter((group) => group.items.length > 0);
}
