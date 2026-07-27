export interface TrackedRuntimeWindow {
	readonly closed?: boolean;
	close(): void;
}

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

export function retireRuntimeWindows(deploymentId: string): void {
	const tracked = liveWindows(deploymentId);
	for (const popup of tracked) {
		try {
			popup.close();
		} catch {
			// Browser isolation may have severed the WindowProxy; no further control is available.
		}
	}
	runtimeWindows.delete(deploymentId);
}

export function clearTrackedRuntimeWindowsForTests(): void {
	runtimeWindows.clear();
}
