import { expect, test } from "bun:test";
import {
	allowsDashboardNavigation,
	allowsDashboardPermission,
	assertDashboardSender,
	DASHBOARD_PARTITION,
	dashboardAuthRedirect,
	dashboardClerkOrigins,
	dashboardOrigin,
	dashboardSessionIds,
	dashboardWindowOptions,
	readDesktopWebSession,
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
	expect(DASHBOARD_PARTITION.startsWith("persist:")).toBe(true);
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

test("configured web origin is used for navigation, bridge and window security", () => {
	const origin = dashboardOrigin("https://preview.example.test");
	expect(allowsDashboardNavigation(`${origin}/desktop-auth`, origin)).toBe(true);
	expect(allowsDashboardNavigation("https://cloud.clawdi.ai", origin)).toBe(false);

	for (const raw of [
		"http://example.test:3000",
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

test("loopback web and configured Clerk origins work without trusting other tenants", () => {
	for (const value of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])
		expect(dashboardOrigin(value)).toBe(value);
	const origins = dashboardClerkOrigins("https://clerk.staging.test,http://localhost:4000");
	expect(
		allowsDashboardNavigation(
			"https://clerk.staging.test/sign-in",
			"https://staging.test",
			origins,
		),
	).toBe(true);
	expect(
		allowsDashboardNavigation("https://clerk.clawdi.ai", "https://staging.test", origins),
	).toBe(false);
	expect(() => dashboardClerkOrigins("https://clerk.test/path")).toThrow();
});

test("subframes match web HTTPS CSP while the main frame stays restricted", () => {
	for (const url of [
		"https://js.stripe.com/v3/",
		"https://bank.test/3ds",
		"https://app.chatwoot.com/widget",
		"https://challenges.cloudflare.com/",
		"about:blank",
	]) {
		expect(allowsDashboardNavigation(url, undefined, undefined, false)).toBe(true);
		expect(allowsDashboardNavigation(url)).toBe(false);
	}
	for (const url of ["file:///tmp/x", "javascript:alert(1)", "http://evil.test/"])
		expect(allowsDashboardNavigation(url, undefined, undefined, false)).toBe(false);
});

test("only the web main frame may write sanitized clipboard content", () => {
	expect(
		allowsDashboardPermission("clipboard-sanitized-write", "https://cloud.clawdi.ai", true),
	).toBe(true);
	expect(allowsDashboardPermission("clipboard-read", "https://cloud.clawdi.ai", true)).toBe(false);
	expect(
		allowsDashboardPermission("clipboard-sanitized-write", "https://cloud.clawdi.ai", false),
	).toBe(false);
	expect(allowsDashboardPermission("clipboard-sanitized-write", "https://evil.test", true)).toBe(
		false,
	);
	expect(dashboardAuthRedirect("https://cloud.clawdi.ai/sign-in?redirect=x")).toBe(
		"https://cloud.clawdi.ai/desktop-auth",
	);
	expect(dashboardAuthRedirect("https://evil.test/sign-in")).toBeNull();
});

test("session inputs and cookie ID hints are bounded and validated", () => {
	const current = { userId: "user_fixture", sessionId: "sess_fixture" };
	expect(readDesktopWebSession(current)).toEqual(current);
	expect(readDesktopWebSession(null)).toBeNull();
	for (const value of [
		undefined,
		{},
		{ ...current, sessionId: "../revoke" },
		{ ...current, userId: "x".repeat(257) },
	])
		expect(() => readDesktopWebSession(value)).toThrow();
	const jwt =
		"header." +
		Buffer.from(JSON.stringify({ sid: "sess_fixture" })).toString("base64url") +
		".signature";
	expect(
		dashboardSessionIds([
			{ name: "__session", value: jwt },
			{ name: "__session_suffix", value: jwt },
		]),
	).toEqual(["sess_fixture"]);
	expect(dashboardSessionIds([{ name: "unrelated", value: "secret" }])).toEqual([]);
	expect(() => dashboardSessionIds([{ name: "__session", value: "malformed" }])).toThrow();
});
