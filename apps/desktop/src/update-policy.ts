import { parseDn } from "builder-util-runtime";

export type DesktopUpdateSkipReason =
	| "development"
	| "unsupported-platform"
	| "mac-app-store"
	| "disabled-by-metadata"
	| "invalid-metadata"
	| "unsigned"
	| "package-manager";

export interface DesktopCodeSignature {
	authorities: readonly string[];
	teamIdentifier: string | null;
}

export interface DesktopUpdatePolicyInput {
	isPackaged: boolean;
	platform: NodeJS.Platform;
	isMacAppStore: boolean;
	channel: unknown;
	signature: DesktopCodeSignature | null;
	isAppImage?: boolean;
	windowsPublisher?: unknown;
}

export type DesktopUpdatePolicy =
	| { enabled: true; channel: "stable" | "beta" }
	| { enabled: false; reason: DesktopUpdateSkipReason };

export function evaluateDesktopUpdatePolicy(input: DesktopUpdatePolicyInput): DesktopUpdatePolicy {
	if (!input.isPackaged) return { enabled: false, reason: "development" };
	if (!["darwin", "linux", "win32"].includes(input.platform))
		return { enabled: false, reason: "unsupported-platform" };
	if (input.isMacAppStore) return { enabled: false, reason: "mac-app-store" };
	if (input.channel === "disabled") {
		return { enabled: false, reason: "disabled-by-metadata" };
	}
	if (input.channel !== "stable" && input.channel !== "beta") {
		return { enabled: false, reason: "invalid-metadata" };
	}
	if (input.platform === "linux" && !input.isAppImage)
		return { enabled: false, reason: "package-manager" };
	if (input.platform === "win32" && !isDesktopWindowsPublisherDn(input.windowsPublisher))
		return { enabled: false, reason: "unsigned" };
	if (input.platform === "darwin" && !isDeveloperIdSignature(input.signature)) {
		return { enabled: false, reason: "unsigned" };
	}
	return { enabled: true, channel: input.channel };
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

// Require DN notation here. The release verifier checks the complete Subject;
// electron-updater remains responsible for downloaded-installer verification.
export function isDesktopWindowsPublisherDn(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value !== value.trim() ||
		["\r", "\n", "\0"].some((character) => value.includes(character))
	)
		return false;
	try {
		// Use the same RFC2253 parser as electron-updater 6.8.9, including quoted
		// and escaped values. Reject both a bare CN label and a CN-only DN.
		const fields = parseDn(value);
		return fields.has("CN") && fields.size > 1;
	} catch {
		return false;
	}
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
