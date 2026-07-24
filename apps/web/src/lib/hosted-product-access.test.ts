import { describe, expect, it } from "bun:test";
import {
	hostedProductAccessFromProfile,
	hostedProductAccessStatus,
} from "@/lib/hosted-product-access-model";

describe("hostedProductAccessFromProfile", () => {
	it("keeps hosted product surfaces hidden by default", () => {
		expect(hostedProductAccessFromProfile(undefined)).toEqual({
			canUseLegacyHostedDashboard: false,
			canCreateCloudAgents: false,
			canUseCloudAgents: false,
		});
	});

	it("uses the backend per-user Cloud agent creation gate", () => {
		expect(
			hostedProductAccessFromProfile({
				capabilities: { can_use_v2: true },
			}),
		).toEqual({
			canUseLegacyHostedDashboard: false,
			canCreateCloudAgents: true,
			canUseCloudAgents: true,
		});
	});

	it("uses the backend per-user legacy agent gate", () => {
		expect(
			hostedProductAccessFromProfile({
				capabilities: { can_use_v1: true, can_use_v2: false },
			}),
		).toEqual({
			canUseLegacyHostedDashboard: true,
			canCreateCloudAgents: false,
			canUseCloudAgents: false,
		});
	});

	it("keeps Cloud agent creation disabled when the backend gate is false", () => {
		expect(
			hostedProductAccessFromProfile({
				capabilities: {
					can_use_v1: false,
					can_use_v2: false,
				},
			}),
		).toEqual({
			canUseLegacyHostedDashboard: false,
			canCreateCloudAgents: false,
			canUseCloudAgents: false,
		});
	});
});

describe("hostedProductAccessStatus", () => {
	it("keeps loading distinct from a completed denial", () => {
		expect(
			hostedProductAccessStatus({
				enabled: true,
				profile: undefined,
				isFetching: true,
				error: null,
			}),
		).toBe("loading");
	});

	it("treats a capability fetch failure as an error, not a denial", () => {
		expect(
			hostedProductAccessStatus({
				enabled: true,
				profile: undefined,
				isFetching: false,
				error: new Error("temporary failure"),
			}),
		).toBe("error");
	});

	it("only denies after a successful profile explicitly lacks v2 access", () => {
		expect(
			hostedProductAccessStatus({
				enabled: true,
				profile: { capabilities: { can_use_v2: false } },
				isFetching: false,
				error: null,
			}),
		).toBe("denied");
	});

	it("preserves the last successful allow during a failed background refresh", () => {
		expect(
			hostedProductAccessStatus({
				enabled: true,
				profile: { capabilities: { can_use_v2: true } },
				isFetching: false,
				error: new Error("refresh failed"),
			}),
		).toBe("allowed");
	});
});
