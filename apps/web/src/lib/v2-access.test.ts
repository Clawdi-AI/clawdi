import { describe, expect, it } from "bun:test";
import { v2AccessFromProfile } from "@/lib/v2-access-model";

describe("v2AccessFromProfile", () => {
	it("keeps v2 surfaces hidden by default", () => {
		expect(v2AccessFromProfile(undefined)).toEqual({
			canUseV2: false,
		});
	});

	it("uses the backend per-user v2 gate", () => {
		expect(
			v2AccessFromProfile({
				capabilities: { can_use_v2: true },
			}),
		).toEqual({
			canUseV2: true,
		});
	});

	it("keeps v2 disabled when the backend gate is false", () => {
		expect(
			v2AccessFromProfile({
				capabilities: {
					can_use_v2: false,
				},
			}),
		).toEqual({
			canUseV2: false,
		});
	});
});
