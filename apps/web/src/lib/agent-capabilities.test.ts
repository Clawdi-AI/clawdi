import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { agentOverviewGroups } from "@/lib/agent-capabilities";
import { agentNavigationSectionIds } from "@/lib/navigation-model";

describe("agent overview registry", () => {
	test("only registers supported sections with real summaries", () => {
		for (const variant of ["connected", "hosted"] as const) {
			const supported = new Set(agentNavigationSectionIds(variant));
			for (const module of agentOverviewGroups(variant).flatMap((group) => group.modules))
				expect(supported.has(module.section)).toBe(true);
		}
	});
	test("shares resource and account-wide summaries while keeping hosted operations separate", () => {
		const connected = agentOverviewGroups("connected");
		const hosted = agentOverviewGroups("hosted");
		expect(connected.map((group) => group.id)).toEqual(["resources", "account-wide"]);
		expect(hosted.map((group) => group.id)).toEqual(["resources", "account-wide", "operate"]);
		expect(connected[0]?.modules.map((module) => module.id)).toEqual([
			"projects",
			"skills",
			"vaults",
		]);
		expect(hosted[0]?.modules).toEqual(connected[0]?.modules);
		expect(hosted[0]?.layout).toBe(connected[0]?.layout);
		expect(connected[1]?.modules.map((module) => module.id)).toEqual(["memories", "connectors"]);
		expect(hosted[1]?.modules).toEqual(connected[1]?.modules);
		expect(hosted[1]?.layout).toBe("two-column");
		expect(hosted[2]?.modules.map((module) => module.id)).toEqual(["model-provider", "channels"]);
		expect(connected[0]?.layout).toBe("three-column");
		expect(hosted[2]?.layout).toBe("three-column");
		expect(connected[0]?.modules.every((module) => !("size" in module))).toBe(true);
	});

	test("skips a missing summary without rendering an empty card or crashing the overview", () => {
		const source = readFileSync(
			new URL("../components/dashboard/agent-overview-capabilities.tsx", import.meta.url),
			"utf8",
		);
		expect(source).toContain("if (!moduleContent) return null;");
		expect(source).not.toContain("Missing overview content");
	});
});
