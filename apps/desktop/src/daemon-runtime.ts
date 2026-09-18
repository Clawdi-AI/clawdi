import { posix, win32 } from "node:path";

export function desktopDaemonReconciliationAction(input: {
	installed: boolean;
	supervisorRunning: boolean;
	authenticated: boolean;
	alreadyReconciled: boolean;
	isAppImage: boolean;
	liveRuntimeMismatch: boolean;
}): "install" | null {
	if (!input.installed || !input.authenticated || input.alreadyReconciled) return null;
	// A stopped AppImage unit still points at the previous immutable runtime.
	// Rebind it once without trying to infer its ExecStart from stale health.
	return (input.isAppImage && !input.supervisorRunning) || input.liveRuntimeMismatch
		? "install"
		: null;
}

export function needsDaemonRuntimeRefresh(
	version: string,
	executable: string,
	liveDaemons: readonly { version: string | null; executable: string | null }[],
	platform: NodeJS.Platform = process.platform,
): boolean {
	const path = platform === "win32" ? win32 : posix;
	const canonical = (value: string) =>
		platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value);
	return liveDaemons.some((daemon) => {
		// A live legacy heartbeat has no version/path. Refresh it once rather
		// than letting an unidentified old process survive indefinitely.
		if (daemon.version !== version) return true;
		// Older health records do not identify the executable. Refresh once to
		// establish it, including when an app bundle moved without a CLI bump.
		return (
			!daemon.executable ||
			!path.isAbsolute(daemon.executable) ||
			canonical(daemon.executable) !== canonical(executable)
		);
	});
}
