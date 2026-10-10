import type { BrowserWindowConstructorOptions } from "electron";

export const DASHBOARD_ORIGIN = "https://cloud.clawdi.ai";
// Exact first-party Clerk origins; no wildcard trust of other Clerk tenants.
const CLERK_ORIGINS = new Set(["https://clerk.clawdi.ai", "https://accounts.clawdi.ai"]);
export const DASHBOARD_PARTITION = "clawdi-dashboard";

export function strictHttpsUrl(raw: string): URL | null {
	if (!raw || raw.length > 8192) return null;
	try {
		const url = new URL(raw);
		return url.protocol === "https:" && !url.username && !url.password ? url : null;
	} catch {
		return null;
	}
}

export function allowsDashboardNavigation(raw: string, origin = DASHBOARD_ORIGIN): boolean {
	const url = strictHttpsUrl(raw);
	return !!url && (url.origin === origin || CLERK_ORIGINS.has(url.origin));
}

export function dashboardOrigin(configured = DASHBOARD_ORIGIN): string {
	const url = strictHttpsUrl(configured);
	if (!url || url.pathname !== "/" || url.search || url.hash)
		throw new Error("The Desktop web URL must be an HTTPS origin without credentials.");
	return url.origin;
}

/** Browser handoffs stay on the configured web origin and exclude the auth page. */
export function dashboardBrowserUrl(value: unknown, origin = DASHBOARD_ORIGIN): string {
	const url = typeof value === "string" ? strictHttpsUrl(value) : null;
	if (!url || url.origin !== origin || url.pathname.replace(/\/+$/, "") === "/desktop-auth")
		throw new Error("Invalid browser link.");
	return url.href;
}

export function dashboardWindowOptions(
	preload: string,
	origin = DASHBOARD_ORIGIN,
): BrowserWindowConstructorOptions {
	return {
		width: 1280,
		height: 860,
		minWidth: 800,
		minHeight: 600,
		show: false,
		title: "Clawdi",
		webPreferences: {
			preload,
			additionalArguments: [`--clawdi-dashboard-origin=${origin}`],
			partition: DASHBOARD_PARTITION,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	};
}

/** Validate the window, top frame and exact origin before exposing local authority. */
export function assertDashboardSender(
	event: DashboardIpcEvent,
	contents: DashboardIpcEvent["sender"] | undefined,
	authPage = false,
	origin = DASHBOARD_ORIGIN,
): void {
	const frame = event.senderFrame;
	const url = frame && strictHttpsUrl(frame.url);
	if (
		event.sender !== contents ||
		!frame ||
		frame !== event.sender.mainFrame ||
		!url ||
		url.origin !== origin ||
		(authPage && (url.pathname !== "/desktop-auth" || url.search || url.hash))
	) {
		throw new Error("Unexpected dashboard client.");
	}
}

interface DashboardIpcEvent {
	sender: { readonly mainFrame: { readonly url: string } };
	senderFrame: { readonly url: string } | null;
}
