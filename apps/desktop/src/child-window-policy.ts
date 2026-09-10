export type DashboardChildKind = "files" | "runtime" | "terminal";

export interface DashboardChildState {
	kind: DashboardChildKind;
	origin: string;
}

const MAX_CHILD_URL_LENGTH = 8192;

export type ChildNavigationDecision =
	| { action: "allow" }
	| { action: "external" }
	| { action: "deny" };

export function evaluateChildNavigation(
	rawUrl: string,
	state: DashboardChildState,
): ChildNavigationDecision {
	const url = strictHttpsUrl(rawUrl);
	if (!url) return { action: "deny" };
	return url.origin === state.origin ? { action: "allow" } : { action: "external" };
}

export function allowsChildClipboard(
	state: DashboardChildState,
	currentUrl: string,
	requestingUrl: string,
	embeddingUrl: string,
): boolean {
	return [currentUrl, requestingUrl, embeddingUrl].every((url) => urlOrigin(url) === state.origin);
}

export function allowsChildDownload(
	state: DashboardChildState,
	currentUrl: string,
	downloadUrl: string,
): boolean {
	return (
		state.kind === "files" &&
		urlOrigin(currentUrl) === state.origin &&
		urlOrigin(downloadUrl) === state.origin
	);
}

export function strictHttpsUrl(rawUrl: string): URL | null {
	if (rawUrl.length === 0 || rawUrl.length > MAX_CHILD_URL_LENGTH) return null;
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return null;
	}
	return url.protocol === "https:" && !url.username && !url.password ? url : null;
}

export function dashboardChildUrl(
	rawUrl: string,
	kind: DashboardChildKind,
	dashboardOrigin: string,
): URL | null {
	const url = strictHttpsUrl(rawUrl);
	if (!url) return null;
	if (kind === "runtime") return url;
	if (url.search || url.hash) return null;
	if (kind === "files") return url.pathname === "/" ? url : null;
	if (url.origin !== dashboardOrigin) return null;
	const match = url.pathname.match(/^\/terminal\/([^/]+)$/);
	if (!match?.[1]) return null;
	try {
		const segment = decodeURIComponent(match[1]);
		return segment && !segment.includes("/") ? url : null;
	} catch {
		return null;
	}
}

function urlOrigin(rawUrl: string): string | null {
	try {
		return new URL(rawUrl).origin;
	} catch {
		return null;
	}
}
