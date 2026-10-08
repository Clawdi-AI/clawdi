import { expect, test } from "bun:test";
import type { ClawdiDesktopShellBridge } from "@clawdi/shared/desktop";
import { compatibleDesktopBridge } from "./desktop-bridge";

const betaOne: ClawdiDesktopShellBridge = {
	async signIn() {
		return { status: "authenticated" };
	},
	async signOut() {},
	async openConnectWizard() {},
	async retryDashboard() {},
	async createDashboardSession() {
		return "ticket";
	},
	async openFilesWindow() {
		return true;
	},
	async openRuntimeWindow() {
		return true;
	},
	async openTerminalWindow() {
		return true;
	},
};

test("preserves the released unversioned beta and version 1 bridge", () => {
	expect(compatibleDesktopBridge(betaOne) === betaOne).toBe(true);
	const current: ClawdiDesktopShellBridge = { ...betaOne, apiVersion: 1 };
	expect(compatibleDesktopBridge(current) === current).toBe(true);
});

test("rejects missing methods and unsupported versions", () => {
	for (const value of [null, {}, { ...betaOne, apiVersion: 2 }, { ...betaOne, signOut: null }]) {
		expect(compatibleDesktopBridge(value)).toBeNull();
	}
});

test("supports the minimal current bridge without legacy window or sign-in methods", () => {
	const current = {
		apiVersion: 2 as const,
		async signOut() {},
		async openConnectWizard() {},
		async createDashboardSession() {
			return { ticket: "fixture", accountId: "local" };
		},
		async openExternal() {},
	};
	expect(compatibleDesktopBridge(current)).toBe(current);
	expect(compatibleDesktopBridge({ ...current, createDashboardSession: null })).toBeNull();
});
