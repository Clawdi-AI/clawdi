import { describe, expect, test } from "bun:test";
import { agentOverviewGroups } from "@/lib/agent-capabilities";
import { agentNavigationSectionIds } from "@/lib/navigation-model";

describe("agent capabilities", () => {
	for (const variant of ["connected", "hosted"] as const) {
		test(`${variant} overview modules only link to supported sections`, () => {
			const supported = new Set(agentNavigationSectionIds(variant));
			for (const module of agentOverviewGroups(variant).flatMap((group) => group.modules)) {
				expect(supported.has(module.section)).toBe(true);
			}
		});
	}

	test("keeps the shared hierarchy stable while varying runtime modules", () => {
		const connected = agentOverviewGroups("connected");
		const hosted = agentOverviewGroups("hosted");
		expect(connected.map((group) => group.id)).toEqual(["now", "resources"]);
		expect(hosted.map((group) => group.id)).toEqual(["now", "resources", "operate"]);
		expect(connected[0]?.modules.map((module) => module.id)).toEqual(["sessions", "live-sync"]);
		expect(hosted[0]?.modules.map((module) => module.id)).toEqual([
			"sessions",
			"agent-interface",
			"compute",
		]);
		expect(connected[1]?.modules).toEqual(hosted[1]?.modules);
		expect(hosted[2]?.modules.map((module) => module.id)).toEqual(["model-provider", "channels"]);
	});

	test("gives Sessions and Projects the dominant module width", () => {
		for (const variant of ["connected", "hosted"] as const) {
			const modules = agentOverviewGroups(variant).flatMap((group) => group.modules);
			expect(modules.find((module) => module.id === "sessions")?.size).toBe("wide");
			expect(modules.find((module) => module.id === "projects")?.size).toBe("wide");
		}
	});

	test("keeps desktop columns explicit without presentation copy in the registry", () => {
		expect(agentOverviewGroups("connected").map((group) => group.columns)).toEqual([3, 3]);
		expect(agentOverviewGroups("hosted").map((group) => group.columns)).toEqual([4, 3, 3]);
		for (const group of [...agentOverviewGroups("connected"), ...agentOverviewGroups("hosted")]) {
			expect(Object.hasOwn(group, "description")).toBe(false);
		}
	});
});
