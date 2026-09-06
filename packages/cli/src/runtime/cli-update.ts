import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { log, toErrorMessage } from "../serve/log";
import { HOSTED_RUNTIME_HOME, HOSTED_RUNTIME_USER } from "./hosted-runtime-contract";
import { hostedCliPackageSpecSchema, type RuntimeManifest } from "./manifest-contract";
import type { RuntimePaths } from "./paths";
import { writeRuntimePlatformFileAtomic } from "./state";

export interface RuntimeCliUpdateResult {
	status: "not_requested" | "current" | "installed" | "deferred" | "error";
	packageSpec: string | null;
	registry: string | null;
	npmPrefix: string;
	npmCache: string;
	activePath: string;
	activeTarget: string | null;
	version: string | null;
	retryAt: string | null;
	// The active managed target no longer matches the code in this process.
	// Callers must stop before manifest convergence or any authority side effect.
	selfReexec: boolean;
	error?: string | null;
}

export interface RuntimeCliRollbackResult {
	status: "not_pending" | "rolled_back" | "error";
	version: string | null;
	previousVersion: string | null;
	activeTarget: string | null;
	previousActiveTarget: string | null;
	error?: string | null;
}

export interface RuntimeCliReconciliationResult {
	status: "unchanged" | "rolled_back";
	selfReexec: boolean;
}

const NPM_REGISTRY = "https://registry.npmjs.org";
const NPM_INSTALL_TIMEOUT_MS = 180_000;
const VERSION_SMOKE_TIMEOUT_MS = 20_000;
const RUNTIME_VERIFY_TIMEOUT_MS = 20_000;
const CLI_VERIFY_CACHE_MAX_AGE_MS = 300_000;
const CLI_RETRY_INITIAL_BACKOFF_MS = 60_000;
const CLI_RETRY_MAX_BACKOFF_MS = 3_600_000;
const HOSTED_TENANT_PATH_CLI = "/usr/local/bin/clawdi";
const HOSTED_SYSTEM_NPM_CLI = "/usr/local/lib/node_modules/clawdi/bin/clawdi.mjs";

const runtimeCliVerificationSchema = z
	.object({
		verifiedAt: z.string().min(1),
		device: z.number().int().nonnegative(),
		inode: z.number().int().nonnegative(),
		size: z.number().int().nonnegative(),
		modifiedAtMs: z.number().nonnegative(),
	})
	.strict();

type RuntimeCliVerification = z.infer<typeof runtimeCliVerificationSchema>;

const runtimeCliTargetSchema = z
	.object({
		activeTarget: z.string().min(1),
		version: z.string().min(1),
	})
	.strict();

type RuntimeCliTarget = z.infer<typeof runtimeCliTargetSchema>;

const runtimeCliBadSchema = z
	.object({
		version: z.string().min(1),
		reason: z.string().min(1),
		attempts: z.number().int().positive(),
		failedAt: z.string().min(1),
		retryAt: z.string().min(1),
	})
	.strict();

type RuntimeCliBad = z.infer<typeof runtimeCliBadSchema>;

const runtimeCliStateSchema = z
	.object({
		schemaVersion: z.literal("clawdi.cliNpmBootstrapStatus.v1"),
		generatedAt: z.string().min(1),
		status: z.literal("installed"),
		source: z.literal("npm"),
		packageSpec: hostedCliPackageSpecSchema,
		registry: z.literal(NPM_REGISTRY),
		npmPrefix: z.string().min(1),
		npmCache: z.string().min(1),
		activePath: z.string().min(1),
		activeTarget: z.string().min(1),
		version: z.string().min(1),
		verification: runtimeCliVerificationSchema,
		previous: runtimeCliTargetSchema.nullable(),
		bad: runtimeCliBadSchema.nullable(),
		error: z.null(),
	})
	.strict();

// Released images write this phase before the CLI has adopted the installation.
// Only the complete legacy field set is accepted, never a partial verification.
const runtimeCliBootstrapSchema = runtimeCliStateSchema.omit({
	verification: true,
	previous: true,
	bad: true,
});
const runtimeCliReceiptSchema = z.union([runtimeCliStateSchema, runtimeCliBootstrapSchema]);
export type RuntimeCliBootstrapStatus = z.infer<typeof runtimeCliReceiptSchema>;
type RuntimeCliState = z.infer<typeof runtimeCliStateSchema>;

interface VerifiedCliTarget extends RuntimeCliTarget {
	verification: RuntimeCliVerification;
}

export function removeHostedCliPathExposure(paths: RuntimePaths): void {
	if (
		paths.mode !== "hosted" ||
		paths.userHome !== HOSTED_RUNTIME_HOME ||
		process.env.CLAWDI_RUNTIME_USER?.trim() !== HOSTED_RUNTIME_USER ||
		(typeof process.geteuid === "function" && process.geteuid() !== 0)
	) {
		return;
	}
	let node: ReturnType<typeof lstatSync>;
	try {
		node = lstatSync(HOSTED_TENANT_PATH_CLI);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!node.isSymbolicLink()) {
		throw new Error(
			`hosted tenant PATH contains an unmanaged clawdi entrypoint: ${HOSTED_TENANT_PATH_CLI}`,
		);
	}
	const target = resolve(dirname(HOSTED_TENANT_PATH_CLI), readlinkSync(HOSTED_TENANT_PATH_CLI));
	if (target !== HOSTED_SYSTEM_NPM_CLI) {
		throw new Error(`hosted tenant PATH contains an unmanaged clawdi symlink target: ${target}`);
	}
	rmSync(HOSTED_TENANT_PATH_CLI);
}

export function applyRuntimeCliDesiredState(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	opts: { runningVersion?: string } = {},
): RuntimeCliUpdateResult {
	const reconciliation = reconcilePendingRuntimeCliUpgrade(paths, opts.runningVersion);
	const packageSpec = manifest.clawdiCli?.packageSpec?.trim() || null;
	if (reconciliation.selfReexec) {
		return resultFromState(
			"deferred",
			paths,
			readCliState(paths),
			packageSpec,
			"CLI recovery changed the active version; re-exec is required",
			true,
		);
	}
	if (!packageSpec) return baseResult("not_requested", paths, emptyResultValues());

	const desiredVersion = exactNpmPackageVersion(packageSpec);
	if (!desiredVersion) {
		throw new Error(`clawdi CLI packageSpec must be clawdi@<exact-semver>: ${packageSpec}`);
	}
	validateRegistry(manifest.clawdiCli?.registry);
	const status = readRuntimeCliBootstrapStatus(paths, { strict: true });
	let state = parseCliState(paths, status);
	const retainedBad = state?.bad ?? null;
	if (
		state?.version === desiredVersion &&
		activeLinkTarget(paths.cliManagedBin) === state.activeTarget
	) {
		return resultFromState("current", paths, state, packageSpec);
	}
	if (retainedBad?.version === desiredVersion && badVersionIsActive(retainedBad)) {
		return baseResult("deferred", paths, {
			packageSpec,
			registry: NPM_REGISTRY,
			npmPrefix: state?.npmPrefix ?? paths.cliNpmPrefix,
			activeTarget: state?.activeTarget ?? null,
			version: state?.version ?? null,
			retryAt: retainedBad.retryAt,
			error: `clawdi CLI ${desiredVersion} retry is deferred until ${retainedBad.retryAt}`,
		});
	}

	let installed: VerifiedCliTarget;
	try {
		installed = installCliPackage(paths, packageSpec);
	} catch (error) {
		const reason = toErrorMessage(error);
		const bad = markBadVersion(retainedBad, desiredVersion, reason);
		if (state) writeCliState(paths, activeFromState(state), state.previous, bad);
		pruneCliPackagePrefixes(paths, state ? [state.npmPrefix, prefixForTarget(state.previous)] : []);
		return baseResult("error", paths, {
			packageSpec,
			registry: NPM_REGISTRY,
			npmPrefix: state?.npmPrefix ?? paths.cliNpmPrefix,
			activeTarget: state?.activeTarget ?? activeLinkTarget(paths.cliManagedBin),
			version: state?.version ?? null,
			retryAt: bad.retryAt,
			error: reason,
		});
	}

	state = readCliState(paths);
	const previous = state?.previous ?? (state ? targetFromState(state) : null);
	swapActiveCli(paths.cliManagedBin, installed.activeTarget);
	try {
		writeCliState(
			paths,
			installed,
			previous,
			state?.bad?.version === installed.version ? state.bad : null,
		);
	} catch (error) {
		if (state) swapActiveCli(paths.cliManagedBin, state.activeTarget);
		else rmSync(paths.cliManagedBin, { force: true });
		throw error;
	}
	pruneCliPackagePrefixes(paths, [
		prefixForActiveTarget(installed.activeTarget),
		prefixForTarget(previous),
	]);
	return baseResult(
		"installed",
		paths,
		{
			packageSpec,
			registry: NPM_REGISTRY,
			npmPrefix: prefixForActiveTarget(installed.activeTarget),
			activeTarget: installed.activeTarget,
			version: installed.version,
		},
		true,
	);
}

export function rollbackPendingRuntimeCliUpgrade(
	paths: RuntimePaths,
	reason: string,
): RuntimeCliRollbackResult {
	let before: RuntimeCliState | null = null;
	try {
		before = readCliState(paths);
		const reconciliation = reconcilePendingRuntimeCliUpgrade(paths);
		if (reconciliation.status === "rolled_back" && before?.previous) {
			return rollbackResult(before, "rolled_back");
		}
		const state = readCliState(paths);
		if (!state?.previous) return rollbackResult(state, "not_pending");
		rollbackToPrevious(paths, state, reason);
		return rollbackResult(state, "rolled_back");
	} catch (error) {
		return rollbackResult(before, "error", toErrorMessage(error));
	}
}

export function completePendingRuntimeCliUpgrade(
	paths: RuntimePaths,
	currentVersion: string,
): RuntimeCliReconciliationResult {
	const reconciliation = reconcilePendingRuntimeCliUpgrade(paths, currentVersion);
	if (reconciliation.selfReexec) return reconciliation;
	const state = readCliState(paths);
	if (
		state?.previous &&
		state.version === currentVersion &&
		activeLinkTarget(paths.cliManagedBin) === state.activeTarget
	) {
		writeCliState(
			paths,
			activeFromState(state),
			null,
			state.bad?.version === state.version ? null : state.bad,
		);
		pruneCliPackagePrefixes(paths, [state.npmPrefix]);
	}
	return reconciliation;
}

export function reconcilePendingRuntimeCliUpgrade(
	paths: RuntimePaths,
	runningVersion?: string,
): RuntimeCliReconciliationResult {
	assertCliDirectories(paths, dirname(paths.cliManagedBin));
	const status = readRuntimeCliBootstrapStatus(paths, { strict: true });
	let state = parseCliState(paths, status);
	const activeTarget = activeLinkTarget(paths.cliManagedBin);
	if (!state) {
		if (status && activeTarget !== status.activeTarget) {
			throw new Error("clawdi CLI bootstrap target does not match its receipt");
		}
		if (!activeTarget) return { status: "unchanged", selfReexec: false };
		const recovered = requireVerifiedCliTarget(paths, { activeTarget, version: status?.version });
		writeCliState(paths, recovered, null, null);
		pruneCliPackagePrefixes(paths, [prefixForActiveTarget(recovered.activeTarget)]);
		return reconciliationResult("unchanged", recovered.version, runningVersion);
	}

	if (activeTarget !== state.activeTarget) {
		const fallback = state.previous ?? activeFromState(state);
		const verifiedFallback = requireVerifiedCliTarget(paths, fallback);
		if (activeTarget !== verifiedFallback.activeTarget) {
			swapActiveCli(paths.cliManagedBin, verifiedFallback.activeTarget);
		}
		const bad = state.previous
			? markBadVersion(
					state.bad,
					state.version,
					"recovered interrupted or inconsistent clawdi CLI activation",
				)
			: state.bad;
		writeCliState(paths, verifiedFallback, null, bad);
		pruneCliPackagePrefixes(paths, [prefixForActiveTarget(verifiedFallback.activeTarget)]);
		return reconciliationResult("rolled_back", verifiedFallback.version, runningVersion);
	}

	const verifiedActive = tryVerifyCliTarget(paths, activeFromState(state), state);
	if (!verifiedActive) {
		if (!state.previous)
			throw new Error("active clawdi CLI is not verifiable and has no rollback target");
		rollbackToPrevious(paths, state, "active clawdi CLI failed recovery verification");
		state = readCliState(paths);
		return reconciliationResult("rolled_back", state?.version, runningVersion);
	}
	if (
		!verificationIdentityMatches(state.verification, verifiedActive.verification) ||
		state.verification.verifiedAt !== verifiedActive.verification.verifiedAt
	) {
		writeCliState(paths, verifiedActive, state.previous, state.bad);
	}
	return reconciliationResult(
		"unchanged",
		verifiedActive.version,
		runningVersion,
		state.previous !== null,
	);
}

export function readRuntimeCliBootstrapStatus(
	paths: RuntimePaths,
	opts: { strict?: boolean } = {},
): RuntimeCliBootstrapStatus | null {
	try {
		assertCliDirectories(paths, dirname(paths.cliBootstrapStatus));
		const file = optionalCliLstat(paths.cliBootstrapStatus);
		if (!file) return null;
		assertCliOwnership(file, "receipt", paths.cliBootstrapStatus);
		if (!file.isFile()) throw new Error("clawdi CLI receipt is not a regular file");
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(paths.cliBootstrapStatus, "utf-8"));
		} catch (error) {
			if (error instanceof SyntaxError) throw new Error("clawdi CLI receipt has malformed JSON");
			throw error;
		}
		const parsed = runtimeCliReceiptSchema.safeParse(value);
		if (!parsed.success) throw new Error("clawdi CLI receipt format is invalid");
		return parsed.data;
	} catch (error) {
		if (opts.strict) throw error;
		log.warn("runtime.cli_bootstrap_status_invalid", {
			path: paths.cliBootstrapStatus,
			error: toErrorMessage(error),
		});
		return null;
	}
}

type RuntimeCliResultValues = Pick<
	RuntimeCliUpdateResult,
	"packageSpec" | "registry" | "activeTarget" | "version"
> &
	Partial<Pick<RuntimeCliUpdateResult, "npmPrefix" | "npmCache" | "retryAt" | "error">>;

function baseResult(
	status: RuntimeCliUpdateResult["status"],
	paths: RuntimePaths,
	values: RuntimeCliResultValues,
	selfReexec = false,
): RuntimeCliUpdateResult {
	return {
		status,
		...values,
		npmPrefix: values.npmPrefix ?? paths.cliNpmPrefix,
		npmCache: values.npmCache ?? paths.cliNpmCache,
		activePath: paths.cliManagedBin,
		retryAt: values.retryAt ?? null,
		selfReexec,
	};
}

function emptyResultValues(): RuntimeCliResultValues {
	return {
		packageSpec: null,
		registry: null,
		activeTarget: null,
		version: null,
	};
}

function resultFromState(
	status: RuntimeCliUpdateResult["status"],
	paths: RuntimePaths,
	state: RuntimeCliState | null,
	packageSpec: string | null,
	error?: string,
	selfReexec = false,
): RuntimeCliUpdateResult {
	return baseResult(
		status,
		paths,
		{
			packageSpec,
			registry: packageSpec ? NPM_REGISTRY : null,
			npmPrefix: state?.npmPrefix ?? paths.cliNpmPrefix,
			activeTarget: state?.activeTarget ?? activeLinkTarget(paths.cliManagedBin),
			version: state?.version ?? null,
			retryAt:
				state?.bad?.version === exactNpmPackageVersion(packageSpec ?? "")
					? state.bad.retryAt
					: null,
			error,
		},
		selfReexec,
	);
}

function parseCliState(
	paths: RuntimePaths,
	status: RuntimeCliBootstrapStatus | null,
): RuntimeCliState | null {
	if (!status) return null;
	const state = status;
	if (
		state.activePath !== paths.cliManagedBin ||
		state.npmCache !== paths.cliNpmCache ||
		state.npmPrefix !== prefixForActiveTarget(state.activeTarget) ||
		!isManagedCliTarget(paths, state.activeTarget) ||
		exactNpmPackageVersion(state.packageSpec) !== state.version ||
		("bad" in state && !isValidRetryState(state.bad))
	) {
		throw new Error("clawdi CLI receipt identity is invalid");
	}
	return "verification" in state ? state : null;
}

function readCliState(paths: RuntimePaths): RuntimeCliState | null {
	return parseCliState(paths, readRuntimeCliBootstrapStatus(paths, { strict: true }));
}

function writeCliState(
	paths: RuntimePaths,
	active: VerifiedCliTarget,
	previous: RuntimeCliTarget | null,
	bad: RuntimeCliBad | null,
): void {
	const currentIdentity = cliVerificationIdentity(active.activeTarget);
	if (!currentIdentity || !verificationIdentityMatches(active.verification, currentIdentity)) {
		throw new Error(`clawdi CLI target changed after verification: ${active.activeTarget}`);
	}
	const state = runtimeCliStateSchema.parse({
		schemaVersion: "clawdi.cliNpmBootstrapStatus.v1",
		generatedAt: new Date().toISOString(),
		status: "installed",
		source: "npm",
		packageSpec: `clawdi@${active.version}`,
		registry: NPM_REGISTRY,
		npmPrefix: prefixForActiveTarget(active.activeTarget),
		npmCache: paths.cliNpmCache,
		activePath: paths.cliManagedBin,
		activeTarget: active.activeTarget,
		version: active.version,
		verification: active.verification,
		previous,
		bad,
		error: null,
	});
	writeRuntimePlatformFileAtomic(
		paths,
		paths.cliBootstrapStatus,
		`${JSON.stringify(state, null, 2)}\n`,
		{ mode: 0o600, dirMode: 0o755 },
	);
}

function activeFromState(state: RuntimeCliState): VerifiedCliTarget {
	return {
		activeTarget: state.activeTarget,
		version: state.version,
		verification: state.verification,
	};
}

function targetFromState(state: RuntimeCliState): RuntimeCliTarget {
	return { activeTarget: state.activeTarget, version: state.version };
}

function rollbackToPrevious(paths: RuntimePaths, state: RuntimeCliState, reason: string): void {
	if (!state.previous) throw new Error("pending clawdi CLI upgrade has no rollback target");
	const previous = requireVerifiedCliTarget(paths, state.previous);
	if (activeLinkTarget(paths.cliManagedBin) !== previous.activeTarget) {
		swapActiveCli(paths.cliManagedBin, previous.activeTarget);
	}
	writeCliState(paths, previous, null, markBadVersion(state.bad, state.version, reason));
	pruneCliPackagePrefixes(paths, [prefixForActiveTarget(previous.activeTarget)]);
}

function rollbackResult(
	state: RuntimeCliState | null,
	status: RuntimeCliRollbackResult["status"],
	error?: string,
): RuntimeCliRollbackResult {
	return {
		status,
		version: state?.version ?? null,
		previousVersion: state?.previous?.version ?? null,
		activeTarget: state?.activeTarget ?? null,
		previousActiveTarget: state?.previous?.activeTarget ?? null,
		...(error ? { error } : {}),
	};
}

function reconciliationResult(
	status: RuntimeCliReconciliationResult["status"],
	activeVersion: string | undefined,
	runningVersion: string | undefined,
	requiresHandoff = status === "rolled_back",
): RuntimeCliReconciliationResult {
	return {
		status,
		selfReexec:
			requiresHandoff &&
			runningVersion !== undefined &&
			activeVersion !== undefined &&
			activeVersion !== runningVersion,
	};
}

function validateRegistry(value: string | undefined): void {
	if (value === undefined || value.trim() === "") return;
	let normalized: string;
	try {
		const parsed = new URL(value.trim());
		parsed.pathname = parsed.pathname.replace(/\/+$/, "");
		parsed.search = "";
		parsed.hash = "";
		normalized = parsed.toString().replace(/\/$/, "");
	} catch {
		throw new Error(`unsupported clawdi CLI registry: ${value}`);
	}
	if (normalized !== NPM_REGISTRY) throw new Error(`unsupported clawdi CLI registry: ${value}`);
}

function exactNpmPackageVersion(packageSpec: string): string | null {
	if (!hostedCliPackageSpecSchema.safeParse(packageSpec).success) return null;
	return packageSpec.slice("clawdi@".length);
}

function installCliPackage(paths: RuntimePaths, packageSpec: string): VerifiedCliTarget {
	const version = exactNpmPackageVersion(packageSpec);
	if (!version) throw new Error(`clawdi CLI packageSpec must be exact: ${packageSpec}`);
	const npmPrefix = cliPackagePrefix(paths, version);
	ensureManagedCliDirectory(dirname(dirname(paths.cliManagedBin)));
	ensureManagedCliDirectory(dirname(paths.cliManagedBin));
	ensureManagedCliDirectory(paths.cliNpmPrefix);
	ensureManagedCliDirectory(npmPrefix);
	ensureManagedCliDirectory(paths.cliNpmCache);

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
		"--registry",
		NPM_REGISTRY,
		packageSpec,
	];
	// npm's umask config does not cover Arborist's intermediate mkdir calls.
	const result = spawnSync("/bin/sh", ["-c", 'umask 077; exec npm "$@"', "npm", ...args], {
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

	const activeTarget = join(npmPrefix, "bin", "clawdi");
	const installed = requireVerifiedCliTarget(paths, { activeTarget });
	if (installed.version !== version) {
		throw new Error(
			`npm install ${packageSpec} reported version ${installed.version}, expected ${version}`,
		);
	}
	return installed;
}

function requireVerifiedCliTarget(
	paths: RuntimePaths,
	target: { activeTarget: string; version?: string },
): VerifiedCliTarget {
	const verified = tryVerifyCliTarget(paths, target);
	if (!verified) {
		throw new Error(
			`clawdi CLI target is missing, inconsistent, or not executable: ${target.activeTarget}`,
		);
	}
	return verified;
}

function tryVerifyCliTarget(
	paths: RuntimePaths,
	target: { activeTarget: string; version?: string },
	state?: RuntimeCliState,
): VerifiedCliTarget | null {
	assertCliTarget(paths, target.activeTarget);
	if (!isExecutable(target.activeTarget)) return null;
	const before = cliVerificationIdentity(target.activeTarget);
	if (!before) return null;
	if (
		state?.activeTarget === target.activeTarget &&
		state.version === target.version &&
		verificationIdentityMatches(state.verification, before) &&
		verificationIsFresh(state.verification)
	) {
		return {
			activeTarget: target.activeTarget,
			version: state.version,
			verification: state.verification,
		};
	}
	try {
		const version = smokeCliVersion(target.activeTarget);
		if (target.version !== undefined && version !== target.version) return null;
		if (!hostedCliPackageSpecSchema.safeParse(`clawdi@${version}`).success) return null;
		verifyCliRuntime(target.activeTarget);
		return {
			activeTarget: target.activeTarget,
			version,
			verification: finishCliVerification(target.activeTarget, before),
		};
	} catch (error) {
		log.warn("runtime.cli_target_verification_failed", {
			active_target: target.activeTarget,
			error: toErrorMessage(error),
		});
		return null;
	}
}

function markBadVersion(
	previous: RuntimeCliBad | null,
	version: string,
	reason: string,
): RuntimeCliBad {
	const attempts = previous?.version === version ? previous.attempts + 1 : 1;
	const failedAt = new Date();
	const backoffMs = Math.min(
		CLI_RETRY_INITIAL_BACKOFF_MS * 2 ** (attempts - 1),
		CLI_RETRY_MAX_BACKOFF_MS,
	);
	return {
		version,
		reason,
		attempts,
		failedAt: failedAt.toISOString(),
		retryAt: new Date(failedAt.getTime() + backoffMs).toISOString(),
	};
}

function isValidRetryState(bad: RuntimeCliBad | null): boolean {
	if (!bad) return true;
	return Number.isFinite(Date.parse(bad.failedAt)) && Number.isFinite(Date.parse(bad.retryAt));
}

function badVersionIsActive(bad: RuntimeCliBad): boolean {
	const retryAt = Date.parse(bad.retryAt);
	return Number.isFinite(retryAt) && Date.now() < retryAt;
}

function cliPackagePrefix(paths: RuntimePaths, version: string): string {
	if (!/^[0-9A-Za-z._+-]+$/.test(version)) {
		throw new Error(`resolved clawdi CLI version contains unsafe path characters: ${version}`);
	}
	return join(paths.cliNpmPrefix, "packages", version);
}

function prefixForActiveTarget(activeTarget: string): string {
	return dirname(dirname(activeTarget));
}

function prefixForTarget(target: RuntimeCliTarget | null): string | null {
	return target ? prefixForActiveTarget(target.activeTarget) : null;
}

function isManagedCliPrefix(paths: RuntimePaths, path: string): boolean {
	const root = resolve(paths.cliNpmPrefix);
	const candidate = resolve(path);
	return candidate === root || candidate.startsWith(`${root}/`);
}

function isManagedCliTarget(paths: RuntimePaths, path: string): boolean {
	return path === resolve(path) && isManagedCliPrefix(paths, path) && path.endsWith("/bin/clawdi");
}

function optionalCliLstat(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

function assertCliOwnership(node: Stats, role: string, path: string): void {
	if (node.uid !== process.getuid?.() || (node.mode & 0o022) !== 0) {
		throw new Error(
			`clawdi CLI path has unsafe ownership or permissions (role=${role}, path=${JSON.stringify(path)}, uid=${process.getuid?.()}, euid=${process.geteuid?.()}, ownerUid=${node.uid}, ownerGid=${node.gid}, mode=0${(node.mode & 0o7777).toString(8)})`,
		);
	}
}

function assertCliDirectories(paths: RuntimePaths, path: string): void {
	const root = resolve(paths.serviceStateRoot);
	if (path !== root && !path.startsWith(`${root}/`)) {
		throw new Error("clawdi CLI path escaped its state root");
	}
	for (let current = path; ; current = dirname(current)) {
		const node = optionalCliLstat(current);
		if (node) {
			let role = "directory";
			if (current === root) role = "service-state root";
			else if (current === paths.managedCliRoot) role = "managed CLI root";
			assertCliOwnership(node, role, current);
			if (!node.isDirectory()) throw new Error("clawdi CLI directory is not a real directory");
		}
		if (current === root) break;
	}
}

function assertCliTarget(paths: RuntimePaths, target: string): void {
	if (!isManagedCliTarget(paths, target)) throw new Error("clawdi CLI target is not managed");
	assertCliDirectories(paths, dirname(target));
	const node = optionalCliLstat(target);
	if (!node) return;
	if (node.uid !== process.getuid?.()) throw new Error("clawdi CLI target has unsafe ownership");
	const executable = realpathSync(target);
	if (!executable.startsWith(`${prefixForActiveTarget(target)}/`)) {
		throw new Error("clawdi CLI executable escaped its npm prefix");
	}
	assertCliDirectories(paths, dirname(executable));
	const file = statSync(target);
	assertCliOwnership(file, "executable", target);
	if (!file.isFile()) throw new Error("clawdi CLI executable is not a regular file");
}

function ensureManagedCliDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o755 });
}

function activeLinkTarget(activePath: string): string | null {
	const node = optionalCliLstat(activePath);
	if (!node) return null;
	if (!node.isSymbolicLink() || node.uid !== process.getuid?.()) {
		throw new Error("clawdi CLI active path is not a trusted symlink");
	}
	return resolve(dirname(activePath), readlinkSync(activePath));
}

function swapActiveCli(activePath: string, activeTarget: string): void {
	const dir = dirname(activePath);
	ensureManagedCliDirectory(dirname(dir));
	ensureManagedCliDirectory(dir);
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

function pruneCliPackagePrefixes(paths: RuntimePaths, keepPrefixes: Array<string | null>): void {
	const packageRoot = join(paths.cliNpmPrefix, "packages");
	if (!existsSync(packageRoot)) return;
	const keep = new Set(keepPrefixes.filter((value): value is string => Boolean(value)));
	try {
		for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = join(packageRoot, entry.name);
			if (!keep.has(path)) rmSync(path, { recursive: true, force: true });
		}
	} catch (error) {
		log.warn("runtime.cli_package_prune_failed", {
			package_root: packageRoot,
			error: toErrorMessage(error),
		});
	}
}

function cliVerificationIdentity(
	activeTarget: string,
): Omit<RuntimeCliVerification, "verifiedAt"> | null {
	try {
		const stat = statSync(activeTarget);
		return {
			device: stat.dev,
			inode: stat.ino,
			size: stat.size,
			modifiedAtMs: stat.mtimeMs,
		};
	} catch {
		return null;
	}
}

function verificationIdentityMatches(
	verification: Omit<RuntimeCliVerification, "verifiedAt">,
	identity: Omit<RuntimeCliVerification, "verifiedAt">,
): boolean {
	return (
		verification.device === identity.device &&
		verification.inode === identity.inode &&
		verification.size === identity.size &&
		verification.modifiedAtMs === identity.modifiedAtMs
	);
}

function verificationIsFresh(verification: RuntimeCliVerification): boolean {
	const verifiedAt = Date.parse(verification.verifiedAt);
	const ageMs = Date.now() - verifiedAt;
	return Number.isFinite(verifiedAt) && ageMs >= 0 && ageMs < CLI_VERIFY_CACHE_MAX_AGE_MS;
}

function finishCliVerification(
	activeTarget: string,
	before: Omit<RuntimeCliVerification, "verifiedAt">,
): RuntimeCliVerification {
	const after = cliVerificationIdentity(activeTarget);
	if (!after || !verificationIdentityMatches(before, after)) {
		throw new Error(`clawdi CLI target changed during verification: ${activeTarget}`);
	}
	return { verifiedAt: new Date().toISOString(), ...after };
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
	const verifyRoot = mkdtempSync(join(tmpdir(), "clawdi-runtime-verify-"));
	let result: SpawnSyncReturns<string>;
	try {
		result = spawnSync(command, ["runtime", "verify", "--json"], {
			encoding: "utf8",
			timeout: RUNTIME_VERIFY_TIMEOUT_MS,
			env: {
				...process.env,
				HOME: join(verifyRoot, "home"),
				CLAWDI_SERVICE_STATE_DIR: join(verifyRoot, "state"),
				CLAWDI_RUN_DIR: join(verifyRoot, "run"),
				CLAWDI_NO_AUTO_UPDATE: "1",
				CLAWDI_NO_UPDATE_CHECK: "1",
			},
		});
	} finally {
		rmSync(verifyRoot, { recursive: true, force: true });
	}
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
	if (!output) throw new Error("installed clawdi runtime verify self-check returned empty output");
	try {
		z.object({ status: z.literal("ok") })
			.loose()
			.parse(JSON.parse(output));
	} catch (error) {
		throw new Error(
			`installed clawdi runtime verify self-check returned invalid JSON: ${toErrorMessage(
				error,
			)}${commandOutput(result.stdout, result.stderr)}`,
		);
	}
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
