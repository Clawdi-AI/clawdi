export type RuntimeWindowRetirementReason = "deleting" | "restarted";

export interface TrackedRuntimeWindow {
	readonly closed?: boolean;
	close(): void;
	location: { replace(url: string | URL): void };
	sessionStorage: Pick<Storage, "setItem">;
}

export interface HermesRuntimeWindowLaunch {
	url: string;
}

const HERMES_RUNTIME_WINDOW_LAUNCH_KEY = "clawdi.hermes-runtime-window-launch";

const runtimeWindows = new Map<string, Set<TrackedRuntimeWindow>>();

function liveWindows(deploymentId: string): Set<TrackedRuntimeWindow> {
	const tracked = runtimeWindows.get(deploymentId) ?? new Set<TrackedRuntimeWindow>();
	for (const popup of tracked) {
		if (popup.closed) tracked.delete(popup);
	}
	if (tracked.size > 0) runtimeWindows.set(deploymentId, tracked);
	else runtimeWindows.delete(deploymentId);
	return tracked;
}

export function trackRuntimeWindow(deploymentId: string, popup: TrackedRuntimeWindow): void {
	const tracked = liveWindows(deploymentId);
	tracked.add(popup);
	runtimeWindows.set(deploymentId, tracked);
}

export function runtimeWindowRetirementUrl(
	origin: string,
	reason: RuntimeWindowRetirementReason,
): string {
	const url = new URL("/runtime-window", origin);
	url.searchParams.set("reason", reason);
	return url.toString();
}

export function launchHermesRuntimeWindow(
	deploymentId: string,
	url: string,
	popup: TrackedRuntimeWindow,
	origin = globalThis.location?.origin,
): boolean {
	if (!origin) return false;
	try {
		popup.sessionStorage.setItem(
			HERMES_RUNTIME_WINDOW_LAUNCH_KEY,
			JSON.stringify({ url } satisfies HermesRuntimeWindowLaunch),
		);
		popup.location.replace(new URL("/runtime-window", origin));
		trackRuntimeWindow(deploymentId, popup);
		return true;
	} catch {
		return false;
	}
}

export function consumeHermesRuntimeWindowLaunch(
	storage?: Pick<Storage, "getItem" | "removeItem">,
): HermesRuntimeWindowLaunch | null {
	try {
		const launchStorage = storage ?? globalThis.sessionStorage;
		if (!launchStorage) return null;
		const serialized = launchStorage.getItem(HERMES_RUNTIME_WINDOW_LAUNCH_KEY);
		launchStorage.removeItem(HERMES_RUNTIME_WINDOW_LAUNCH_KEY);
		if (!serialized) return null;
		const value: unknown = JSON.parse(serialized);
		if (typeof value !== "object" || value === null) return null;
		const url = Reflect.get(value, "url");
		if (typeof url !== "string") return null;
		const target = new URL(url);
		if (target.protocol !== "https:" && target.protocol !== "http:") return null;
		return { url: target.toString() };
	} catch {
		return null;
	}
}

/**
 * Retire only Clawdi-owned shells opened for this deployment. We do not inspect
 * or mutate the cross-origin runtime UI inside them.
 */
export function retireRuntimeWindows(
	deploymentId: string,
	reason: RuntimeWindowRetirementReason,
	origin = globalThis.location?.origin,
): void {
	const tracked = liveWindows(deploymentId);
	if (!origin) return;
	const statusUrl = runtimeWindowRetirementUrl(origin, reason);
	for (const popup of tracked) {
		try {
			popup.location.replace(statusUrl);
		} catch {
			try {
				popup.close();
			} catch {
				// Browser isolation may have severed the WindowProxy; no further control is honest.
			}
		}
	}
	runtimeWindows.delete(deploymentId);
}

export function clearTrackedRuntimeWindowsForTests(): void {
	runtimeWindows.clear();
}
