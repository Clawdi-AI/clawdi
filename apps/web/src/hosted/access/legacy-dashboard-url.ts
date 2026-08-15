import { env } from "@/lib/env";

function isLocalhostName(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "127.0.0.1" ||
		host === "::1" ||
		host === "[::1]"
	);
}

function isLocalhostUrl(rawUrl: string): boolean {
	try {
		return isLocalhostName(new URL(rawUrl).hostname);
	} catch {
		return false;
	}
}

function currentBrowserHostname(): string | null {
	if (typeof window === "undefined") return null;
	return window.location.hostname;
}

export function isLegacyHostedDashboardUrlAvailable(
	rawUrl: string,
	browserHostname: string | null = currentBrowserHostname(),
): boolean {
	const url = rawUrl.trim();
	if (!url) return false;
	if (!isLocalhostUrl(url)) return true;
	return browserHostname !== null && isLocalhostName(browserHostname);
}

export function legacyHostedDashboardUrl(): string | null {
	const url = env.VITE_CLAWDI_LEGACY_DASHBOARD_URL.trim();
	return isLegacyHostedDashboardUrlAvailable(url) ? url : null;
}
