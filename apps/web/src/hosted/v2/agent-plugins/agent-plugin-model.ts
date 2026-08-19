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

export type AgentPluginGroup = "installed" | "available";

export type AgentPluginInstallability = {
	installable: boolean;
	label: string;
	reason: string | null;
};

const EXACT_SEMVER_PATTERN =
	/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** SemVer precedence; null when either side is not exact SemVer. */
function compareAgentPluginVersions(left: string, right: string): number | null {
	const a = EXACT_SEMVER_PATTERN.exec(left);
	const b = EXACT_SEMVER_PATTERN.exec(right);
	if (!a || !b) return null;
	for (let i = 1; i <= 3; i++) {
		const diff = Number(a[i]) - Number(b[i]);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	const preLeft = a[4];
	const preRight = b[4];
	if (!preLeft && !preRight) return 0;
	if (!preLeft) return 1;
	if (!preRight) return -1;
	const idsLeft = preLeft.split(".");
	const idsRight = preRight.split(".");
	for (let i = 0; i < Math.max(idsLeft.length, idsRight.length); i++) {
		const x = idsLeft[i];
		const y = idsRight[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const numericX = /^\d+$/.test(x);
		const numericY = /^\d+$/.test(y);
		if (numericX && numericY) {
			const diff = Number(x) - Number(y);
			if (diff !== 0) return diff < 0 ? -1 : 1;
		} else if (numericX !== numericY) {
			return numericX ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

export function buildAgentPluginInventory(
	catalog: readonly AgentPluginCatalogEntry[],
	desired: readonly AgentPluginDesiredState[],
): AgentPluginInventoryItem[] {
	const catalogByName = new Map<string, AgentPluginCatalogEntry>();
	for (const entry of catalog) {
		const existing = catalogByName.get(entry.name);
		if (!existing) {
			catalogByName.set(entry.name, entry);
			continue;
		}
		// Unparseable versions fall back to last-write-wins.
		if ((compareAgentPluginVersions(entry.version, existing.version) ?? 1) > 0) {
			catalogByName.set(entry.name, entry);
		}
	}
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

/**
 * Group assignment follows live state, with one exception: a card the user
 * just clicked Install/Update on stays in Available while the install is in
 * flight (`not_observed`), so the grid never reshuffles mid-action. Once the
 * install reaches a terminal state (or the plugin is removed) the card regroups.
 */
export function assignAgentPluginGroups(
	previous: ReadonlyMap<string, AgentPluginGroup>,
	inventory: readonly AgentPluginInventoryItem[],
): Map<string, AgentPluginGroup> {
	const next = new Map<string, AgentPluginGroup>();
	for (const item of inventory) {
		const pinned =
			previous.get(item.name) === "available" && item.desired?.convergence === "not_observed";
		next.set(item.name, pinned ? "available" : item.desired ? "installed" : "available");
	}
	return next;
}

export function pluginDisplayName(item: AgentPluginInventoryItem): string {
	return item.catalog?.display_name ?? item.name;
}

export function pluginVersion(item: AgentPluginInventoryItem): string {
	return item.desired?.version ?? item.catalog?.version ?? "";
}

export function pluginHasUpdate(item: AgentPluginInventoryItem): boolean {
	if (!item.catalog || !item.desired) return false;
	const comparison = compareAgentPluginVersions(item.catalog.version, item.desired.version);
	return comparison === null ? item.catalog.version !== item.desired.version : comparison > 0;
}

/** After this long without an observation, the agent — not the install — is the holdup. */
const AGENT_PLUGIN_STALL_THRESHOLD_MS = 10 * 60 * 1000;

export function agentPluginIsStalled(
	desired: AgentPluginDesiredState,
	now: Date = new Date(),
): boolean {
	return (
		desired.convergence === "not_observed" &&
		now.getTime() - new Date(desired.updated_at).getTime() > AGENT_PLUGIN_STALL_THRESHOLD_MS
	);
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

export function agentPluginStatusPresentation(
	desired: AgentPluginDesiredState,
	now: Date = new Date(),
): {
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
			return agentPluginIsStalled(desired, now)
				? {
						label: "Waiting for agent",
						tone: "warning",
						description:
							"The agent has not picked this up yet. It will finish once the agent is back online.",
					}
				: {
						label: "Installing",
						tone: "warning",
						description:
							"This plugin is being installed. You can leave this page while it finishes.",
					};
	}
}

export type AgentPluginActionState = {
	status: ReturnType<typeof agentPluginStatusPresentation> | null;
	installability: AgentPluginInstallability | null;
	hasUpdate: boolean;
	canInstall: boolean;
	canRetry: boolean;
	version: string;
};

/** Shared card/detail action derivation — keep the two surfaces from drifting. */
export function agentPluginActionState(
	item: AgentPluginInventoryItem,
	runtime: HostedRuntime,
): AgentPluginActionState {
	const status = item.desired ? agentPluginStatusPresentation(item.desired) : null;
	const installability = item.catalog ? agentPluginInstallability(item.catalog, runtime) : null;
	const hasUpdate = pluginHasUpdate(item);
	const installFailed = item.desired?.convergence === "failed";
	return {
		status,
		installability,
		hasUpdate,
		canRetry: Boolean(installFailed && item.catalog && installability?.installable),
		canInstall: Boolean(
			item.catalog && installability?.installable && !installFailed && (!item.desired || hasUpdate),
		),
		version:
			hasUpdate && item.desired && item.catalog
				? `v${item.desired.version} → v${item.catalog.version}`
				: `v${pluginVersion(item)}`,
	};
}

export function agentPluginComponentSummary(entry: AgentPluginCatalogEntry): string {
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
