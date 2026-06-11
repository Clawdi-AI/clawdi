import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { chmodBestEffort, writePrivateFileAtomic } from "../lib/private-file";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimePaths } from "./paths";

export interface RuntimeCliUpdateResult {
	status: "not_requested" | "current" | "installed";
	packageSpec: string | null;
	registry: string | null;
	npmPrefix: string;
	npmCache: string;
	activePath: string;
	activeTarget: string | null;
	version: string | null;
}

interface RuntimeCliBootstrapStatus {
	status?: string;
	source?: string;
	packageSpec?: string;
	registry?: string | null;
	activePath?: string;
	activeTarget?: string;
	version?: string;
}

const NPM_INSTALL_TIMEOUT_MS = 180_000;
const VERSION_SMOKE_TIMEOUT_MS = 20_000;

export function applyRuntimeCliDesiredState(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
): RuntimeCliUpdateResult {
	const packageSpec = manifest.clawdiCli?.packageSpec?.trim();
	if (!packageSpec) {
		return baseResult("not_requested", paths, {
			packageSpec: null,
			registry: null,
			activeTarget: null,
			version: null,
		});
	}
	validatePackageSpec(packageSpec);
	const registry = cliRegistry(manifest);
	const current = readBootstrapStatus(paths.cliBootstrapStatus);
	if (isCurrentCliInstall(current, paths, packageSpec, registry)) {
		return baseResult("current", paths, {
			packageSpec,
			registry,
			activeTarget: current.activeTarget ?? null,
			version: current.version ?? null,
		});
	}

	const installed = installCliPackage(paths, packageSpec, registry);
	swapActiveCli(paths.cliManagedBin, installed.activeTarget);
	writeCliBootstrapStatus(paths, {
		packageSpec,
		registry,
		activeTarget: installed.activeTarget,
		version: installed.version,
	});
	return baseResult("installed", paths, {
		packageSpec,
		registry,
		activeTarget: installed.activeTarget,
		version: installed.version,
	});
}

function baseResult(
	status: RuntimeCliUpdateResult["status"],
	paths: RuntimePaths,
	values: Pick<RuntimeCliUpdateResult, "packageSpec" | "registry" | "activeTarget" | "version">,
): RuntimeCliUpdateResult {
	return {
		status,
		...values,
		npmPrefix: paths.cliNpmPrefix,
		npmCache: paths.cliNpmCache,
		activePath: paths.cliManagedBin,
	};
}

function cliRegistry(manifest: RuntimeManifest): string | null {
	const value = (manifest.clawdiCli as Record<string, unknown> | undefined)?.registry;
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validatePackageSpec(packageSpec: string): void {
	if (
		packageSpec === "clawdi" ||
		packageSpec.startsWith("clawdi@") ||
		(/^\/usr\/local\/share\/clawdi\/bootstrap\/[^/]+\.tgz$/.test(packageSpec) &&
			!packageSpec.includes(".."))
	) {
		return;
	}
	throw new Error(
		`clawdi CLI packageSpec must be clawdi, clawdi@..., or a managed bootstrap tarball: ${packageSpec}`,
	);
}

function readBootstrapStatus(path: string): RuntimeCliBootstrapStatus | null {
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as RuntimeCliBootstrapStatus;
	} catch {
		return null;
	}
}

function isCurrentCliInstall(
	status: RuntimeCliBootstrapStatus | null,
	paths: RuntimePaths,
	packageSpec: string,
	registry: string | null,
): status is RuntimeCliBootstrapStatus & { activeTarget: string } {
	if (!status) return false;
	if (status.status !== "installed" || status.source !== "npm") return false;
	if (status.packageSpec !== packageSpec) return false;
	if ((status.registry ?? null) !== registry) return false;
	if (status.activePath !== paths.cliManagedBin) return false;
	if (!status.activeTarget || !isExecutable(status.activeTarget)) return false;
	return isExecutable(paths.cliManagedBin);
}

function installCliPackage(
	paths: RuntimePaths,
	packageSpec: string,
	registry: string | null,
): { activeTarget: string; version: string } {
	mkdirSync(dirname(paths.cliManagedBin), { recursive: true });
	mkdirSync(paths.cliNpmPrefix, { recursive: true });
	mkdirSync(paths.cliNpmCache, { recursive: true });
	chmodBestEffort(dirname(paths.cliManagedBin), 0o755);
	chmodBestEffort(paths.cliNpmPrefix, 0o755);
	chmodBestEffort(paths.cliNpmCache, 0o755);

	const args = [
		"install",
		"-g",
		"--prefix",
		paths.cliNpmPrefix,
		"--cache",
		paths.cliNpmCache,
		"--ignore-scripts",
		"--fetch-retries",
		"2",
		"--fetch-retry-mintimeout",
		"1000",
		"--fetch-retry-maxtimeout",
		"10000",
		"--fetch-timeout",
		"60000",
		"--omit=dev",
		"--no-audit",
		"--no-fund",
		"--no-update-notifier",
		...(registry ? ["--registry", registry] : []),
		packageSpec,
	];
	const result = spawnSync("npm", args, {
		encoding: "utf8",
		timeout: NPM_INSTALL_TIMEOUT_MS,
		env: {
			...process.env,
			NO_UPDATE_NOTIFIER: "1",
			NPM_CONFIG_UPDATE_NOTIFIER: "false",
		},
	});
	if (result.status !== 0) {
		throw new Error(
			`npm install ${packageSpec} failed${result.status === null ? "" : ` (${result.status})`}${
				result.error ? `: ${result.error.message}` : ""
			}${commandOutput(result.stdout, result.stderr)}`,
		);
	}

	const activeTarget = `${paths.cliNpmPrefix}/bin/clawdi`;
	if (!isExecutable(activeTarget)) {
		throw new Error(`npm install completed but clawdi bin is missing: ${activeTarget}`);
	}
	const version = smokeCliVersion(activeTarget);
	return { activeTarget, version };
}

function commandOutput(stdout: string | null, stderr: string | null): string {
	const output = [stdout, stderr].filter(Boolean).join("\n").trim();
	return output ? `: ${output.slice(0, 1000)}` : "";
}

function smokeCliVersion(command: string): string {
	const result = spawnSync(command, ["--version"], {
		encoding: "utf8",
		timeout: VERSION_SMOKE_TIMEOUT_MS,
		env: {
			...process.env,
			CLAWDI_NO_AUTO_UPDATE: "1",
			CLAWDI_NO_UPDATE_CHECK: "1",
		},
	});
	if (result.status !== 0) {
		throw new Error(
			`installed clawdi did not pass --version smoke check${
				result.status === null ? "" : ` (${result.status})`
			}${result.error ? `: ${result.error.message}` : ""}${commandOutput(
				result.stdout,
				result.stderr,
			)}`,
		);
	}
	const version = result.stdout.trim().split(/\r?\n/, 1)[0]?.trim();
	if (!version) throw new Error("installed clawdi --version returned empty output");
	return version;
}

function swapActiveCli(activePath: string, activeTarget: string): void {
	const dir = dirname(activePath);
	mkdirSync(dir, { recursive: true });
	const tmp = `${dir}/.clawdi.next.${process.pid}.${Date.now()}`;
	try {
		rmSync(tmp, { force: true });
		symlinkSync(activeTarget, tmp);
		renameSync(tmp, activePath);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

function writeCliBootstrapStatus(
	paths: RuntimePaths,
	input: {
		packageSpec: string;
		registry: string | null;
		activeTarget: string;
		version: string;
	},
): void {
	writePrivateFileAtomic(
		paths.cliBootstrapStatus,
		`${JSON.stringify(
			{
				schemaVersion: "clawdi.cliNpmBootstrapStatus.v1",
				generatedAt: new Date().toISOString(),
				status: "installed",
				source: "npm",
				packageSpec: input.packageSpec,
				registry: input.registry,
				npmPrefix: paths.cliNpmPrefix,
				npmCache: paths.cliNpmCache,
				activePath: paths.cliManagedBin,
				activeTarget: input.activeTarget,
				version: input.version,
				error: null,
			},
			null,
			2,
		)}\n`,
		{ mode: 0o644, dirMode: 0o755 },
	);
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
