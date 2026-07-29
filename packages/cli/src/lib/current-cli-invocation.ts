import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
	currentNativeCompiledIdentity,
	detectNativeInstall,
	type NativeCompiledIdentity,
	type NativeInstallOwnership,
} from "./native-distribution";

export interface CurrentCliRuntime {
	execPath: string;
	argv: readonly string[];
	nativeIdentity: NativeCompiledIdentity | null;
}

export interface CurrentCliInvocation {
	command: string;
	args: string[];
	entryPath: string | null;
}

interface CurrentCliLayoutBase {
	executablePath: string;
	resourceRoot: string;
	activationPath: string;
}

export type CurrentCliLayout =
	| (CurrentCliLayoutBase & {
			kind: "native";
			nativeOwnership: NativeInstallOwnership | null;
	  })
	| (CurrentCliLayoutBase & {
			kind: "script";
			entryPath: string;
	  });

/**
 * Resolve the current CLI process into a command that can invoke this same
 * installation again. Native executables already contain the CLI, so
 * their first user argument must never be mistaken for a script entrypoint.
 */
export function resolveCurrentCliInvocation(
	cliArgs: readonly string[] = [],
	runtime: CurrentCliRuntime = currentCliRuntime(),
): CurrentCliInvocation {
	const layout = resolveCurrentCliLayout(runtime);
	if (layout.kind === "native") {
		return {
			command: layout.activationPath,
			args: [...cliArgs],
			entryPath: null,
		};
	}
	return {
		command: layout.executablePath,
		args: [layout.entryPath, ...cliArgs],
		entryPath: layout.entryPath,
	};
}

export function resolveCurrentCliLayout(
	runtime: CurrentCliRuntime = currentCliRuntime(),
): CurrentCliLayout {
	const executablePath = resolveAbsoluteRealpath(runtime.execPath, "CLI executable");
	if (runtime.nativeIdentity) {
		const nativeOwnership = detectNativeInstall(executablePath, runtime.nativeIdentity);
		return {
			kind: "native",
			executablePath,
			resourceRoot: dirname(executablePath),
			activationPath: nativeOwnership?.launcher ?? executablePath,
			nativeOwnership,
		};
	}
	const rawEntry = runtime.argv[1];
	if (!rawEntry) {
		throw new Error("could not resolve the current clawdi CLI script from process.argv[1]");
	}
	const entryPath = resolveAbsoluteRealpath(rawEntry, "CLI script");
	return {
		kind: "script",
		executablePath,
		entryPath,
		resourceRoot: resolveScriptResourceRoot(),
		activationPath: entryPath,
	};
}

export function resolveCurrentCliResourceRoot(): string {
	return resolveCurrentCliLayout().resourceRoot;
}

function currentCliRuntime(): CurrentCliRuntime {
	return {
		execPath: process.execPath,
		argv: process.argv,
		nativeIdentity: currentNativeCompiledIdentity(),
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

function resolveScriptResourceRoot(): string {
	let directory = dirname(realpathSync.native(fileURLToPath(import.meta.url)));
	while (dirname(directory) !== directory) {
		if (["dist", "src"].includes(basename(directory))) return dirname(directory);
		directory = dirname(directory);
	}
	throw new Error("could not resolve the clawdi package resource root");
}
