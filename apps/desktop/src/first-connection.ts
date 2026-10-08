import { writeFileSync } from "node:fs";

/**
 * Records the first completed agent connection on this computer. Returns true
 * exactly once per marker path, so the dashboard opens automatically only after
 * the first Done and never on relaunch, re-sign-in or later connections.
 */
export function claimFirstConnection(markerPath: string): boolean {
	try {
		writeFileSync(markerPath, `${new Date().toISOString()}\n`, { flag: "wx" });
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
		throw error;
	}
}
