import { expect, test } from "bun:test";
import {
	allowsDashboardNavigation,
	assertDashboardSender,
	DASHBOARD_PARTITION,
	dashboardBrowserUrl,
	dashboardOrigin,
	dashboardWindowOptions,
	strictHttpsUrl,
} from "./dashboard-window";

test("remote dashboard is isolated from Connect and has no Node access", () => {
	const options = dashboardWindowOptions("/app/shell-preload.cjs");
	expect(options.webPreferences).toEqual({
		preload: "/app/shell-preload.cjs",
		additionalArguments: ["--clawdi-dashboard-origin=https://cloud.clawdi.ai"],
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

test("browser handoff stays on our HTTPS origin and excludes the ticket page", () => {
	expect(dashboardBrowserUrl("https://cloud.clawdi.ai/settings")).toBe(
		"https://cloud.clawdi.ai/settings",
	);
	for (const raw of [
		null,
		{},
		42,
		"https://evil.test",
		"https://cloud.clawdi.ai:444",
		"https://cloud.clawdi.ai/desktop-auth#ticket=x",
		"https://cloud.clawdi.ai/desktop-auth/",
		"https://u:p@cloud.clawdi.ai",
		"http://cloud.clawdi.ai",
	])
		expect(() => dashboardBrowserUrl(raw)).toThrow();
});

test("configured web origin is used for navigation, bridge and window security", () => {
	const origin = dashboardOrigin("https://preview.example.test");
	expect(allowsDashboardNavigation(`${origin}/desktop-auth`, origin)).toBe(true);
	expect(allowsDashboardNavigation("https://cloud.clawdi.ai", origin)).toBe(false);
	expect(dashboardBrowserUrl(`${origin}/settings`, origin)).toBe(`${origin}/settings`);
	for (const raw of [
		"http://localhost:3000",
		"https://cloud.clawdi.ai/path",
		"https://cloud.clawdi.ai?q=x",
		"https://cloud.clawdi.ai/#x",
	])
		expect(() => dashboardOrigin(raw)).toThrow();
});

test("IPC requires the dashboard main frame; tickets require the exact auth page", () => {
	const frame = { url: "https://cloud.clawdi.ai/desktop-auth" };
	const sender = { mainFrame: frame };
	const event = { sender, senderFrame: frame };
	expect(() => assertDashboardSender(event, sender, true)).not.toThrow();
	expect(() => assertDashboardSender(event, { mainFrame: frame })).toThrow();
	expect(() =>
		assertDashboardSender({ ...event, senderFrame: { url: frame.url } }, sender),
	).toThrow();
	expect(() => assertDashboardSender({ ...event, senderFrame: null }, sender)).toThrow();
	for (const url of [
		"https://cloud.clawdi.ai/",
		"https://clerk.clawdi.ai/desktop-auth",
		"https://evil.test/desktop-auth",
		"https://cloud.clawdi.ai/desktop-auth?ticket=x",
		"https://cloud.clawdi.ai/desktop-auth#ticket=x",
	]) {
		frame.url = url;
		expect(() => assertDashboardSender(event, sender, true)).toThrow();
	}
});
