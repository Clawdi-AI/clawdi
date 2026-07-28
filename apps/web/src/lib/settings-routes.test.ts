import { describe, expect, test } from "bun:test";
import { settingsLink, validateDashboardSettingsSearch } from "@/lib/settings-routes";

describe("dashboard Settings search", () => {
	test("validates the global section while preserving child-route search", () => {
		expect(
			validateDashboardSettingsSearch({ settings: "billing-wallet", d: "hdep_1", keep: 1 }),
		).toEqual({ settings: "billing-wallet", d: "hdep_1", keep: 1 });
		expect(validateDashboardSettingsSearch({ settings: "unknown", keep: "yes" })).toEqual({
			keep: "yes",
		});
	});

	test("opens Settings with functional search while preserving the current hash", () => {
		const link = settingsLink("billing-wallet");
		expect(link.to).toBe(".");
		expect(link.hash).toBe(true);
		expect(link.search({ keep: 1, settings: "general" })).toEqual({
			keep: 1,
			settings: "billing-wallet",
		});
	});
});
