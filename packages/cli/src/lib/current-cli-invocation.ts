import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface CurrentCliRuntime {
	execPath: string;
	argv: readonly string[];
}

export interface CurrentCliInvocation {
	command: string;
	args: string[];
	entryPath: string;
}

/**
 * Resolve the current CLI process into a command that can invoke this same
 * script installation again.
 */
export function resolveCurrentCliInvocation(
	cliArgs: readonly string[] = [],
	runtime: CurrentCliRuntime = currentCliRuntime(),
): CurrentCliInvocation {
	const command = resolveAbsoluteRealpath(runtime.execPath, "CLI executable");
	const rawEntry = runtime.argv[1];
	if (!rawEntry) {
		throw new Error("could not resolve the current clawdi CLI script from process.argv[1]");
	}
	const entryPath = resolveAbsoluteRealpath(rawEntry, "CLI script");
	return {
		command,
		args: [entryPath, ...cliArgs],
		entryPath,
	};
}

function currentCliRuntime(): CurrentCliRuntime {
	return {
		execPath: process.execPath,
		argv: process.argv,
	};
}

function resolveAbsoluteRealpath(path: string, label: string): string {
	let resolved: string;
	try {
		resolved = realpathSync.native(path);
	} catch (error) {
		throw new Error(
			`could not resolve ${label} path ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isAbsolute(resolved)) {
		throw new Error(`refusing to invoke a relative ${label} path: ${resolved}`);
	}
	return resolved;
}
