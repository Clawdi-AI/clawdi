import {
	getProjectResourceDefinition,
	projectResourcePathLabel,
	projectResourceScopeLabel,
} from "./project-resource-model";
import { RESOURCE_TINT_CLASSES } from "./resource-identity";

type ConsoleNavigationMetadata = {
	id: ConsoleNavigationItemId;
	label: string;
	href: string;
	tint: string;
	description: string;
	tooltip: string;
};
export type ConsoleNavigationItemId =
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

export type ConsoleNavigationGroupId = "primary" | "library";

type ConsoleCommandPaletteMetadata = {
	subtitle: string;
	searchText: string;
};

export type ConsoleNavigationItemMetadata = ConsoleNavigationMetadata & {
	availability: "all" | "cloud";
	commandPalette?: ConsoleCommandPaletteMetadata;
};

export type ConsoleNavigationGroup = { id: ConsoleNavigationGroupId; label: string | null } & {
	items: readonly ConsoleNavigationItemMetadata[];
	separated: boolean;
};

function projectResourceNavigationItem(
	id: "projects" | "skills" | "vaults" | "sessions" | "memories" | "connectors",
): ConsoleNavigationItemMetadata {
	const definition = getProjectResourceDefinition(id);
	const commandGroupLabel =
		id === "projects"
			? "Projects"
			: id === "skills" || id === "vaults" || id === "connectors"
				? "Library"
				: "Account activity";
	return {
		id,
		label: definition.navLabel,
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
		label: "Overview",
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
		tint: "bg-identity-6-bg text-identity-6-fg",
		description: "Every Agent in this account.",
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
		tint: "bg-identity-5-bg text-identity-5-fg",
		description: "Account channel inventory and connections.",
		tooltip: "Channels — Account integrations",
		availability: "cloud",
		commandPalette: {
			subtitle: "Library",
			searchText: "channels telegram discord whatsapp bots messaging",
		},
	},
	"ai-providers": {
		id: "ai-providers",
		label: "AI Providers",
		href: "/ai-providers",
		tint: "bg-identity-2-bg text-identity-2-fg",
		description: "Account AI provider connections and credentials.",
		tooltip: "AI Providers — Account integrations",
		availability: "cloud",
		commandPalette: {
			subtitle: "Library",
			searchText:
				"model providers ai providers models openai anthropic openrouter gemini mistral byok api key",
		},
	},
} satisfies Record<ConsoleNavigationItemId, ConsoleNavigationItemMetadata>;

export const CONSOLE_NAVIGATION_GROUPS = [
	{
		id: "primary",
		label: null,
		itemIds: ["overview", "agents", "sessions", "memories"],
		separated: false,
	},
	{
		id: "library",
		label: "Library",
		// Assets first (mirrors the dashboard Library card), integrations last;
		// cloud-gated items drop out in OSS without disturbing the order.
		itemIds: ["projects", "skills", "vaults", "connectors", "channels", "ai-providers"],
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
