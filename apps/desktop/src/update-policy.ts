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
	signature: DesktopCodeSignature | null;
}

export type DesktopUpdatePolicy =
	| { enabled: true; channel: "stable" }
	| { enabled: false; reason: DesktopUpdateSkipReason };

export function evaluateDesktopUpdatePolicy(input: DesktopUpdatePolicyInput): DesktopUpdatePolicy {
	if (!input.isPackaged) return { enabled: false, reason: "development" };
	if (input.platform !== "darwin") return { enabled: false, reason: "unsupported-platform" };
	if (input.isMacAppStore) return { enabled: false, reason: "mac-app-store" };
	if (input.channel === "disabled") {
		return { enabled: false, reason: "disabled-by-metadata" };
	}
	if (input.channel !== "stable") return { enabled: false, reason: "invalid-metadata" };
	if (!isDeveloperIdSignature(input.signature)) return { enabled: false, reason: "unsigned" };
	return { enabled: true, channel: "stable" };
}

function isDeveloperIdSignature(signature: DesktopCodeSignature | null): boolean {
	return Boolean(
		signature?.teamIdentifier &&
			signature.authorities.some((authority) => authority.startsWith("Developer ID Application:")),
	);
}
