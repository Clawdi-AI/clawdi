import { describe, expect, test } from "bun:test";
import type { AgentPluginCatalogEntry, AgentPluginDesiredState } from "./agent-plugin-model";
import {
	agentPluginInstallability,
	agentPluginStatusPresentation,
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

	test("maps the three observed convergence states without mutation-only states", () => {
		expect(agentPluginStatusPresentation(desired("sui")).label).toBe("Installed");
		expect(
			agentPluginStatusPresentation(desired("sui", { convergence: "not_observed" })).label,
		).toBe("Installing");
		expect(
			agentPluginStatusPresentation(
				desired("sui", {
					convergence: "failed",
					observation_error_code: "receipt_mismatch",
				}),
			),
		).toMatchObject({
			label: "Install failed",
			description: "The installed plugin does not match the requested version.",
		});
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
