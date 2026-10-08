import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent } from "electron";

export const DASHBOARD_ORIGIN = "https://cloud.clawdi.ai";
export const DASHBOARD_AUTH_URL = `${DASHBOARD_ORIGIN}/desktop-auth`;
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

export function allowsDashboardNavigation(raw: string): boolean {
	const url = strictHttpsUrl(raw);
	return !!url && (url.origin === DASHBOARD_ORIGIN || CLERK_ORIGINS.has(url.origin));
}

export function dashboardWindowOptions(preload: string): BrowserWindowConstructorOptions {
	return {
		width: 1280,
		height: 860,
		minWidth: 800,
		minHeight: 600,
		show: false,
		title: "Clawdi",
		webPreferences: {
			preload,
			partition: DASHBOARD_PARTITION,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	};
}

/** Validate the window, top frame and exact origin before exposing local authority. */
export function assertDashboardSender(
	event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
	contents: IpcMainInvokeEvent["sender"] | undefined,
	authPage = false,
): void {
	const frame = event.senderFrame;
	const url = frame && strictHttpsUrl(frame.url);
	if (
		event.sender !== contents ||
		!frame ||
		frame !== event.sender.mainFrame ||
		!url ||
		url.origin !== DASHBOARD_ORIGIN ||
		(authPage && (url.pathname !== "/desktop-auth" || url.search || url.hash))
	) {
		throw new Error("Unexpected dashboard client.");
	}
}
