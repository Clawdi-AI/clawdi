import { env } from "@/lib/env";

const LEGACY_HOSTED_DASHBOARD_URL = env.VITE_CLAWDI_LEGACY_DASHBOARD_URL.trim();

function isLocalhostUrl(rawUrl: string): boolean {
	try {
		const host = new URL(rawUrl).hostname;
		return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1";
	} catch {
		return false;
	}
}

function isLocalBrowserHost(): boolean {
	if (typeof window === "undefined") return false;
	const host = window.location.hostname;
	return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1";
}

/**
 * The env var has a localhost default for dev. Treat that as configured only
 * when the current dashboard also runs locally, matching deploy API gating.
 */
export function isLegacyHostedDashboardConfigured(): boolean {
	if (!LEGACY_HOSTED_DASHBOARD_URL) return false;
	if (!isLocalhostUrl(LEGACY_HOSTED_DASHBOARD_URL)) return true;
	return isLocalBrowserHost();
}

export function legacyHostedDashboardUrl(): string | null {
	return isLegacyHostedDashboardConfigured() ? LEGACY_HOSTED_DASHBOARD_URL : null;
}
