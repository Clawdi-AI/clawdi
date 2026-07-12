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

interface RuntimeCliBadVersion {
	packageSpec: string;
	registry: string | null;
	version: string;
	reason: string;
	markedAt: string;
}

interface RuntimeCliPendingUpgrade {
	packageSpec: string;
	registry: string | null;
	version: string;
	npmPrefix: string;
	activeTarget: string;
	previousStatus: RuntimeCliBootstrapStatus | null;
	previousActiveTarget: string | null;
	previousNpmPrefix: string | null;
	previousVersion: string | null;
	manifestGeneration: number | null;
	manifestEtag: string | null;
	rollbackEligible: boolean;
	installedAt: string;
}

interface RuntimeCliUpgradeState {
	schemaVersion?: string;
	pendingUpgrade?: RuntimeCliPendingUpgrade | null;
	badVersions?: RuntimeCliBadVersion[];
}

export interface RuntimeCliRollbackResult {
	status: "not_pending" | "rolled_back" | "error";
	version: string | null;
	previousVersion: string | null;
	activeTarget: string | null;
	previousActiveTarget: string | null;
	error?: string | null;
}

const NPM_INSTALL_TIMEOUT_MS = 180_000;
const NPM_VIEW_TIMEOUT_MS = 30_000;
const VERSION_SMOKE_TIMEOUT_MS = 20_000;
const RUNTIME_VERIFY_TIMEOUT_MS = 20_000;

interface RuntimeCliManifestIdentity {
	generation?: number | null;
	etag?: string | null;
	previouslyApplied?: boolean;
}

export function applyRuntimeCliDesiredState(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	opts: {
		deferInstall?: boolean;
		deferReason?: string;
		manifestIdentity?: RuntimeCliManifestIdentity;
	} = {},
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

	const previousActiveTarget = current?.activeTarget ?? activeLinkTarget(paths.cliManagedBin);
	const previousActivePrefix = previousActiveTarget
		? prefixForActiveTarget(previousActiveTarget)
		: null;
	const installed = installCliPackage(paths, packageSpec, registry);
	swapActiveCli(paths.cliManagedBin, installed.activeTarget);
	writeCliBootstrapStatus(paths, {
		packageSpec,
		registry,
		npmPrefix: installed.npmPrefix,
		activeTarget: installed.activeTarget,
		version: installed.version,
	});
	markPendingCliUpgrade(paths, {
		packageSpec,
		registry,
		installed,
		previousStatus: current,
		previousActiveTarget,
		manifestIdentity: opts.manifestIdentity,
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
	if (
		/^clawdi@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(
			packageSpec,
		)
	) {
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
	if (!installedFloatingSpecVersionIsCurrent(paths, status, packageSpec, registry)) return false;
	return isExecutable(paths.cliManagedBin);
}

function recoverCurrentCliInstallFromActiveLink(
	paths: RuntimePaths,
	packageSpec: string,
	registry: string | null,
): { npmPrefix: string; activeTarget: string; version: string } | null {
	const desiredVersion = desiredNpmPackageVersion(paths, packageSpec, registry);
	if (!desiredVersion) return null;
	const npmPrefix = cliPackagePrefix(paths, desiredVersion);
	const legacyNpmPrefix = cliPackagePrefixForLegacyHash(paths, packageSpec, registry);
	const activeTarget = activeLinkTarget(paths.cliManagedBin);
	if (
		activeTarget !== join(npmPrefix, "bin", "clawdi") &&
		activeTarget !== join(legacyNpmPrefix, "bin", "clawdi")
	) {
		return null;
	}
	if (!isExecutable(activeTarget) || !isExecutable(paths.cliManagedBin)) return null;
	const version = smokeCliVersion(activeTarget);
	if (!installedFloatingSpecVersionIsCurrent(paths, { version }, packageSpec, registry))
		return null;
	return {
		npmPrefix: prefixForActiveTarget(activeTarget),
		activeTarget,
		version,
	};
}

function installedFloatingSpecVersionIsCurrent(
	paths: RuntimePaths,
	status: Pick<RuntimeCliBootstrapStatus, "version">,
	packageSpec: string,
	registry: string | null,
): boolean {
	const exact = exactNpmPackageVersion(packageSpec);
	if (exact) return status.version === exact;
	if (!isFloatingNpmPackageSpec(packageSpec)) return true;
	if (!status.version) return false;
	const desiredVersion = desiredNpmPackageVersion(paths, packageSpec, registry);
	return desiredVersion === null || status.version === desiredVersion;
}

function isFloatingNpmPackageSpec(packageSpec: string): boolean {
	const match = /^clawdi@(.+)$/.exec(packageSpec);
	if (!match) return false;
	const specifier = match[1] ?? "";
	if (!/^(agent-v2|alpha|beta|canary|next|rc)$/.test(specifier)) return false;
	return !isExactNpmPackageVersion(specifier);
}

function desiredNpmPackageVersion(
	paths: RuntimePaths,
	packageSpec: string,
	registry: string | null,
): string | null {
	const exact = exactNpmPackageVersion(packageSpec);
	if (exact) return exact;
	if (!isFloatingNpmPackageSpec(packageSpec)) return null;
	return resolveNpmPackageVersion(paths, packageSpec, registry);
}

function exactNpmPackageVersion(packageSpec: string): string | null {
	const match = /^clawdi@(.+)$/.exec(packageSpec);
	if (!match) return null;
	const specifier = match[1] ?? "";
	return isExactNpmPackageVersion(specifier) ? specifier : null;
}

function isExactNpmPackageVersion(value: string): boolean {
	return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(
		value,
	);
}

function resolveNpmPackageVersion(
	paths: RuntimePaths,
	packageSpec: string,
	registry: string | null,
): string | null {
	const result = spawnSync(
		"npm",
		[
			"view",
			packageSpec,
			"version",
			"--json",
			"--cache",
			paths.cliNpmCache,
			...(registry ? ["--registry", registry] : []),
		],
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
	const installPlan = cliInstallPlan(paths, packageSpec, registry);
	if (isBadCliVersion(paths, packageSpec, registry, installPlan.version)) {
		throw new Error(
			`clawdi CLI ${installPlan.version} is marked bad after rollback; waiting for a newer resolved version`,
		);
	}
	const npmPrefix = installPlan.npmPrefix;
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
		installPlan.installPackageSpec,
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
			`npm install ${installPlan.installPackageSpec} failed${result.status === null ? "" : ` (${result.status})`}${
				result.error ? `: ${result.error.message}` : ""
			}${commandOutput(result.stdout, result.stderr)}`,
		);
	}

	const activeTarget = `${npmPrefix}/bin/clawdi`;
	if (!isExecutable(activeTarget)) {
		throw new Error(`npm install completed but clawdi bin is missing: ${activeTarget}`);
	}
	const version = smokeCliVersion(activeTarget);
	const exactVersion = exactNpmPackageVersion(packageSpec);
	if (exactVersion && version !== exactVersion) {
		throw new Error(
			`npm install ${installPlan.installPackageSpec} reported version ${version}, expected ${exactVersion}`,
		);
	}
	verifyCliRuntime(activeTarget);
	return { npmPrefix, activeTarget, version };
}

function cliInstallPlan(
	paths: RuntimePaths,
	packageSpec: string,
	registry: string | null,
): { installPackageSpec: string; npmPrefix: string; version: string } {
	const version = desiredNpmPackageVersion(paths, packageSpec, registry);
	if (version) {
		return {
			installPackageSpec: `clawdi@${version}`,
			npmPrefix: cliPackagePrefix(paths, version),
			version,
		};
	}
	const hash = createHash("sha256")
		.update(JSON.stringify({ packageSpec, registry }))
		.digest("hex")
		.slice(0, 16);
	return {
		installPackageSpec: packageSpec,
		npmPrefix: join(paths.cliNpmPrefix, "packages", `tarball-${hash}`),
		version: `tarball-${hash}`,
	};
}

function cliPackagePrefix(paths: RuntimePaths, version: string): string {
	if (!/^[0-9A-Za-z._+-]+$/.test(version)) {
		throw new Error(`resolved clawdi CLI version contains unsafe path characters: ${version}`);
	}
	return join(paths.cliNpmPrefix, "packages", version);
}

function cliPackagePrefixForLegacyHash(
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

function verifyCliRuntime(command: string): void {
	const result = spawnSync(command, ["runtime", "verify", "--json"], {
		encoding: "utf8",
		timeout: RUNTIME_VERIFY_TIMEOUT_MS,
		env: {
			...process.env,
			CLAWDI_NO_AUTO_UPDATE: "1",
			CLAWDI_NO_UPDATE_CHECK: "1",
		},
	});
	if (result.status !== 0) {
		throw new Error(
			`installed clawdi did not pass runtime verify self-check${
				result.status === null ? "" : ` (${result.status})`
			}${result.error ? `: ${result.error.message}` : ""}${commandOutput(
				result.stdout,
				result.stderr,
			)}`,
		);
	}
	const output = result.stdout.trim();
	if (!output) {
		throw new Error("installed clawdi runtime verify self-check returned empty output");
	}
	try {
		const parsed = JSON.parse(output) as unknown;
		if (
			!parsed ||
			typeof parsed !== "object" ||
			Array.isArray(parsed) ||
			(parsed as Record<string, unknown>).status !== "ok"
		) {
			throw new Error("status was not ok");
		}
	} catch (error) {
		throw new Error(
			`installed clawdi runtime verify self-check returned invalid JSON: ${
				error instanceof Error ? error.message : String(error)
			}${commandOutput(result.stdout, result.stderr)}`,
		);
	}
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

export function rollbackPendingRuntimeCliUpgrade(
	paths: RuntimePaths,
	reason: string,
	manifestIdentity: RuntimeCliManifestIdentity = {},
): RuntimeCliRollbackResult {
	const state = readCliUpgradeState(paths);
	const pending = state.pendingUpgrade ?? null;
	if (!pending) {
		return {
			status: "not_pending",
			version: null,
			previousVersion: null,
			activeTarget: null,
			previousActiveTarget: null,
		};
	}
	if (!pending.rollbackEligible) {
		return {
			status: "not_pending",
			version: pending.version,
			previousVersion: pending.previousVersion,
			activeTarget: pending.activeTarget,
			previousActiveTarget: pending.previousActiveTarget,
		};
	}
	if (!pendingMatchesManifestIdentity(pending, manifestIdentity)) {
		return {
			status: "not_pending",
			version: pending.version,
			previousVersion: pending.previousVersion,
			activeTarget: pending.activeTarget,
			previousActiveTarget: pending.previousActiveTarget,
		};
	}
	if (!pending.previousActiveTarget || !isExecutable(pending.previousActiveTarget)) {
		return {
			status: "error",
			version: pending.version,
			previousVersion: pending.previousVersion,
			activeTarget: pending.activeTarget,
			previousActiveTarget: pending.previousActiveTarget,
			error: "previous clawdi CLI target is missing or not executable",
		};
	}
	try {
		swapActiveCli(paths.cliManagedBin, pending.previousActiveTarget);
		if (pending.previousStatus?.packageSpec && pending.previousStatus.activeTarget) {
			writeCliBootstrapStatus(paths, {
				packageSpec: pending.previousStatus.packageSpec,
				registry: pending.previousStatus.registry ?? null,
				npmPrefix:
					pending.previousStatus.npmPrefix ?? prefixForActiveTarget(pending.previousActiveTarget),
				activeTarget: pending.previousActiveTarget,
				version: pending.previousStatus.version ?? pending.previousVersion ?? "unknown",
			});
		}
		const nextState = normalizeCliUpgradeState(state);
		nextState.pendingUpgrade = null;
		nextState.badVersions = upsertBadVersion(nextState.badVersions ?? [], {
			packageSpec: pending.packageSpec,
			registry: pending.registry,
			version: pending.version,
			reason,
			markedAt: new Date().toISOString(),
		});
		writeCliUpgradeState(paths, nextState);
		pruneCliPackagePrefixes(paths, [pending.previousNpmPrefix]);
		return {
			status: "rolled_back",
			version: pending.version,
			previousVersion: pending.previousVersion,
			activeTarget: pending.activeTarget,
			previousActiveTarget: pending.previousActiveTarget,
			error: null,
		};
	} catch (error) {
		return {
			status: "error",
			version: pending.version,
			previousVersion: pending.previousVersion,
			activeTarget: pending.activeTarget,
			previousActiveTarget: pending.previousActiveTarget,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function completePendingRuntimeCliUpgrade(
	paths: RuntimePaths,
	currentVersion: string,
	manifestIdentity: RuntimeCliManifestIdentity = {},
): void {
	const state = readCliUpgradeState(paths);
	const pending = state.pendingUpgrade ?? null;
	if (!pending) return;
	if (pending.version !== currentVersion) return;
	if (!pendingMatchesManifestIdentity(pending, manifestIdentity)) return;
	const nextState = normalizeCliUpgradeState(state);
	nextState.pendingUpgrade = null;
	writeCliUpgradeState(paths, nextState);
}

function markPendingCliUpgrade(
	paths: RuntimePaths,
	input: {
		packageSpec: string;
		registry: string | null;
		installed: { npmPrefix: string; activeTarget: string; version: string };
		previousStatus: RuntimeCliBootstrapStatus | null;
		previousActiveTarget: string | null;
		manifestIdentity?: RuntimeCliManifestIdentity;
	},
): void {
	const state = normalizeCliUpgradeState(readCliUpgradeState(paths));
	state.pendingUpgrade = {
		packageSpec: input.packageSpec,
		registry: input.registry,
		version: input.installed.version,
		npmPrefix: input.installed.npmPrefix,
		activeTarget: input.installed.activeTarget,
		previousStatus: input.previousStatus,
		previousActiveTarget: input.previousActiveTarget,
		previousNpmPrefix: input.previousActiveTarget
			? prefixForActiveTarget(input.previousActiveTarget)
			: null,
		previousVersion: input.previousStatus?.version ?? null,
		manifestGeneration: input.manifestIdentity?.generation ?? null,
		manifestEtag: input.manifestIdentity?.etag ?? null,
		rollbackEligible: input.manifestIdentity?.previouslyApplied === true,
		installedAt: new Date().toISOString(),
	};
	writeCliUpgradeState(paths, state);
}

function isBadCliVersion(
	paths: RuntimePaths,
	packageSpec: string,
	registry: string | null,
	version: string,
): boolean {
	const state = readCliUpgradeState(paths);
	return (state.badVersions ?? []).some(
		(entry) =>
			entry.packageSpec === packageSpec &&
			(entry.registry ?? null) === registry &&
			entry.version === version,
	);
}

function readCliUpgradeState(paths: RuntimePaths): RuntimeCliUpgradeState {
	if (!existsSync(paths.cliUpgradeState)) return { schemaVersion: "clawdi.cliUpgradeState.v1" };
	try {
		const parsed = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { schemaVersion: "clawdi.cliUpgradeState.v1" };
		}
		return parsed as RuntimeCliUpgradeState;
	} catch {
		return { schemaVersion: "clawdi.cliUpgradeState.v1" };
	}
}

function writeCliUpgradeState(paths: RuntimePaths, state: RuntimeCliUpgradeState): void {
	writePrivateFileAtomic(
		paths.cliUpgradeState,
		`${JSON.stringify(normalizeCliUpgradeState(state), null, 2)}\n`,
		{ mode: 0o644, dirMode: 0o755 },
	);
}

function normalizeCliUpgradeState(state: RuntimeCliUpgradeState): RuntimeCliUpgradeState {
	return {
		schemaVersion: "clawdi.cliUpgradeState.v1",
		pendingUpgrade: state.pendingUpgrade ?? null,
		badVersions: state.badVersions ?? [],
	};
}

function upsertBadVersion(
	entries: RuntimeCliBadVersion[],
	entry: RuntimeCliBadVersion,
): RuntimeCliBadVersion[] {
	const next = entries.filter(
		(existing) =>
			existing.packageSpec !== entry.packageSpec ||
			(existing.registry ?? null) !== entry.registry ||
			existing.version !== entry.version,
	);
	next.push(entry);
	return next;
}

function pendingMatchesManifestIdentity(
	pending: RuntimeCliPendingUpgrade,
	manifestIdentity: RuntimeCliManifestIdentity,
): boolean {
	if (
		pending.manifestEtag &&
		manifestIdentity.etag &&
		pending.manifestEtag !== manifestIdentity.etag
	) {
		return false;
	}
	if (
		pending.manifestGeneration !== null &&
		manifestIdentity.generation !== undefined &&
		manifestIdentity.generation !== null &&
		pending.manifestGeneration !== manifestIdentity.generation
	) {
		return false;
	}
	return true;
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
