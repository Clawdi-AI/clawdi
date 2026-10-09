import { hostedAgentOverviewClasses } from "@clawdi/shared/ui";
import {
	AGENT_NAVIGATION_GROUPS,
	agentSectionCopy,
	agentToolSectionCopy,
	type ConsoleNavigationItemId,
	getProjectResourceDefinition,
	CONSOLE_NAVIGATION_ITEMS as SHARED_CONSOLE_NAVIGATION_ITEMS,
	type ConsoleNavigationGroup as SharedConsoleNavigationGroup,
	type ConsoleNavigationItemMetadata as SharedConsoleNavigationItemMetadata,
	consoleCommandPaletteItems as sharedConsoleCommandPaletteItems,
	consoleNavigationGroups as sharedConsoleNavigationGroups,
} from "@clawdi/shared/view";
import {
	Blocks,
	BrainCircuit,
	FolderOpen,
	LayoutDashboard,
	type LucideIcon,
	MessagesSquare,
	MonitorPlay,
	PanelsTopLeft,
	Settings,
	TerminalSquare,
} from "lucide-react";
import { PROJECT_RESOURCE_ICONS } from "@/components/project-resource-icons";
import { RESOURCE_TINT_CLASSES } from "@/lib/resource-identity";

export type AgentSectionId =
	| "overview"
	| "sessions"
	| "memories"
	| "skills"
	| "projects"
	| "vaults"
	| "console"
	| "files"
	| "terminal"
	| "connectors"
	| "ai"
	| "channels"
	| "plugins"
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
	"ai-providers": { label: "AI Providers", icon: BrainCircuit },
	settings: { label: "Settings", icon: Settings },
} satisfies Record<CanonicalNavigationConceptId, { label: string; icon: LucideIcon }>;

type ConsoleNavigationItemMetadata = SharedConsoleNavigationItemMetadata & { icon: LucideIcon };

export type { ConsoleNavigationItemMetadata };
export type ConsoleNavigationGroup = Omit<SharedConsoleNavigationGroup, "items"> & {
	items: readonly ConsoleNavigationItemMetadata[];
};
const CONSOLE_ICONS = {
	overview: LayoutDashboard,
	agents: MonitorPlay,
	projects: PROJECT_RESOURCE_ICONS.projects,
	skills: PROJECT_RESOURCE_ICONS.skills,
	vaults: PROJECT_RESOURCE_ICONS.vaults,
	sessions: PROJECT_RESOURCE_ICONS.sessions,
	memories: PROJECT_RESOURCE_ICONS.memories,
	connectors: PROJECT_RESOURCE_ICONS.connectors,
	channels: MessagesSquare,
	"ai-providers": BrainCircuit,
};
export const CONSOLE_NAVIGATION_ITEMS = Object.fromEntries(
	Object.entries(SHARED_CONSOLE_NAVIGATION_ITEMS).map(([id, item]) => [
		id,
		{ ...item, icon: CONSOLE_ICONS[item.id] },
	]),
) as Record<ConsoleNavigationItemId, ConsoleNavigationItemMetadata>;

export function isOverviewPath(pathname: string): boolean {
	return pathname === "/" || pathname === "/dashboard";
}

export function consoleNavigationGroups(showCloudFeatures: boolean): ConsoleNavigationGroup[] {
	return sharedConsoleNavigationGroups(showCloudFeatures).map((group) => ({
		...group,
		items: group.items.map((item) => CONSOLE_NAVIGATION_ITEMS[item.id]),
	}));
}

export function consoleNavigationItemIsActive(pathname: string, itemHref: string): boolean {
	return itemHref === "/"
		? isOverviewPath(pathname)
		: pathname === itemHref || pathname.startsWith(`${itemHref}/`);
}
export function consoleCommandPaletteItems(showCloudFeatures: boolean) {
	return sharedConsoleCommandPaletteItems(showCloudFeatures).map((item) => ({
		...item,
		icon: CONSOLE_ICONS[item.id],
	}));
}
type AgentNavigationGroupId = "primary" | "workspace" | "shared" | "operate" | "settings";

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
		description: agentSectionCopy.overview.description,
		tooltip: "Agent overview",
		variants: ["connected", "hosted"],
	},
	console: {
		id: "console",
		label: "Dashboard",
		icon: PanelsTopLeft,
		tint: hostedAgentOverviewClasses.browserTint,
		description: "Open this agent's dashboard.",
		tooltip: "Open dashboard",
		variants: ["hosted"],
	},
	files: {
		id: "files",
		label: agentToolSectionCopy.files.label,
		icon: FolderOpen,
		tint: hostedAgentOverviewClasses.filesTint,
		description: agentToolSectionCopy.files.description,
		tooltip: "Browse this agent's workspace",
		variants: ["hosted"],
	},
	terminal: {
		id: "terminal",
		label: agentToolSectionCopy.terminal.label,
		icon: TerminalSquare,
		tint: hostedAgentOverviewClasses.terminalTint,
		description: agentToolSectionCopy.terminal.description,
		tooltip: "Use a terminal for this agent",
		variants: ["hosted"],
	},
	sessions: {
		id: "sessions",
		...CANONICAL_NAVIGATION_IDENTITIES.sessions,
		tint: RESOURCE_TINT_CLASSES.sessions,
		description: agentSectionCopy.sessions.description,
		tooltip: "Sessions from this agent",
		variants: ["connected", "hosted"],
	},
	memories: {
		id: "memories",
		...CANONICAL_NAVIGATION_IDENTITIES.memories,
		tint: RESOURCE_TINT_CLASSES.memories,
		description: agentSectionCopy.memories.description,
		tooltip: "Shared across all agents",
		variants: ["connected", "hosted"],
	},
	skills: {
		id: "skills",
		...CANONICAL_NAVIGATION_IDENTITIES.skills,
		tint: RESOURCE_TINT_CLASSES.skills,
		description: agentSectionCopy.skills.description,
		tooltip: "Skills installed in this agent's workspace",
		variants: ["connected", "hosted"],
	},
	projects: {
		id: "projects",
		...CANONICAL_NAVIGATION_IDENTITIES.projects,
		tint: RESOURCE_TINT_CLASSES.projects,
		description: agentSectionCopy.projects.description,
		tooltip: "Projects linked to this agent",
		variants: ["connected", "hosted"],
	},
	vaults: {
		id: "vaults",
		...CANONICAL_NAVIGATION_IDENTITIES.vaults,
		tint: RESOURCE_TINT_CLASSES.vaults,
		description: agentSectionCopy.vaults.description,
		tooltip: "Vaults attached to this agent's workspace",
		variants: ["connected", "hosted"],
	},
	connectors: {
		id: "connectors",
		...CANONICAL_NAVIGATION_IDENTITIES.connectors,
		tint: RESOURCE_TINT_CLASSES.connectors,
		description: agentSectionCopy.connectors.description,
		tooltip: "Shared across all agents",
		variants: ["connected", "hosted"],
	},
	ai: {
		id: "ai",
		...CANONICAL_NAVIGATION_IDENTITIES["ai-providers"],
		tint: "bg-identity-2-bg text-identity-2-fg",
		description: agentSectionCopy.ai.description,
		tooltip: "Choose this agent's AI provider and primary model",
		variants: ["hosted"],
	},
	channels: {
		id: "channels",
		...CANONICAL_NAVIGATION_IDENTITIES.channels,
		tint: hostedAgentOverviewClasses.channelsTint,
		description: agentSectionCopy.channels.description,
		tooltip: "Channels linked to this agent",
		variants: ["hosted"],
	},
	plugins: {
		id: "plugins",
		label: "Plugins",
		icon: Blocks,
		tint: hostedAgentOverviewClasses.pluginsTint,
		description: agentSectionCopy.plugins.description,
		tooltip: "Install plugins for this agent",
		variants: ["hosted"],
	},
	settings: {
		id: "settings",
		...CANONICAL_NAVIGATION_IDENTITIES.settings,
		tint: hostedAgentOverviewClasses.settingsTint,
		description: agentSectionCopy.settings.description,
		tooltip: "Manage this agent",
		variants: ["connected", "hosted"],
	},
};

export const AGENT_WORKSPACE_SECTION_IDS = [
	"projects",
	"plugins",
] as const satisfies readonly AgentSectionId[];

export const AGENT_SHARED_SECTION_IDS = [
	"memories",
	"connectors",
] as const satisfies readonly AgentSectionId[];

/** Released route identifiers that stay valid without becoming flat navigation items. */
export const AGENT_PROJECT_RESOURCE_SECTION_IDS = [
	"skills",
	"vaults",
] as const satisfies readonly AgentSectionId[];

/** Resources available inside one Agent's workspace. */
export const AGENT_OVERVIEW_WORKSPACE_SECTION_IDS = [
	"projects",
	"skills",
	"vaults",
] as const satisfies readonly AgentSectionId[];

export function agentNavigationSectionIds(variant: AgentNavigationVariant): AgentSectionId[] {
	return AGENT_NAVIGATION_GROUPS.flatMap((group) =>
		group.itemIds.filter((id) => AGENT_SECTION_NAVIGATION_ITEMS[id].variants.includes(variant)),
	);
}

export const CONNECTED_AGENT_SECTION_IDS: readonly AgentSectionId[] =
	agentNavigationSectionIds("connected");
export const HOSTED_AGENT_SECTION_IDS: readonly AgentSectionId[] =
	agentNavigationSectionIds("hosted");

export function hostedAgentVisibleSectionIds(filesAvailable: boolean): AgentSectionId[] {
	return HOSTED_AGENT_SECTION_IDS.filter((section) => filesAvailable || section !== "files");
}

export function agentNavigationGroups(
	variant: AgentNavigationVariant,
	visibleSectionIds?: readonly AgentSectionId[],
	runtime?: string | null,
): AgentNavigationGroup[] {
	const visibleSections = visibleSectionIds ? new Set(visibleSectionIds) : null;
	return AGENT_NAVIGATION_GROUPS.map((group) => ({
		id: group.id,
		label: group.label,
		separated: group.separated,
		items: group.itemIds
			.map((id) => agentSectionNavigationItem(id, runtime))
			.filter(
				(item) =>
					item.variants.includes(variant) && (!visibleSections || visibleSections.has(item.id)),
			),
	})).filter((group) => group.items.length > 0);
}

export { runtimeBrowserUiLabel } from "@clawdi/shared/view";

import { runtimeBrowserUiLabel } from "@clawdi/shared/view";

export function agentSectionNavigationItem(
	section: AgentSectionId,
	runtime?: string | null,
): AgentNavigationItemMetadata {
	const item = AGENT_SECTION_NAVIGATION_ITEMS[section];
	if (section !== "console") return item;
	const label = runtimeBrowserUiLabel(runtime);
	return { ...item, label, description: `Open ${label}.`, tooltip: `Open ${label}` };
}
