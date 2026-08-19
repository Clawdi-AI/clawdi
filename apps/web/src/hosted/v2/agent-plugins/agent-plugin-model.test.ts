import { describe, expect, test } from "bun:test";
import type { AgentPluginCatalogEntry, AgentPluginDesiredState } from "./agent-plugin-model";
import {
	agentPluginInstallability,
	agentPluginStatusPresentation,
	assignAgentPluginGroups,
	buildAgentPluginInventory,
	pluginHasUpdate,
} from "./agent-plugin-model";

function catalogEntry(
	name: string,
	overrides: Partial<AgentPluginCatalogEntry> = {},
): AgentPluginCatalogEntry {
	return {
		name,
		version: "2.0.0",
		display_name: name,
		description: `${name} description`,
		publisher: "Example",
		category: "developer-tools",
		keywords: [],
		languages: ["en"],
		runtimes: ["openclaw", "hermes"],
		components: { skills: [`${name}-skill`], mcpServers: {} },
		installable: true,
		...overrides,
	};
}

function desired(
	name: string,
	overrides: Partial<AgentPluginDesiredState> = {},
): AgentPluginDesiredState {
	return {
		installation_id: `installation-${name}`,
		agent_id: "11111111-1111-4111-8111-111111111111",
		plugin_name: name,
		version: "1.0.0",
		catalog_revision: "a".repeat(40),
		desired_state: "present",
		convergence: "installed",
		observation_error_code: null,
		observed_at: null,
		created_at: "2026-08-16T00:00:00Z",
		updated_at: "2026-08-16T00:00:00Z",
		...overrides,
	};
}

describe("Agent Plugin model", () => {
	test("merges Store and desired state without dropping historical installations", () => {
		const inventory = buildAgentPluginInventory(
			[catalogEntry("sui"), catalogEntry("cetus")],
			[desired("sui"), desired("legacy")],
		);

		expect(inventory.map((item) => item.name)).toEqual(["cetus", "legacy", "sui"]);
		expect(inventory[1]?.catalog).toBeNull();
		expect(pluginHasUpdate(inventory[2])).toBe(true);
	});

	test("pins a card to Available only while its install is in flight", () => {
		const initial = assignAgentPluginGroups(
			new Map(),
			buildAgentPluginInventory([catalogEntry("cetus"), catalogEntry("sui")], [desired("sui")]),
		);
		expect(Object.fromEntries(initial)).toEqual({ cetus: "available", sui: "installed" });

		const installing = assignAgentPluginGroups(
			initial,
			buildAgentPluginInventory(
				[catalogEntry("cetus"), catalogEntry("sui")],
				[desired("sui"), desired("cetus", { convergence: "not_observed" })],
			),
		);
		expect(installing.get("cetus")).toBe("available");

		const settled = assignAgentPluginGroups(
			installing,
			buildAgentPluginInventory(
				[catalogEntry("cetus"), catalogEntry("sui")],
				[desired("sui"), desired("cetus")],
			),
		);
		expect(settled.get("cetus")).toBe("installed");

		const removed = assignAgentPluginGroups(
			settled,
			buildAgentPluginInventory([catalogEntry("cetus"), catalogEntry("sui")], [desired("sui")]),
		);
		expect(removed.get("cetus")).toBe("available");
	});

	test("maps the three observed convergence states without mutation-only states", () => {
		const now = new Date("2026-08-16T00:00:30Z");
		expect(agentPluginStatusPresentation(desired("sui"), now).label).toBe("Installed");
		expect(
			agentPluginStatusPresentation(desired("sui", { convergence: "not_observed" }), now).label,
		).toBe("Installing");
		expect(
			agentPluginStatusPresentation(
				desired("sui", {
					convergence: "failed",
					observation_error_code: "receipt_mismatch",
				}),
				now,
			),
		).toMatchObject({
			label: "Install failed",
			description: "The installed plugin does not match the requested version.",
		});
	});

	test("distinguishes a stalled install from an active one", () => {
		const pending = desired("sui", { convergence: "not_observed" });
		expect(agentPluginStatusPresentation(pending, new Date("2026-08-16T00:05:00Z")).label).toBe(
			"Installing",
		);
		expect(agentPluginStatusPresentation(pending, new Date("2026-08-16T00:11:00Z")).label).toBe(
			"Waiting for agent",
		);
	});

	test("keeps the latest catalog version and only flags real upgrades", () => {
		const inventory = buildAgentPluginInventory(
			[catalogEntry("sui", { version: "2.0.0" }), catalogEntry("sui", { version: "10.0.0" })],
			[desired("sui", { version: "2.0.0" })],
		);
		expect(inventory).toHaveLength(1);
		expect(inventory[0]?.catalog?.version).toBe("10.0.0");
		expect(pluginHasUpdate(inventory[0])).toBe(true);

		const downgraded = buildAgentPluginInventory(
			[catalogEntry("sui", { version: "1.0.0" })],
			[desired("sui", { version: "2.0.0" })],
		);
		expect(pluginHasUpdate(downgraded[0])).toBe(false);
	});

	test("combines catalog installability with the selected hosted runtime", () => {
		expect(agentPluginInstallability(catalogEntry("sui"), "hermes").installable).toBe(true);
		expect(
			agentPluginInstallability(catalogEntry("cetus", { runtimes: ["openclaw"] }), "hermes"),
		).toEqual({
			installable: false,
			label: "Unavailable",
			reason: "This plugin is not available for this agent.",
		});
		expect(
			agentPluginInstallability(
				catalogEntry("reserved", {
					installable: false,
					installability_reason: "reserved_name",
				}),
				"openclaw",
			).label,
		).toBe("Reserved");
	});
});
