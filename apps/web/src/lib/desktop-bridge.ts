import type { ClawdiDashboardBridge, ClawdiDesktopShellBridge } from "@clawdi/shared/desktop";

// TODO (2026-10-08): Remove after 2026-11-08; retained for Desktop beta.1–7.
const methods = [
	"signIn",
	"signOut",
	"openConnectWizard",
	"retryDashboard",
	"createDashboardSession",
	"openFilesWindow",
	"openRuntimeWindow",
	"openTerminalWindow",
] as const satisfies readonly (keyof ClawdiDesktopShellBridge)[];

export class DesktopBridgeCompatibilityError extends Error {
	constructor() {
		super("Unsupported Desktop bridge.");
	}
}

export function compatibleDesktopBridge(value: unknown): ClawdiDashboardBridge | null {
	if (!value || typeof value !== "object") return null;
	const bridge = value as Record<string, unknown>;
	if (bridge.apiVersion === 2) {
		return ["signOut", "openConnectWizard", "createDashboardSession", "openExternal"].every(
			(method) => typeof bridge[method] === "function",
		)
			? (value as ClawdiDashboardBridge)
			: null;
	}
	if (bridge.apiVersion !== undefined && bridge.apiVersion !== 1) return null;
	if (!methods.every((method) => typeof bridge[method] === "function")) return null;
	return value as ClawdiDesktopShellBridge;
}
