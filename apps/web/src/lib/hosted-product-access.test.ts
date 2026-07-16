import { describe, expect, it } from "bun:test";
import { hostedProductAccessFromProfile } from "@/lib/hosted-product-access-model";

describe("hostedProductAccessFromProfile", () => {
	it("keeps hosted product surfaces hidden by default", () => {
		expect(hostedProductAccessFromProfile(undefined)).toEqual({
			canUseLegacyHostedDashboard: false,
			canCreateCloudAgents: false,
			canUsePlanCBilling: false,
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
			canUsePlanCBilling: false,
			canUseCloudAgents: true,
		});
	});

	it("keeps Plan C billing separate from the Cloud agent creation gate", () => {
		expect(
			hostedProductAccessFromProfile({
				capabilities: {
					can_use_v2: true,
					can_use_plan_c_billing: true,
				},
			}),
		).toEqual({
			canUseLegacyHostedDashboard: false,
			canCreateCloudAgents: true,
			canUsePlanCBilling: true,
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
			canUsePlanCBilling: false,
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
			canUsePlanCBilling: false,
			canUseCloudAgents: false,
		});
	});
});
