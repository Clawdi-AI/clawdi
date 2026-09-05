export type DesktopUpdateSkipReason =
	| "development"
	| "unsupported-platform"
	| "mac-app-store"
	| "disabled-by-metadata"
	| "invalid-metadata"
	| "unsigned";

export interface DesktopCodeSignature {
	authorities: readonly string[];
	teamIdentifier: string | null;
}

export interface DesktopUpdatePolicyInput {
	isPackaged: boolean;
	platform: NodeJS.Platform;
	isMacAppStore: boolean;
	channel: unknown;
	feedUrl: unknown;
	signature: DesktopCodeSignature | null;
}

export type DesktopUpdatePolicy =
	| { enabled: true; channel: "stable"; feedUrl: string }
	| { enabled: false; reason: DesktopUpdateSkipReason };

export function evaluateDesktopUpdatePolicy(input: DesktopUpdatePolicyInput): DesktopUpdatePolicy {
	if (!input.isPackaged) return { enabled: false, reason: "development" };
	if (input.platform !== "darwin") return { enabled: false, reason: "unsupported-platform" };
	if (input.isMacAppStore) return { enabled: false, reason: "mac-app-store" };
	if (input.channel === "disabled") {
		return { enabled: false, reason: "disabled-by-metadata" };
	}
	if (input.channel !== "stable") return { enabled: false, reason: "invalid-metadata" };
	const feedUrl = normalizeDesktopUpdateFeedUrl(input.feedUrl);
	if (!feedUrl) return { enabled: false, reason: "invalid-metadata" };
	if (!isDeveloperIdSignature(input.signature)) {
		return { enabled: false, reason: "unsigned" };
	}
	return { enabled: true, channel: "stable", feedUrl };
}

export function normalizeDesktopUpdateFeedUrl(value: unknown): string | null {
	if (typeof value !== "string" || value !== value.trim()) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!url.hostname ||
		!url.pathname.endsWith("/")
	) {
		return null;
	}
	return url.href;
}

function normalizeTeamId(value: unknown): string | null {
	return typeof value === "string" && /^[A-Z0-9]{10}$/.test(value) ? value : null;
}

function isDeveloperIdSignature(signature: DesktopCodeSignature | null): boolean {
	return Boolean(
		signature &&
			normalizeTeamId(signature.teamIdentifier) &&
			signature.authorities.some((authority) => authority.startsWith("Developer ID Application:")),
	);
}
