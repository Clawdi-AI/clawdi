import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { chmodBestEffort, writePrivateFileAtomic } from "../lib/private-file";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimePaths } from "./paths";

export interface RuntimeCliUpdateResult {
	status: "not_requested" | "current" | "installed" | "deferred" | "error";
	packageSpec: string | null;
	registry: string | null;
	npmPrefix: string;
	npmCache: string;
	activePath: string;
	activeTarget: string | null;
	version: string | null;
	error?: string | null;
}

interface RuntimeCliBootstrapStatus {
	status?: string;
	source?: string;
	packageSpec?: string;
	registry?: string | null;
	npmPrefix?: string;
	activePath?: string;
	activeTarget?: string;
	version?: string;
}

const NPM_INSTALL_TIMEOUT_MS = 180_000;
const NPM_VIEW_TIMEOUT_MS = 30_000;
const VERSION_SMOKE_TIMEOUT_MS = 20_000;

export function applyRuntimeCliDesiredState(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	opts: { deferInstall?: boolean; deferReason?: string } = {},
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
			npmPrefix: current.npmPrefix ?? prefixForActiveTarget(current.activeTarget),
			activeTarget: current.activeTarget ?? null,
			version: current.version ?? null,
		});
	}
	const recovered = recoverCurrentCliInstallFromActiveLink(paths, packageSpec, registry);
	if (recovered) {
		writeCliBootstrapStatus(paths, {
			packageSpec,
			registry,
			npmPrefix: recovered.npmPrefix,
			activeTarget: recovered.activeTarget,
			version: recovered.version,
		});
		return baseResult("current", paths, {
			packageSpec,
			registry,
			npmPrefix: recovered.npmPrefix,
			activeTarget: recovered.activeTarget,
			version: recovered.version,
		});
	}
	if (opts.deferInstall) {
		return baseResult("deferred", paths, {
			packageSpec,
			registry,
			npmPrefix: current?.npmPrefix ?? paths.cliNpmPrefix,
			activeTarget: current?.activeTarget ?? null,
			version: current?.version ?? null,
			error: opts.deferReason ?? "CLI install retry is in backoff",
		});
	}

	const previousActivePrefix = current?.activeTarget
		? prefixForActiveTarget(current.activeTarget)
		: prefixForActiveLink(paths.cliManagedBin);
	const installed = installCliPackage(paths, packageSpec, registry);
	swapActiveCli(paths.cliManagedBin, installed.activeTarget);
	writeCliBootstrapStatus(paths, {
		packageSpec,
		registry,
		npmPrefix: installed.npmPrefix,
		activeTarget: installed.activeTarget,
		version: installed.version,
	});
	pruneCliPackagePrefixes(paths, [installed.npmPrefix, previousActivePrefix]);
	return baseResult("installed", paths, {
		packageSpec,
		registry,
		npmPrefix: installed.npmPrefix,
		activeTarget: installed.activeTarget,
		version: installed.version,
	});
}

type RuntimeCliResultValues = Pick<
	RuntimeCliUpdateResult,
	"packageSpec" | "registry" | "activeTarget" | "version"
> &
	Partial<Pick<RuntimeCliUpdateResult, "npmPrefix" | "npmCache" | "error">>;

function baseResult(
	status: RuntimeCliUpdateResult["status"],
	paths: RuntimePaths,
	values: RuntimeCliResultValues,
): RuntimeCliUpdateResult {
	return {
		status,
		...values,
		npmPrefix: values.npmPrefix ?? paths.cliNpmPrefix,
		npmCache: values.npmCache ?? paths.cliNpmCache,
		activePath: paths.cliManagedBin,
	};
}

function cliRegistry(manifest: RuntimeManifest): string | null {
	const value = (manifest.clawdiCli as Record<string, unknown> | undefined)?.registry;
	if (typeof value !== "string" || !value.trim()) return null;
	const registry = value.trim();
	let normalized: string;
	try {
		const parsed = new URL(registry);
		parsed.pathname = parsed.pathname.replace(/\/+$/, "");
		parsed.search = "";
		parsed.hash = "";
		normalized = parsed.toString().replace(/\/$/, "");
	} catch {
		throw new Error(`unsupported clawdi CLI registry: ${registry}`);
	}
	if (normalized !== "https://registry.npmjs.org") {
		throw new Error(`unsupported clawdi CLI registry: ${registry}`);
	}
	return "https://registry.npmjs.org";
}

function validatePackageSpec(packageSpec: string): void {
	if (packageSpec === "clawdi") {
		return;
	}
	if (/^clawdi@[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(packageSpec)) {
		return;
	}
	if (/^clawdi@[A-Za-z0-9._-]+$/.test(packageSpec)) {
		return;
	}
	if (
		/^\/usr\/local\/share\/clawdi\/bootstrap\/[^/]+\.tgz$/.test(packageSpec) &&
		!packageSpec.includes("..")
	) {
		return;
	}
	throw new Error(
		`clawdi CLI packageSpec must be clawdi, clawdi@<version-or-tag>, or a managed bootstrap tarball: ${packageSpec}`,
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
	if (!installedFloatingSpecVersionIsCurrent(status, packageSpec, registry)) return false;
	return isExecutable(paths.cliManagedBin);
}

function recoverCurrentCliInstallFromActiveLink(
	paths: RuntimePaths,
	packageSpec: string,
	registry: string | null,
): { npmPrefix: string; activeTarget: string; version: string } | null {
	const npmPrefix = cliPackagePrefix(paths, packageSpec, registry);
	const activeTarget = activeLinkTarget(paths.cliManagedBin);
	if (activeTarget !== join(npmPrefix, "bin", "clawdi")) return null;
	if (!isExecutable(activeTarget) || !isExecutable(paths.cliManagedBin)) return null;
	const version = smokeCliVersion(activeTarget);
	if (!installedFloatingSpecVersionIsCurrent({ version }, packageSpec, registry)) return null;
	return {
		npmPrefix,
		activeTarget,
		version,
	};
}

function installedFloatingSpecVersionIsCurrent(
	status: Pick<RuntimeCliBootstrapStatus, "version">,
	packageSpec: string,
	registry: string | null,
): boolean {
	if (!isFloatingNpmPackageSpec(packageSpec)) return true;
	if (!status.version) return false;
	const desiredVersion = resolveNpmPackageVersion(packageSpec, registry);
	return desiredVersion === null || status.version === desiredVersion;
}

function isFloatingNpmPackageSpec(packageSpec: string): boolean {
	if (packageSpec === "clawdi") return true;
	const match = /^clawdi@(.+)$/.exec(packageSpec);
	if (!match) return false;
	const specifier = match[1] ?? "";
	return !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(specifier);
}

function resolveNpmPackageVersion(packageSpec: string, registry: string | null): string | null {
	const result = spawnSync(
		"npm",
		["view", packageSpec, "version", "--json", ...(registry ? ["--registry", registry] : [])],
		{
			encoding: "utf8",
			timeout: NPM_VIEW_TIMEOUT_MS,
			env: {
				...process.env,
				NO_UPDATE_NOTIFIER: "1",
				NPM_CONFIG_UPDATE_NOTIFIER: "false",
			},
		},
	);
	if (result.status !== 0) return null;
	const output = result.stdout.trim();
	if (!output) return null;
	try {
		const parsed = JSON.parse(output) as unknown;
		return typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
	} catch {
		return output;
	}
}

function installCliPackage(
	paths: RuntimePaths,
	packageSpec: string,
	registry: string | null,
): { npmPrefix: string; activeTarget: string; version: string } {
	const npmPrefix = cliPackagePrefix(paths, packageSpec, registry);
	mkdirSync(dirname(paths.cliManagedBin), { recursive: true });
	mkdirSync(npmPrefix, { recursive: true });
	mkdirSync(paths.cliNpmCache, { recursive: true });
	chmodBestEffort(dirname(paths.cliManagedBin), 0o755);
	chmodBestEffort(paths.cliNpmPrefix, 0o755);
	chmodBestEffort(npmPrefix, 0o755);
	chmodBestEffort(paths.cliNpmCache, 0o755);

	const args = [
		"install",
		"-g",
		"--prefix",
		npmPrefix,
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

	const activeTarget = `${npmPrefix}/bin/clawdi`;
	if (!isExecutable(activeTarget)) {
		throw new Error(`npm install completed but clawdi bin is missing: ${activeTarget}`);
	}
	const version = smokeCliVersion(activeTarget);
	return { npmPrefix, activeTarget, version };
}

function cliPackagePrefix(
	paths: RuntimePaths,
	packageSpec: string,
	registry: string | null,
): string {
	const hash = createHash("sha256")
		.update(JSON.stringify({ packageSpec, registry }))
		.digest("hex")
		.slice(0, 16);
	return join(paths.cliNpmPrefix, "packages", hash);
}

function prefixForActiveTarget(activeTarget: string): string {
	return dirname(dirname(activeTarget));
}

function activeLinkTarget(activePath: string): string | null {
	try {
		return readlinkSync(activePath);
	} catch {
		return null;
	}
}

function prefixForActiveLink(activePath: string): string | null {
	const activeTarget = activeLinkTarget(activePath);
	return activeTarget ? prefixForActiveTarget(activeTarget) : null;
}

function pruneCliPackagePrefixes(paths: RuntimePaths, keepPrefixes: Array<string | null>): void {
	const packageRoot = join(paths.cliNpmPrefix, "packages");
	const keep = new Set(keepPrefixes.filter((value): value is string => Boolean(value)));
	try {
		for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = join(packageRoot, entry.name);
			if (!keep.has(path)) rmSync(path, { recursive: true, force: true });
		}
	} catch {
		// Best effort only; a failed prune must not block a validated CLI update.
	}
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
		npmPrefix: string;
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
				npmPrefix: input.npmPrefix,
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
