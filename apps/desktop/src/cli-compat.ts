import { posix, win32 } from "node:path";
import { compareSemver, isValidSemver } from "../../../packages/cli/src/lib/semver";

export const DESKTOP_MIN_CLI_VERSION = "0.16.8";
export const UPDATE_DESKTOP_MESSAGE =
	"Update Clawdi Desktop to use the installed Clawdi CLI. This CLI uses a newer Desktop interface.";

export class DesktopCliError extends Error {}

export class DesktopCliCompatibilityError extends DesktopCliError {
	constructor() {
		super(UPDATE_DESKTOP_MESSAGE);
	}
}

export function nativeLauncherPath(platform: NodeJS.Platform, home: string): string {
	return platform === "win32"
		? win32.join(home, ".local", "share", "clawdi", "current", "clawdi.exe")
		: posix.join(home, ".local", "bin", "clawdi");
}

export function meetsDesktopCliMinimum(version: string): boolean {
	return isValidSemver(version) && compareSemver(version, DESKTOP_MIN_CLI_VERSION) >= 0;
}

/** Missing/malformed output stays a command validation error. A different
 * major of a known interface needs a Desktop update, including through IPC. */
export function assertCompatibleCliSchema(actual: unknown, expected: string): void {
	if (
		typeof actual === "string" &&
		actual !== expected &&
		actual.replace(/\.v\d+$/, "") === expected.replace(/\.v\d+$/, "") &&
		/\.v\d+$/.test(actual)
	) {
		throw new DesktopCliCompatibilityError();
	}
}
