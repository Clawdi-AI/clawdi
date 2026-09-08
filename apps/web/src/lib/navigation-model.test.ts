import { describe, expect, test } from "bun:test";
import {
	agentNavigationGroups,
	consoleCommandPaletteItems,
	consoleNavigationGroups,
	hostedAgentVisibleSectionIds,
} from "@/lib/navigation-model";

function expectNavigationHeadings(
	groups: ReadonlyArray<{ label: string | null; items: readonly unknown[] }>,
	expected = ["Library"],
) {
	expect(groups.filter((group) => group.label !== null).map((group) => group.label)).toEqual(
		expected,
	);
	expect(groups.every((group) => group.items.length > 0)).toBe(true);
}

describe("sidebar navigation model", () => {
	test("keeps hosted resources out of OSS navigation", () => {
		const cloudGroups = consoleNavigationGroups(true);
		expectNavigationHeadings(cloudGroups);

		const ossGroups = consoleNavigationGroups(false);
		expect(ossGroups[1]?.items.map((item) => item.id)).toEqual([
			"projects",
			"skills",
			"vaults",
			"connectors",
		]);
		expectNavigationHeadings(ossGroups);
	});

	test("preserves command palette availability in the rendered navigation order", () => {
		expect(consoleCommandPaletteItems(false).map((item) => item.id)).toEqual([
			"overview",
			"sessions",
			"memories",
			"projects",
			"skills",
			"vaults",
			"connectors",
		]);
		expect(consoleCommandPaletteItems(true).map((item) => item.id)).toEqual([
			"overview",
			"sessions",
			"memories",
			"projects",
			"skills",
			"vaults",
			"connectors",
			"channels",
			"ai-providers",
		]);
	});

	test("keeps Agent resource groups populated and gates Files on availability", () => {
		const connectedGroups = agentNavigationGroups("connected");
		expectNavigationHeadings(connectedGroups, ["Workspace", "Shared"]);

		const hostedGroups = agentNavigationGroups("hosted", undefined, "hermes");
		expectNavigationHeadings(hostedGroups, ["Workspace", "Shared", "Tools"]);

		expect(hostedAgentVisibleSectionIds(false)).not.toContain("files");
		expect(hostedAgentVisibleSectionIds(false)).toContain("plugins");
		expect(hostedAgentVisibleSectionIds(true)).toContain("files");
		expect(hostedAgentVisibleSectionIds(true)).toContain("plugins");
	});
});
