import { describe, expect, test } from "bun:test";
import {
	type DesktopUpdatePolicyInput,
	type DesktopUpdateSkipReason,
	evaluateDesktopUpdatePolicy,
} from "./update-policy";

const RELEASE: DesktopUpdatePolicyInput = {
	isPackaged: true,
	platform: "darwin",
	isMacAppStore: false,
	channel: "stable",
};

describe("evaluateDesktopUpdatePolicy", () => {
	test("enables macOS, AppImage and Windows release updates on either channel", () => {
		for (const platform of ["darwin", "linux", "win32"] as const) {
			for (const channel of ["stable", "beta"] as const) {
				expect(
					evaluateDesktopUpdatePolicy({ ...RELEASE, platform, channel, isAppImage: true }),
				).toEqual({ mode: "install" });
			}
		}
	});

	test("skips unsupported environments and disabled or invalid metadata", () => {
		const cases = [
			[{ ...RELEASE, isPackaged: false }, "development"],
			[{ ...RELEASE, platform: "freebsd" }, "unsupported-platform"],
			[{ ...RELEASE, isMacAppStore: true }, "mac-app-store"],
			[{ ...RELEASE, channel: "disabled" }, "disabled-by-metadata"],
			[{ ...RELEASE, channel: "alpha" }, "invalid-metadata"],
		] satisfies Array<[DesktopUpdatePolicyInput, DesktopUpdateSkipReason]>;
		for (const [input, reason] of cases) {
			expect(evaluateDesktopUpdatePolicy(input)).toEqual({ mode: "disabled", reason });
		}
	});

	test("DEB/RPM check for releases without enabling self-install", () => {
		for (const channel of ["stable", "beta"] as const) {
			expect(
				evaluateDesktopUpdatePolicy({ ...RELEASE, platform: "linux", channel, isAppImage: false }),
			).toEqual({ mode: "check" });
		}
	});
});
