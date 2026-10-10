import { describe, expect, test } from "bun:test";
import { isClawdiDesktopBridge } from "./desktop";

describe("isClawdiDesktopBridge", () => {
	const bridge = {
		version: 1,
		openConnector: () => undefined,
		createDashboardSession: async () => ({ ticket: "t", accountId: "user_1" }),
		signOut: async () => undefined,
	};

	test("accepts the version 1 bridge", () => {
		expect(isClawdiDesktopBridge(Object.freeze({ ...bridge }))).toBe(true);
	});

	test("rejects a missing, newer, or incomplete bridge", () => {
		expect(isClawdiDesktopBridge(undefined)).toBe(false);
		expect(isClawdiDesktopBridge({ ...bridge, version: 2 })).toBe(false);
		expect(isClawdiDesktopBridge({ ...bridge, openConnector: undefined })).toBe(false);
	});
});
