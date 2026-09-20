import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
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

export interface DesktopManagedNativeLayout {
	runtimeRoot?: string;
}

export interface HomebrewManagedNativeLayout {
	activationPath: string;
}

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

/** Recognize native executables whose lifecycle is owned by Clawdi Desktop.
 * The layout is the authority: shell launchers do not need to inject magic
 * environment variables, and copied native binaries remain untrusted. */
export function detectDesktopManagedNativeLayout(
	layout: CurrentCliLayout = resolveCurrentCliLayout(),
	platform: NodeJS.Platform = process.platform,
): DesktopManagedNativeLayout | null {
	if (layout.kind !== "native" || layout.nativeOwnership) return null;
	if (
		platform === "darwin" &&
		isMacApplicationBundleExecutable(layout.executablePath) &&
		existsSync(join(dirname(layout.resourceRoot), "app.asar"))
	) {
		return {};
	}
	if (
		platform === "linux" &&
		normalize(layout.executablePath) === "/opt/Clawdi/resources/native/clawdi" &&
		existsSync("/opt/Clawdi/resources/app.asar") &&
		existsSync("/opt/Clawdi/clawdi-desktop")
	) {
		return {};
	}
	if (
		platform === "win32" &&
		basename(layout.executablePath).toLowerCase() === "clawdi.exe" &&
		basename(layout.resourceRoot).toLowerCase() === "native" &&
		existsSync(join(dirname(layout.resourceRoot), "app.asar"))
	) {
		return {};
	}
	if (
		platform === "linux" &&
		basename(layout.executablePath) === "clawdi" &&
		hasDesktopRuntimeMarker(layout.resourceRoot)
	) {
		return { runtimeRoot: layout.resourceRoot };
	}
	return null;
}

export function isDesktopManagedCurrentCli(): boolean {
	try {
		return detectDesktopManagedNativeLayout() !== null;
	} catch {
		return false;
	}
}

/** Recognize Homebrew's immutable Cellar keg and return its stable opt path.
 * The opt symlink is suitable for supervisor units because it follows upgrades
 * without baking a versioned Cellar directory into launchd or systemd. */
export function detectHomebrewManagedNativeLayout(
	layout: CurrentCliLayout = resolveCurrentCliLayout(),
	platform: NodeJS.Platform = process.platform,
): HomebrewManagedNativeLayout | null {
	if (
		(platform !== "darwin" && platform !== "linux") ||
		layout.kind !== "native" ||
		layout.nativeOwnership ||
		basename(layout.executablePath) !== "clawdi" ||
		basename(layout.resourceRoot) !== "libexec"
	) {
		return null;
	}
	const keg = dirname(layout.resourceRoot);
	const formula = dirname(keg);
	const cellar = dirname(formula);
	if (basename(formula) !== "clawdi" || basename(cellar) !== "Cellar") return null;
	try {
		if (!existsSync(join(keg, "INSTALL_RECEIPT.json"))) return null;
		if (!existsSync(join(layout.resourceRoot, "egress-addon", "clawdi_egress_addon.py")))
			return null;
		if (!existsSync(join(layout.resourceRoot, "skills", "clawdi", "SKILL.md"))) return null;
		const activationPath = join(dirname(cellar), "opt", "clawdi", "libexec", "clawdi");
		if (realpathSync.native(activationPath) !== realpathSync.native(layout.executablePath))
			return null;
		return { activationPath };
	} catch {
		return null;
	}
}

export function isHomebrewManagedCurrentCli(): boolean {
	try {
		return detectHomebrewManagedNativeLayout() !== null;
	} catch {
		return false;
	}
}

export function isMacApplicationBundleExecutable(executablePath: string): boolean {
	const nativeDirectory = dirname(executablePath);
	const resourcesDirectory = dirname(nativeDirectory);
	const contentsDirectory = dirname(resourcesDirectory);
	const applicationDirectory = dirname(contentsDirectory);
	const applicationName = basename(applicationDirectory);
	return (
		basename(executablePath) === "clawdi" &&
		basename(nativeDirectory) === "native" &&
		basename(resourcesDirectory) === "Resources" &&
		basename(contentsDirectory) === "Contents" &&
		applicationName.length > ".app".length &&
		applicationName.endsWith(".app")
	);
}

function hasDesktopRuntimeMarker(runtimeRoot: string): boolean {
	try {
		const marker: unknown = JSON.parse(
			readFileSync(join(runtimeRoot, "desktop-runtime.json"), "utf8"),
		);
		return Boolean(
			marker &&
				typeof marker === "object" &&
				"version" in marker &&
				typeof marker.version === "string" &&
				/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(marker.version) &&
				basename(runtimeRoot) === marker.version &&
				basename(dirname(runtimeRoot)) === "runtimes" &&
				existsSync(join(runtimeRoot, "skills", "clawdi", "SKILL.md")),
		);
	} catch {
		return false;
	}
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
