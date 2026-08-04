import { describe, expect, test } from "bun:test";
import {
	settingsDraftOwnerChanges,
	shouldCanonicalizeCloudSettings,
	validateDashboardSettingsSearch,
} from "@/lib/settings-routes";

describe("dashboard Settings search", () => {
	test("blocks only navigation that changes the Settings draft owner", () => {
		const current = {
			pathname: "/agents/env-1",
			search: { settings: "billing-wallet", source: "on-clawdi", d: "old" },
		};
		expect(
			settingsDraftOwnerChanges(current, {
				pathname: current.pathname,
				search: { ...current.search, d: "canonical" },
			}),
		).toBe(false);
		expect(
			settingsDraftOwnerChanges(current, {
				pathname: current.pathname,
				search: { ...current.search, settings: "billing-plan" },
			}),
		).toBe(true);
		expect(
			settingsDraftOwnerChanges(current, {
				pathname: "/projects",
				search: current.search,
			}),
		).toBe(true);
	});

	test("validates the global section while preserving child-route search", () => {
		expect(
			validateDashboardSettingsSearch({ settings: "billing-wallet", d: "hdep_1", keep: 1 }),
		).toEqual({ settings: "billing-wallet", d: "hdep_1", keep: 1 });
		expect(validateDashboardSettingsSearch({ settings: "unknown", keep: "yes" })).toEqual({
			keep: "yes",
		});
	});

	test("canonicalizes denied Cloud deep links only after access and inventory resolve", () => {
		const denied = {
			section: "billing-plan" as const,
			accessLoading: false,
			accessError: false,
			canCreateCloudAgents: false,
			inventoryResolved: true,
			hasExistingCloudAgents: false,
		};
		expect(shouldCanonicalizeCloudSettings(denied)).toBe(true);
		expect(shouldCanonicalizeCloudSettings({ ...denied, accessLoading: true })).toBe(false);
		expect(shouldCanonicalizeCloudSettings({ ...denied, inventoryResolved: false })).toBe(false);
		expect(shouldCanonicalizeCloudSettings({ ...denied, hasExistingCloudAgents: true })).toBe(
			false,
		);
	});
});
