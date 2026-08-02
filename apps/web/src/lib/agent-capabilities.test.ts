import { describe, expect, test } from "bun:test";
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
	test("shares resource summaries and keeps hosted operations separate", () => {
		const connected = agentOverviewGroups("connected");
		const hosted = agentOverviewGroups("hosted");
		expect(connected.map((group) => group.id)).toEqual(["resources"]);
		expect(hosted.map((group) => group.id)).toEqual(["resources", "operate"]);
		expect(connected[0]?.modules.map((module) => module.id)).toEqual([
			"projects",
			"skills",
			"memories",
			"connectors",
			"vaults",
		]);
		expect(hosted[0]?.modules).toEqual(connected[0]?.modules);
		expect(hosted[1]?.modules.map((module) => module.id)).toEqual(["model-provider", "channels"]);
		expect(connected[0]?.layout).toBe("balanced-five");
		expect(hosted[1]?.layout).toBe("two-column");
		expect(connected[0]?.modules.find((module) => module.id === "connectors")?.size).toBe(
			"standard",
		);
		expect(connected[0]?.modules.find((module) => module.id === "projects")?.size).toBe("standard");
	});
});
