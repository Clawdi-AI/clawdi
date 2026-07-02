import { describe, expect, it } from "bun:test";
import { hostedProductAccessFromProfile } from "@/lib/hosted-product-access-model";

describe("hostedProductAccessFromProfile", () => {
	it("keeps hosted product surfaces hidden by default", () => {
		expect(hostedProductAccessFromProfile(undefined)).toEqual({
			canUseLegacyHostedDashboard: false,
			canUseCloudAgents: false,
		});
	});

	it("uses the backend per-user Cloud agents gate", () => {
		expect(
			hostedProductAccessFromProfile({
				capabilities: { can_use_v2: true },
			}),
		).toEqual({
			canUseLegacyHostedDashboard: false,
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
			canUseCloudAgents: false,
		});
	});

	it("keeps Cloud agents disabled when the backend gate is false", () => {
		expect(
			hostedProductAccessFromProfile({
				capabilities: {
					can_use_v1: false,
					can_use_v2: false,
				},
			}),
		).toEqual({
			canUseLegacyHostedDashboard: false,
			canUseCloudAgents: false,
		});
	});
});
