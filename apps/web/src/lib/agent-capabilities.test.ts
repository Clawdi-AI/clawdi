import { describe, expect, test } from "bun:test";
import { agentCapabilities } from "@/lib/agent-capabilities";
import { agentNavigationSectionIds } from "@/lib/navigation-model";

describe("agent capabilities", () => {
	for (const variant of ["connected", "hosted"] as const) {
		test(`${variant} overview links only advertise supported sections`, () => {
			const supported = new Set(agentNavigationSectionIds(variant));
			for (const capability of agentCapabilities(variant).overviewCapabilities) {
				expect(supported.has(capability.section)).toBe(true);
			}
		});
	}

	test("keeps runtime management exclusive to hosted agents", () => {
		expect(agentCapabilities("hosted").overviewCapabilities.map((item) => item.section)).toContain(
			"console",
		);
		expect(
			agentCapabilities("connected").overviewCapabilities.map((item) => item.section),
		).not.toContain("console");
	});
});
