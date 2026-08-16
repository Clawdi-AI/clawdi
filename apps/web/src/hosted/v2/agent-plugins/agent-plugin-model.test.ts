import { describe, expect, test } from "bun:test";
import type { AgentPluginCatalogEntry, AgentPluginDesiredState } from "./agent-plugin-model";
import {
	agentPluginInstallability,
	agentPluginMatches,
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
		category: "productivity",
		keywords: ["automation"],
		languages: ["en"],
		runtimes: ["openclaw", "hermes"],
		components: { skills: [`${name}-skill`], mcpServers: {} },
		installable: true,
		...overrides,
	};
}

function desired(
	name: string,
	convergence: AgentPluginDesiredState["convergence"] = "installed",
): AgentPluginDesiredState {
	return {
		installation_id: `installation-${name}`,
		agent_id: "11111111-1111-4111-8111-111111111111",
		plugin_name: name,
		version: "1.0.0",
		catalog_revision: "a".repeat(40),
		desired_state: "present",
		convergence,
		observation_error_code: null,
		observed_at: null,
		created_at: "2026-08-16T00:00:00Z",
		updated_at: "2026-08-16T00:00:00Z",
	};
}

describe("Agent Plugin inventory", () => {
	test("keeps installed packages once and preserves entries no longer in the catalog", () => {
		const inventory = buildAgentPluginInventory(
			[catalogEntry("alpha"), catalogEntry("beta")],
			[desired("alpha"), desired("legacy")],
		);
		expect(inventory.installed.map((item) => item.name)).toEqual(["alpha", "legacy"]);
		expect(inventory.available.map((item) => item.name)).toEqual(["beta"]);
		expect(inventory.installed[1]?.catalog).toBeNull();
		expect(pluginHasUpdate(inventory.installed[0])).toBe(true);
	});

	test("orders failures before pending and installed packages", () => {
		const inventory = buildAgentPluginInventory(
			[],
			[
				desired("ready", "installed"),
				desired("pending", "not_observed"),
				desired("broken", "failed"),
			],
		);
		expect(inventory.installed.map((item) => item.name)).toEqual(["broken", "pending", "ready"]);
		const failed = inventory.installed[0]?.desired;
		if (!failed) throw new Error("expected failed desired state");
		expect(agentPluginStatusPresentation(failed).label).toBe("Needs attention");
	});

	test("combines Store installability with the selected runtime", () => {
		expect(agentPluginInstallability(catalogEntry("portable"), "hermes").installable).toBe(true);
		expect(
			agentPluginInstallability(
				catalogEntry("openclaw-only", { runtimes: ["openclaw"] }),
				"hermes",
			),
		).toEqual({
			installable: false,
			label: "Incompatible",
			reason: "This plugin does not support Hermes.",
		});
		expect(
			agentPluginInstallability(
				catalogEntry("configured", {
					installable: false,
					installability_reason: "configuration_not_supported",
				}),
				"openclaw",
			).reason,
		).toContain("requires configuration");
	});

	test("searches catalog identity, metadata, and component names", () => {
		const item = buildAgentPluginInventory(
			[
				catalogEntry("browser-tools", {
					display_name: "Browser Tools",
					components: {
						skills: ["web-research"],
						mcpServers: { browser: "streamable-http" },
					},
				}),
			],
			[],
		).available[0];
		expect(agentPluginMatches(item, "research")).toBe(true);
		expect(agentPluginMatches(item, "browser")).toBe(true);
		expect(agentPluginMatches(item, "unrelated")).toBe(false);
	});
});
