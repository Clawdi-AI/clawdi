import type { components } from "@clawdi/shared/api";
import type { StatusTone } from "@/components/ui/status-badge";
import type { HostedRuntime } from "@/hosted/runtimes";

export type AgentPluginCatalogEntry = components["schemas"]["PluginCatalogEntryResponse"];
export type AgentPluginDesiredState = components["schemas"]["AgentPluginDesiredStateResponse"];

export type AgentPluginInventoryItem = {
	name: string;
	catalog: AgentPluginCatalogEntry | null;
	desired: AgentPluginDesiredState | null;
};

export type AgentPluginInstallability = {
	installable: boolean;
	label: string;
	reason: string | null;
};

export function buildAgentPluginInventory(
	catalog: readonly AgentPluginCatalogEntry[],
	desired: readonly AgentPluginDesiredState[],
): AgentPluginInventoryItem[] {
	const catalogByName = new Map(catalog.map((entry) => [entry.name, entry]));
	const desiredByName = new Map(desired.map((entry) => [entry.plugin_name, entry]));
	const names = new Set([...catalogByName.keys(), ...desiredByName.keys()]);

	return [...names]
		.map((name) => ({
			name,
			catalog: catalogByName.get(name) ?? null,
			desired: desiredByName.get(name) ?? null,
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
}

export function pluginDisplayName(item: AgentPluginInventoryItem): string {
	return item.catalog?.display_name ?? item.name;
}

export function pluginVersion(item: AgentPluginInventoryItem): string {
	return item.desired?.version ?? item.catalog?.version ?? "";
}

export function pluginHasUpdate(item: AgentPluginInventoryItem): boolean {
	return Boolean(item.catalog && item.desired && item.catalog.version !== item.desired.version);
}

export function agentPluginInstallability(
	entry: AgentPluginCatalogEntry,
	runtime: HostedRuntime,
): AgentPluginInstallability {
	if (!entry.installable) {
		switch (entry.installability_reason) {
			case "configuration_not_supported":
				return {
					installable: false,
					label: "Requires setup",
					reason: "This plugin requires configuration that Clawdi does not support.",
				};
			case "reserved_name":
				return {
					installable: false,
					label: "Reserved",
					reason: "This name is reserved for a built-in Clawdi capability.",
				};
			default:
				return {
					installable: false,
					label: "Unavailable",
					reason: "This plugin does not support a hosted runtime.",
				};
		}
	}
	if (!entry.runtimes.includes(runtime)) {
		return {
			installable: false,
			label: "Unavailable",
			reason: "This plugin is not available for this agent.",
		};
	}
	return { installable: true, label: "Install", reason: null };
}

export function agentPluginStatusPresentation(desired: AgentPluginDesiredState): {
	label: string;
	tone: StatusTone;
	description: string;
} {
	switch (desired.convergence) {
		case "installed":
			return {
				label: "Installed",
				tone: "success",
				description: "This plugin is ready to use.",
			};
		case "failed":
			return {
				label: "Install failed",
				tone: "destructive",
				description: observationErrorDescription(desired.observation_error_code),
			};
		case "not_observed":
			return {
				label: "Installing",
				tone: "warning",
				description: "This plugin is being installed. You can leave this page while it finishes.",
			};
	}
}

export function agentPluginComponentSummary(entry: AgentPluginCatalogEntry | null): string {
	if (!entry) return "Component details unavailable";
	const skills = entry.components.skills.length;
	const servers = Object.keys(entry.components.mcpServers).length;
	return [
		skills > 0 ? `${skills} Skill${skills === 1 ? "" : "s"}` : null,
		servers > 0 ? `${servers} MCP server${servers === 1 ? "" : "s"}` : null,
	]
		.filter((value): value is string => value !== null)
		.join(" · ");
}

export function agentPluginMatches(item: AgentPluginInventoryItem, query: string): boolean {
	const normalized = query.trim().toLocaleLowerCase();
	if (!normalized) return true;
	const entry = item.catalog;
	return [
		item.name,
		pluginDisplayName(item),
		entry?.description,
		entry?.publisher,
		entry?.category,
		...(entry?.keywords ?? []),
		...(entry?.languages ?? []),
		...(entry?.components.skills ?? []),
		...Object.keys(entry?.components.mcpServers ?? {}),
	]
		.filter((value): value is string => typeof value === "string")
		.some((value) => value.toLocaleLowerCase().includes(normalized));
}

function observationErrorDescription(
	code: AgentPluginDesiredState["observation_error_code"],
): string {
	switch (code) {
		case "reconcile_failed":
			return "The agent could not apply this plugin.";
		case "receipt_missing":
			return "The plugin could not be verified after setup.";
		case "receipt_unreadable":
			return "The plugin installation could not be verified.";
		case "receipt_mismatch":
			return "The installed plugin does not match the requested version.";
		default:
			return "The plugin could not be set up. Remove it and try again.";
	}
}
