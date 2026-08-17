import type { components } from "@clawdi/shared/api";
import type { StatusTone } from "@/components/ui/status-badge";
import type { HostedRuntime } from "@/hosted/runtimes";
import { runtimeDisplayName } from "@/hosted/runtimes";

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

const CONVERGENCE_ORDER: Record<AgentPluginDesiredState["convergence"], number> = {
	failed: 0,
	not_observed: 1,
	installed: 2,
};

export function buildAgentPluginInventory(
	catalog: readonly AgentPluginCatalogEntry[],
	desired: readonly AgentPluginDesiredState[],
): { installed: AgentPluginInventoryItem[]; available: AgentPluginInventoryItem[] } {
	const catalogByName = new Map(catalog.map((entry) => [entry.name, entry]));
	const installedNames = new Set(desired.map((entry) => entry.plugin_name));
	const installed = desired
		.map((entry) => ({
			name: entry.plugin_name,
			catalog: catalogByName.get(entry.plugin_name) ?? null,
			desired: entry,
		}))
		.sort(
			(left, right) =>
				CONVERGENCE_ORDER[left.desired.convergence] -
					CONVERGENCE_ORDER[right.desired.convergence] ||
				pluginDisplayName(left).localeCompare(pluginDisplayName(right)),
		);
	const available = catalog
		.filter((entry) => !installedNames.has(entry.name))
		.map((entry) => ({ name: entry.name, catalog: entry, desired: null }))
		.sort((left, right) => pluginDisplayName(left).localeCompare(pluginDisplayName(right)));

	return { installed, available };
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
			label: "Incompatible",
			reason: `This plugin does not support ${runtimeDisplayName(runtime)}.`,
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
				description: "The agent confirmed this installation.",
			};
		case "failed":
			return {
				label: "Failed",
				tone: "destructive",
				description: observationErrorDescription(desired.observation_error_code),
			};
		case "not_observed":
			return {
				label: "Pending",
				tone: "warning",
				description: "Waiting for the agent to confirm this installation.",
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
			return "The agent did not report an installation receipt.";
		case "receipt_unreadable":
			return "The agent could not read the installation receipt.";
		case "receipt_mismatch":
			return "The installed package does not match the requested plugin.";
		default:
			return "The agent could not confirm this installation.";
	}
}
