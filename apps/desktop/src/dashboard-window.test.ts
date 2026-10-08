import { expect, test } from "bun:test";
import {
	allowsDashboardNavigation,
	DASHBOARD_PARTITION,
	dashboardWindowOptions,
	strictHttpsUrl,
} from "./dashboard-window";

test("remote dashboard is isolated from Connect and has no Node access", () => {
	const options = dashboardWindowOptions("/app/shell-preload.cjs");
	expect(options.webPreferences).toEqual({
		preload: "/app/shell-preload.cjs",
		partition: DASHBOARD_PARTITION,
		contextIsolation: true,
		nodeIntegration: false,
		sandbox: true,
	});
	expect(DASHBOARD_PARTITION.startsWith("persist:")).toBe(false);
});

test("navigation trusts exact Clawdi and first-party Clerk origins only", () => {
	for (const url of [
		"https://cloud.clawdi.ai/desktop-auth",
		"https://clerk.clawdi.ai/",
		"https://accounts.clawdi.ai/sign-in",
	]) {
		expect(allowsDashboardNavigation(url)).toBe(true);
	}
	for (const url of [
		"https://cloud.clawdi.ai.evil.test/",
		"https://other.clerk.accounts.dev/",
		"https://evil.test/?next=https://cloud.clawdi.ai",
		"https://cloud.clawdi.ai:444/",
		"http://cloud.clawdi.ai/",
		"javascript:alert(1)",
		"file:///etc/passwd",
		"https://user:password@cloud.clawdi.ai/",
		"clawdi-desktop://connect",
		"invalid",
	])
		expect(allowsDashboardNavigation(url)).toBe(false);
});

test("external URLs reject credentials and unsafe protocols", () => {
	expect(strictHttpsUrl("https://docs.clawdi.ai/start")?.href).toBe("https://docs.clawdi.ai/start");
	for (const value of [
		"javascript:alert(1)",
		"file:///tmp/x",
		"http://localhost/",
		"mailto:a@test.com",
		"https://u:p@test.com/",
		"x".repeat(8193),
	]) {
		expect(strictHttpsUrl(value)).toBeNull();
	}
});
