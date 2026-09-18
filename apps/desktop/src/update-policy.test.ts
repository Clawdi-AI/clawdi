import { describe, expect, test } from "bun:test";
import {
	type DesktopUpdatePolicyInput,
	type DesktopUpdateSkipReason,
	evaluateDesktopUpdatePolicy,
} from "./update-policy";

const SIGNED_STABLE: DesktopUpdatePolicyInput = {
	isPackaged: true,
	platform: "darwin",
	isMacAppStore: false,
	channel: "stable",
	signature: {
		authorities: ["Developer ID Application: Clawdi, Inc. (ABC1234567)"],
		teamIdentifier: "ABC1234567",
	},
};

describe("evaluateDesktopUpdatePolicy", () => {
	test("enables only AppImage or publisher-pinned Windows release updates", () => {
		for (const platform of ["linux", "win32"] as const) {
			expect(
				evaluateDesktopUpdatePolicy({
					...SIGNED_STABLE,
					platform,
					signature: null,
					isAppImage: true,
					windowsPublisher: "CN=Clawdi Inc., O=Clawdi Inc., C=US",
				}).enabled,
			).toBe(true);
		}
	});
	test("enables signed beta macOS releases", () => {
		expect(evaluateDesktopUpdatePolicy({ ...SIGNED_STABLE, channel: "beta" })).toEqual({
			enabled: true,
			channel: "beta",
		});
	});
	test("enables signed stable macOS releases", () => {
		expect(evaluateDesktopUpdatePolicy(SIGNED_STABLE)).toEqual({
			enabled: true,
			channel: "stable",
		});
	});

	test("skips every unsupported or unsigned environment", () => {
		const cases = [
			[{ ...SIGNED_STABLE, isPackaged: false }, "development"],
			[{ ...SIGNED_STABLE, platform: "freebsd" }, "unsupported-platform"],
			[{ ...SIGNED_STABLE, platform: "linux" }, "package-manager"],
			[{ ...SIGNED_STABLE, platform: "win32" }, "unsigned"],
			[{ ...SIGNED_STABLE, isMacAppStore: true }, "mac-app-store"],
			[{ ...SIGNED_STABLE, channel: "disabled" }, "disabled-by-metadata"],
			[{ ...SIGNED_STABLE, channel: "alpha" }, "invalid-metadata"],
			[{ ...SIGNED_STABLE, signature: null }, "unsigned"],
			[
				{
					...SIGNED_STABLE,
					signature: {
						authorities: ["Apple Development: Example"],
						teamIdentifier: "ABC1234567",
					},
				},
				"unsigned",
			],
			[
				{
					...SIGNED_STABLE,
					signature: {
						authorities: ["Developer ID Application: Clawdi, Inc. (ABC1234567)"],
						teamIdentifier: null,
					},
				},
				"unsigned",
			],
		] satisfies Array<[DesktopUpdatePolicyInput, DesktopUpdateSkipReason]>;

		for (const [input, reason] of cases) {
			expect(evaluateDesktopUpdatePolicy(input)).toEqual({ enabled: false, reason });
		}
	});
});
