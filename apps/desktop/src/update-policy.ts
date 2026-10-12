export type DesktopUpdateSkipReason =
	| "development"
	| "unsupported-platform"
	| "mac-app-store"
	| "disabled-by-metadata"
	| "invalid-metadata";

export interface DesktopUpdatePolicyInput {
	isPackaged: boolean;
	platform: NodeJS.Platform;
	isMacAppStore: boolean;
	channel: unknown;
	isAppImage?: boolean;
}

export type DesktopUpdatePolicy =
	| { mode: "install" | "check" }
	| { mode: "disabled"; reason: DesktopUpdateSkipReason };

export function evaluateDesktopUpdatePolicy(input: DesktopUpdatePolicyInput): DesktopUpdatePolicy {
	if (!input.isPackaged) return { mode: "disabled", reason: "development" };
	if (!["darwin", "linux", "win32"].includes(input.platform))
		return { mode: "disabled", reason: "unsupported-platform" };
	if (input.isMacAppStore) return { mode: "disabled", reason: "mac-app-store" };
	if (input.channel === "disabled") {
		return { mode: "disabled", reason: "disabled-by-metadata" };
	}
	if (input.channel !== "stable" && input.channel !== "beta") {
		return { mode: "disabled", reason: "invalid-metadata" };
	}
	return { mode: input.platform === "linux" && !input.isAppImage ? "check" : "install" };
}
