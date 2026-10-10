import type { DesktopWebSession } from "@clawdi/shared/desktop";
import type { BrowserWindowConstructorOptions } from "electron";

export const DASHBOARD_ORIGIN = "https://cloud.clawdi.ai";
// Exact first-party Clerk origins; no wildcard trust of other Clerk tenants.
const DEFAULT_CLERK_ORIGINS = ["https://clerk.clawdi.ai", "https://accounts.clawdi.ai"];
export const DASHBOARD_PARTITION = "persist:clawdi-dashboard";

export function strictHttpsUrl(raw: string): URL | null {
	if (!raw || raw.length > 8192) return null;
	try {
		const url = new URL(raw);
		return url.protocol === "https:" && !url.username && !url.password ? url : null;
	} catch {
		return null;
	}
}

function webUrl(raw: string): URL | null {
	if (!raw || raw.length > 8192) return null;
	try {
		const url = new URL(raw);
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		return !url.username &&
			!url.password &&
			(url.protocol === "https:" || (url.protocol === "http:" && loopback))
			? url
			: null;
	} catch {
		return null;
	}
}

export function dashboardClerkOrigins(configured?: string): readonly string[] {
	return configured === undefined
		? DEFAULT_CLERK_ORIGINS
		: configured.split(",").map((value) => dashboardOrigin(value.trim()));
}

export function allowsDashboardNavigation(
	raw: string,
	origin = DASHBOARD_ORIGIN,
	clerkOrigins = dashboardClerkOrigins(),
	mainFrame = true,
): boolean {
	if (!mainFrame) {
		// Match the web app's CSP frame-src https: (including bank-specific Stripe 3DS).
		return raw === "about:blank" || strictHttpsUrl(raw) !== null || webUrl(raw)?.origin === origin;
	}
	const url = webUrl(raw);
	return !!url && (url.origin === origin || clerkOrigins.includes(url.origin));
}

export function dashboardOrigin(configured = DASHBOARD_ORIGIN): string {
	const url = webUrl(configured);
	if (url?.pathname !== "/" || url.search || url.hash)
		throw new Error(
			"The Desktop web URL must be an HTTPS or local loopback origin without credentials.",
		);
	return url.origin;
}

export function dashboardAuthRedirect(raw: string, origin = DASHBOARD_ORIGIN): string | null {
	const url = webUrl(raw);
	return url?.origin === origin && /^\/sign-(?:in|up)(?:\/|$)/.test(url.pathname)
		? `${origin}/desktop-auth`
		: null;
}

export function allowsDashboardPermission(
	permission: string,
	requestingUrl: string,
	isMainFrame: boolean,
	origin = DASHBOARD_ORIGIN,
): boolean {
	return (
		permission === "clipboard-sanitized-write" &&
		isMainFrame &&
		webUrl(requestingUrl)?.origin === origin
	);
}

export function readDesktopWebSession(value: unknown): DesktopWebSession | null {
	if (value === null) return null;
	if (
		typeof value !== "object" ||
		!value ||
		!("userId" in value) ||
		typeof value.userId !== "string" ||
		!/^user_[A-Za-z0-9_]+$/.test(value.userId) ||
		value.userId.length > 256 ||
		!("sessionId" in value) ||
		typeof value.sessionId !== "string" ||
		!/^sess_[A-Za-z0-9]+$/.test(value.sessionId) ||
		value.sessionId.length > 256
	)
		throw new Error("Invalid Desktop web session.");
	return { userId: value.userId, sessionId: value.sessionId };
}

/** Cookie claims are untrusted ID hints; the backend checks Clerk ownership before revoking. */
export function dashboardSessionIds(cookies: readonly { name: string; value: string }[]): string[] {
	const ids = new Set<string>();
	for (const cookie of cookies) {
		// Clerk uses both unsuffixed and publishable-key-suffixed session cookies.
		if (!/^__session(?:_[A-Za-z0-9_-]+)?$/.test(cookie.name) || !cookie.value) continue;
		try {
			const payload = cookie.value.split(".")[1];
			if (!payload || cookie.value.length > 8192) throw new Error();
			const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
			if (
				typeof claims !== "object" ||
				!claims ||
				!("sid" in claims) ||
				typeof claims.sid !== "string" ||
				!/^sess_[A-Za-z0-9]+$/.test(claims.sid) ||
				claims.sid.length > 256
			)
				throw new Error();
			ids.add(claims.sid);
		} catch {
			throw new Error(
				"Couldn't identify the dashboard session. Open Dashboard and retry sign-out.",
			);
		}
	}
	return [...ids];
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
	const url = frame && webUrl(frame.url);
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
