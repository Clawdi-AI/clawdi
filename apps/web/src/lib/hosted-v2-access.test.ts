import { describe, expect, it } from "bun:test";
import { hostedV2AccessFromProfile } from "@/lib/hosted-v2-access-model";

describe("hostedV2AccessFromProfile", () => {
	it("keeps v2 surfaces hidden by default", () => {
		expect(hostedV2AccessFromProfile(undefined)).toEqual({
			canUseV2: false,
		});
	});

	it("uses the backend per-user v2 gate", () => {
		expect(
			hostedV2AccessFromProfile({
				capabilities: { can_use_v2: true },
			}),
		).toEqual({
			canUseV2: true,
		});
	});

	it("keeps v2 disabled when the backend gate is false", () => {
		expect(
			hostedV2AccessFromProfile({
				capabilities: {
					can_use_v2: false,
				},
			}),
		).toEqual({
			canUseV2: false,
		});
	});
});
