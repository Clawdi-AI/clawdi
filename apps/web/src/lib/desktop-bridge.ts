import type { ClawdiDesktopShellBridge } from "@clawdi/shared/desktop";

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

export function compatibleDesktopBridge(value: unknown): ClawdiDesktopShellBridge | null {
	if (!value || typeof value !== "object") return null;
	const bridge = value as Record<string, unknown>;
	if (bridge.apiVersion !== undefined && bridge.apiVersion !== 1) return null;
	if (!methods.every((method) => typeof bridge[method] === "function")) return null;
	return value as ClawdiDesktopShellBridge;
}
