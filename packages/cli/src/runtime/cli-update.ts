import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
	HOSTED_RUNTIME_PAIRED_FIXTURE_CLI_PACKAGE,
	hostedCliPackageSpecSchema,
	hostedFixtureCliPackageSpecSchema,
	type RuntimeManifest,
} from "./manifest-contract";
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
	// The active managed target no longer matches the code in this process.
	// Callers must stop before manifest convergence or any authority side effect.
	selfReexec: boolean;
	error?: string | null;
}

interface RuntimeCliBootstrapStatus {
	schemaVersion?: string;
	status?: string;
	source?: string;
	packageSpec?: string;
	registry?: string | null;
	npmPrefix?: string;
	npmCache?: string;
	activePath?: string;
	activeTarget?: string;
	version?: string;
	verification?: RuntimeCliVerification;
	error?: string | null;
}

type RuntimeCliInstallIdentity = Required<
	Pick<
		RuntimeCliBootstrapStatus,
		"packageSpec" | "registry" | "npmPrefix" | "activeTarget" | "version"
	>
>;

interface RuntimeCliBadVersion {
	packageSpec: string;
	registry: string | null;
	version: string;
	reason: string;
	markedAt: string;
}

interface RuntimeCliVerification {
	verifiedAt: string;
	device: number;
	inode: number;
	size: number;
	modifiedAtMs: number;
}

interface RuntimeCliUpgradeTransaction {
	phase: "prepared" | "activated";
	previousIdentity: RuntimeCliInstallIdentity | null;
	newIdentity: RuntimeCliInstallIdentity;
	rollbackEligible: boolean;
	installedAt: string;
	rollback: { reason: string; markedAt: string } | null;
}

interface RuntimeCliUpgradeState {
	schemaVersion?: string;
	transaction?: RuntimeCliUpgradeTransaction | null;
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
const VERSION_SMOKE_TIMEOUT_MS = 20_000;
const RUNTIME_VERIFY_TIMEOUT_MS = 20_000;
const CLI_VERIFY_CACHE_MAX_AGE_MS = 300_000;

interface RuntimeCliReconciliationOptions {
	runningVersion?: string;
}

export interface RuntimeCliReconciliationResult {
	status: "unchanged" | "activated" | "rolled_back";
	selfReexec: boolean;
}

const cliInstallIdentityStateSchema = z
	.object({
		packageSpec: z.string().min(1),
		registry: z.string().min(1).nullable(),
		npmPrefix: z.string().min(1),
		activeTarget: z.string().min(1),
		version: z.string().min(1),
	})
	.strict();

const cliBadVersionStateSchema = z
	.object({
		packageSpec: z.string().min(1),
		registry: z.string().min(1).nullable(),
		version: z.string().min(1),
		reason: z.string(),
		markedAt: z.string().min(1),
	})
	.strict();

const cliUpgradeTransactionStateSchema = z
	.object({
		phase: z.enum(["prepared", "activated"]),
		previousIdentity: cliInstallIdentityStateSchema.nullable(),
		newIdentity: cliInstallIdentityStateSchema,
		rollbackEligible: z.boolean(),
		installedAt: z.string().min(1),
		rollback: z
			.object({ reason: z.string(), markedAt: z.string().min(1) })
			.strict()
			.nullable(),
	})
	.strict();

const cliUpgradeStateV2Schema = z
	.object({
		schemaVersion: z.literal("clawdi.cliUpgradeState.v2"),
		transaction: cliUpgradeTransactionStateSchema.nullable(),
		badVersions: z.array(cliBadVersionStateSchema),
	})
	.strict();

export function applyRuntimeCliDesiredState(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	opts: {
		deferInstall?: boolean;
		deferReason?: string;
		rollbackEligible?: boolean;
		runningVersion?: string;
	} = {},
): RuntimeCliUpdateResult {
	const reconciliation = reconcileCliUpgradeTransaction(paths, opts);
	if (reconciliation.selfReexec) {
		const status = readBootstrapStatus(paths.cliBootstrapStatus);
		return baseResult(
			"deferred",
			paths,
			{
				packageSpec: manifest.clawdiCli?.packageSpec?.trim() || null,
				registry: status?.registry ?? null,
				npmPrefix: status?.npmPrefix ?? paths.cliNpmPrefix,
				activeTarget: status?.activeTarget ?? null,
				version: status?.version ?? null,
				error: `CLI transaction recovery ${reconciliation.status}; re-exec is required`,
			},
			true,
		);
	}
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
	const recovered = recoverCurrentCliInstallFromActiveLink(paths, packageSpec);
	if (recovered) {
		writeCliBootstrapStatus(
			paths,
			{
				packageSpec,
				registry,
				npmPrefix: recovered.npmPrefix,
				activeTarget: recovered.activeTarget,
				version: recovered.version,
			},
			recovered.verification,
		);
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

	const previousIdentity = lastGoodCliIdentity(paths, current);
	if (
		previousIdentity &&
		activeLinkTarget(paths.cliManagedBin) === previousIdentity.activeTarget &&
		(current?.status !== "installed" ||
			current.source !== "npm" ||
			current.packageSpec !== previousIdentity.packageSpec ||
			(current.registry ?? null) !== previousIdentity.registry ||
			current.npmPrefix !== previousIdentity.npmPrefix ||
			current.activePath !== paths.cliManagedBin ||
			current.activeTarget !== previousIdentity.activeTarget ||
			current.version !== previousIdentity.version)
	) {
		const verification = verifyStoredCliIdentity(paths, previousIdentity);
		if (!verification) throw new Error("active clawdi CLI changed during verification");
		writeCliBootstrapStatus(paths, previousIdentity, verification);
	}
	const installed = installCliPackage(paths, packageSpec, registry);
	prepareCliUpgradeTransaction(paths, {
		newIdentity: {
			packageSpec,
			registry,
			npmPrefix: installed.npmPrefix,
			activeTarget: installed.activeTarget,
			version: installed.version,
		},
		previousIdentity,
		rollbackEligible: opts.rollbackEligible === true && previousIdentity !== null,
	});
	swapActiveCli(paths.cliManagedBin, installed.activeTarget);
	writeCliBootstrapStatus(
		paths,
		{
			packageSpec,
			registry,
			npmPrefix: installed.npmPrefix,
			activeTarget: installed.activeTarget,
			version: installed.version,
		},
		installed.verification,
	);
	activateCliUpgradeTransaction(paths);
	pruneCliPackagePrefixes(paths, [installed.npmPrefix, previousIdentity?.npmPrefix ?? null]);
	return baseResult(
		"installed",
		paths,
		{
			packageSpec,
			registry,
			npmPrefix: installed.npmPrefix,
			activeTarget: installed.activeTarget,
			version: installed.version,
		},
		true,
	);
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
	selfReexec = false,
): RuntimeCliUpdateResult {
	return {
		status,
		...values,
		npmPrefix: values.npmPrefix ?? paths.cliNpmPrefix,
		npmCache: values.npmCache ?? paths.cliNpmCache,
		activePath: paths.cliManagedBin,
		selfReexec,
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
	if (hostedFixtureCliPackageSpecSchema.safeParse(packageSpec).success) return;
	throw new Error(
		`clawdi CLI packageSpec must be clawdi@<exact-semver> or a managed bootstrap tarball: ${packageSpec}`,
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

function ensureManagedCliDirectory(path: string): void {
	mkdirSync(path, { recursive: true });
}

function isManagedCliPrefix(paths: RuntimePaths, path: string): boolean {
	const root = resolve(paths.cliNpmPrefix);
	const candidate = resolve(path);
	return candidate === root || candidate.startsWith(`${root}/`);
}

function isManagedCliTarget(paths: RuntimePaths, path: string): boolean {
	return isManagedCliPrefix(paths, path) && path.endsWith("/bin/clawdi");
}

function isCurrentCliInstall(
	status: RuntimeCliBootstrapStatus | null,
	paths: RuntimePaths,
	packageSpec: string,
	registry: string | null,
): status is RuntimeCliBootstrapStatus & { activeTarget: string } {
	if (!status) return false;
	if (status.status !== "installed" || status.source !== "npm") return false;
	if (status.activePath !== paths.cliManagedBin) return false;
	if (!status.activeTarget) return false;
	if (!isManagedCliTarget(paths, status.activeTarget)) return false;
	if (activeLinkTarget(paths.cliManagedBin) !== status.activeTarget) return false;
	if (
		!status.npmPrefix ||
		resolve(status.npmPrefix) !== resolve(prefixForActiveTarget(status.activeTarget))
	) {
		return false;
	}
	if (!isExecutable(status.activeTarget)) return false;
	if (!status.version) return false;
	const exactVersion = exactNpmPackageVersion(packageSpec);
	if (exactVersion && status.version !== exactVersion) return false;
	const pairedFixtureMatches =
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS === "1" &&
		status.packageSpec === HOSTED_RUNTIME_PAIRED_FIXTURE_CLI_PACKAGE &&
		exactVersion === status.version;
	if (status.packageSpec !== packageSpec && !pairedFixtureMatches) return false;
	if ((status.registry ?? null) !== registry) return false;
	if (!isExecutable(paths.cliManagedBin)) return false;
	const fileIdentity = cliVerificationIdentity(status.activeTarget);
	if (
		fileIdentity &&
		status.verification &&
		verificationIdentityMatches(status.verification, fileIdentity) &&
		verificationIsFresh(status.verification)
	) {
		return true;
	}
	if (!fileIdentity) return false;
	try {
		if (smokeCliVersion(status.activeTarget) !== status.version) return false;
		verifyCliRuntime(status.activeTarget);
		const verification = finishCliVerification(status.activeTarget, fileIdentity);
		writeCliBootstrapStatus(
			paths,
			{
				packageSpec: pairedFixtureMatches ? HOSTED_RUNTIME_PAIRED_FIXTURE_CLI_PACKAGE : packageSpec,
				registry,
				npmPrefix: status.npmPrefix,
				activeTarget: status.activeTarget,
				version: status.version,
			},
			verification,
		);
		return true;
	} catch {
		return false;
	}
}

function verifiedActiveCliIdentity(
	paths: RuntimePaths,
	status: RuntimeCliBootstrapStatus | null,
): RuntimeCliInstallIdentity | null {
	const activeTarget = activeLinkTarget(paths.cliManagedBin);
	if (!activeTarget || !isManagedCliTarget(paths, activeTarget)) return null;
	const npmPrefix = prefixForActiveTarget(activeTarget);
	if (!isManagedCliPrefix(paths, npmPrefix)) return null;
	if (!isExecutable(activeTarget) || !isExecutable(paths.cliManagedBin)) return null;

	try {
		const before = cliVerificationIdentity(activeTarget);
		if (!before) return null;
		const version = smokeCliVersion(activeTarget);
		verifyCliRuntime(activeTarget);
		finishCliVerification(activeTarget, before);
		const inferredPackageSpec = `clawdi@${version}`;
		if (!hostedCliPackageSpecSchema.safeParse(inferredPackageSpec).success) return null;
		const statusPackageSpec = status?.packageSpec;
		const statusRegistry = status?.registry ?? null;
		const exactStatusVersion = statusPackageSpec ? exactNpmPackageVersion(statusPackageSpec) : null;
		const statusMatches =
			status?.status === "installed" &&
			status.source === "npm" &&
			status.activePath === paths.cliManagedBin &&
			status.activeTarget === activeTarget &&
			status.npmPrefix !== undefined &&
			resolve(status.npmPrefix) === resolve(npmPrefix) &&
			status.version === version &&
			statusPackageSpec !== undefined &&
			hostedFixtureCliPackageSpecSchema.safeParse(statusPackageSpec).success &&
			(exactStatusVersion === null || exactStatusVersion === version) &&
			(statusRegistry === null || statusRegistry === "https://registry.npmjs.org");
		return {
			packageSpec: statusMatches && statusPackageSpec ? statusPackageSpec : inferredPackageSpec,
			registry: statusMatches ? statusRegistry : null,
			npmPrefix,
			activeTarget,
			version,
		};
	} catch {
		return null;
	}
}

function lastGoodCliIdentity(
	paths: RuntimePaths,
	status: RuntimeCliBootstrapStatus | null,
): RuntimeCliInstallIdentity | null {
	const activeIdentity = verifiedActiveCliIdentity(paths, status);
	if (!activeIdentity) return null;
	const transaction = readCliUpgradeState(paths).transaction;
	if (
		transaction?.phase !== "activated" ||
		transaction.rollback ||
		!transaction.rollbackEligible ||
		!transaction.previousIdentity ||
		transaction.newIdentity.activeTarget !== activeIdentity.activeTarget
	) {
		return activeIdentity;
	}
	return verifyStoredCliIdentity(paths, transaction.previousIdentity)
		? transaction.previousIdentity
		: activeIdentity;
}

function recoverCurrentCliInstallFromActiveLink(
	paths: RuntimePaths,
	packageSpec: string,
): {
	npmPrefix: string;
	activeTarget: string;
	version: string;
	verification: RuntimeCliVerification;
} | null {
	const desiredVersion = exactNpmPackageVersion(packageSpec);
	if (!desiredVersion) return null;
	const npmPrefix = cliPackagePrefix(paths, desiredVersion);
	const activeTarget = activeLinkTarget(paths.cliManagedBin);
	if (activeTarget !== join(npmPrefix, "bin", "clawdi")) return null;
	if (!isManagedCliTarget(paths, activeTarget)) return null;
	if (!isExecutable(activeTarget) || !isExecutable(paths.cliManagedBin)) return null;
	const before = cliVerificationIdentity(activeTarget);
	if (!before) return null;
	const version = smokeCliVersion(activeTarget);
	if (version !== desiredVersion) return null;
	verifyCliRuntime(activeTarget);
	const verification = finishCliVerification(activeTarget, before);
	return {
		npmPrefix: prefixForActiveTarget(activeTarget),
		activeTarget,
		version,
		verification,
	};
}

function exactNpmPackageVersion(packageSpec: string): string | null {
	if (!hostedCliPackageSpecSchema.safeParse(packageSpec).success) return null;
	return packageSpec.slice("clawdi@".length);
}

function installCliPackage(
	paths: RuntimePaths,
	packageSpec: string,
	registry: string | null,
): {
	npmPrefix: string;
	activeTarget: string;
	version: string;
	verification: RuntimeCliVerification;
} {
	// The version-specific prefix is load-bearing: a fresh candidate is verified
	// before cliManagedBin switches atomically, and the journal can restore the
	// previous target without relying on an in-place npm rollback.
	const installPlan = cliInstallPlan(paths, packageSpec, registry);
	if (isBadCliVersion(paths, packageSpec, registry, installPlan.version)) {
		throw new Error(
			`clawdi CLI ${installPlan.version} is marked bad after rollback; waiting for a newer resolved version`,
		);
	}
	const npmPrefix = installPlan.npmPrefix;
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
	const before = cliVerificationIdentity(activeTarget);
	if (!before)
		throw new Error(`installed clawdi bin disappeared before verification: ${activeTarget}`);
	const version = smokeCliVersion(activeTarget);
	const exactVersion = exactNpmPackageVersion(packageSpec);
	if (exactVersion && version !== exactVersion) {
		throw new Error(
			`npm install ${installPlan.installPackageSpec} reported version ${version}, expected ${exactVersion}`,
		);
	}
	verifyCliRuntime(activeTarget);
	const verification = finishCliVerification(activeTarget, before);
	return { npmPrefix, activeTarget, version, verification };
}

function cliInstallPlan(
	paths: RuntimePaths,
	packageSpec: string,
	registry: string | null,
): { installPackageSpec: string; npmPrefix: string; version: string } {
	const version = exactNpmPackageVersion(packageSpec);
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

function prefixForActiveTarget(activeTarget: string): string {
	return dirname(dirname(activeTarget));
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

function activeLinkTarget(activePath: string): string | null {
	try {
		return resolve(dirname(activePath), readlinkSync(activePath));
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

function writeCliBootstrapStatus(
	paths: RuntimePaths,
	input: {
		packageSpec: string;
		registry: string | null;
		npmPrefix: string;
		activeTarget: string;
		version: string;
	},
	verification?: RuntimeCliVerification,
): void {
	const currentIdentity = cliVerificationIdentity(input.activeTarget);
	if (
		verification &&
		(!currentIdentity || !verificationIdentityMatches(verification, currentIdentity))
	) {
		throw new Error(`clawdi CLI target changed after verification: ${input.activeTarget}`);
	}
	writeRuntimePlatformFileAtomic(
		paths,
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
				verification,
				error: null,
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600, dirMode: 0o755 },
	);
}

export function rollbackPendingRuntimeCliUpgrade(
	paths: RuntimePaths,
	reason: string,
): RuntimeCliRollbackResult {
	let transaction: RuntimeCliUpgradeTransaction | null = null;
	try {
		transaction = readCliUpgradeState(paths).transaction ?? null;
		reconcileCliUpgradeTransaction(paths);
	} catch (error) {
		return rollbackErrorResult(transaction, error);
	}
	const state = readCliUpgradeState(paths);
	transaction = state.transaction ?? null;
	if (!transaction) {
		return {
			status: "not_pending",
			version: null,
			previousVersion: null,
			activeTarget: null,
			previousActiveTarget: null,
		};
	}
	if (!transaction.rollbackEligible || !transaction.previousIdentity) {
		return {
			status: "not_pending",
			version: transaction.newIdentity.version,
			previousVersion: transaction.previousIdentity?.version ?? null,
			activeTarget: transaction.newIdentity.activeTarget,
			previousActiveTarget: transaction.previousIdentity?.activeTarget ?? null,
		};
	}
	if (!verifyStoredCliIdentity(paths, transaction.previousIdentity)) {
		return {
			status: "error",
			version: transaction.newIdentity.version,
			previousVersion: transaction.previousIdentity.version,
			activeTarget: transaction.newIdentity.activeTarget,
			previousActiveTarget: transaction.previousIdentity.activeTarget,
			error: "previous clawdi CLI identity is missing, inconsistent, or not executable",
		};
	}
	if (activeLinkTarget(paths.cliManagedBin) !== transaction.newIdentity.activeTarget) {
		return {
			status: "error",
			version: transaction.newIdentity.version,
			previousVersion: transaction.previousIdentity.version,
			activeTarget: transaction.newIdentity.activeTarget,
			previousActiveTarget: transaction.previousIdentity.activeTarget,
			error: "pending clawdi CLI target is no longer active",
		};
	}
	try {
		const rollbackTransaction: RuntimeCliUpgradeTransaction = {
			...transaction,
			rollback: { reason, markedAt: new Date().toISOString() },
		};
		writeCliUpgradeState(paths, { ...state, transaction: rollbackTransaction });
		finishCliRollback(paths, rollbackTransaction);
		return {
			status: "rolled_back",
			version: transaction.newIdentity.version,
			previousVersion: transaction.previousIdentity.version,
			activeTarget: transaction.newIdentity.activeTarget,
			previousActiveTarget: transaction.previousIdentity.activeTarget,
			error: null,
		};
	} catch (error) {
		return rollbackErrorResult(transaction, error);
	}
}

export function completePendingRuntimeCliUpgrade(
	paths: RuntimePaths,
	currentVersion: string,
): RuntimeCliReconciliationResult {
	const reconciliation = reconcileCliUpgradeTransaction(paths, {
		runningVersion: currentVersion,
	});
	if (reconciliation.selfReexec) return reconciliation;
	const state = readCliUpgradeState(paths);
	const transaction = state.transaction ?? null;
	if (transaction?.phase !== "activated" || transaction.rollback) return reconciliation;
	if (transaction.newIdentity.version !== currentVersion) return reconciliation;
	if (activeLinkTarget(paths.cliManagedBin) !== transaction.newIdentity.activeTarget) {
		return reconciliation;
	}
	if (!verifyStoredCliIdentity(paths, transaction.newIdentity)) return reconciliation;
	const nextState = normalizeCliUpgradeState(state);
	nextState.transaction = null;
	writeCliUpgradeState(paths, nextState);
	pruneCliPackagePrefixes(paths, [transaction.newIdentity.npmPrefix]);
	return reconciliation;
}

export function reconcilePendingRuntimeCliUpgrade(
	paths: RuntimePaths,
	runningVersion: string,
): RuntimeCliReconciliationResult {
	return reconcileCliUpgradeTransaction(paths, { runningVersion });
}

function prepareCliUpgradeTransaction(
	paths: RuntimePaths,
	input: {
		newIdentity: RuntimeCliInstallIdentity;
		previousIdentity: RuntimeCliInstallIdentity | null;
		rollbackEligible: boolean;
	},
): void {
	const state = normalizeCliUpgradeState(readCliUpgradeState(paths));
	state.transaction = {
		phase: "prepared",
		previousIdentity: input.previousIdentity,
		newIdentity: input.newIdentity,
		rollbackEligible: input.rollbackEligible,
		installedAt: new Date().toISOString(),
		rollback: null,
	};
	writeCliUpgradeState(paths, state);
}

function activateCliUpgradeTransaction(paths: RuntimePaths): void {
	const state = readCliUpgradeState(paths);
	const transaction = state.transaction;
	if (transaction?.phase !== "prepared") {
		throw new Error("prepared clawdi CLI upgrade transaction is missing");
	}
	if (activeLinkTarget(paths.cliManagedBin) !== transaction.newIdentity.activeTarget) {
		throw new Error("prepared clawdi CLI target is not active");
	}
	writeCliUpgradeState(paths, {
		...state,
		transaction: { ...transaction, phase: "activated" },
	});
}

function reconcileCliUpgradeTransaction(
	paths: RuntimePaths,
	opts: RuntimeCliReconciliationOptions = {},
): RuntimeCliReconciliationResult {
	const state = readCliUpgradeState(paths);
	const transaction = state.transaction ?? null;
	if (!transaction) return { status: "unchanged", selfReexec: false };
	if (transaction.rollback) {
		finishCliRollback(paths, transaction);
		return cliReconciliationResult(paths, "rolled_back", opts.runningVersion);
	}

	const activeTarget = activeLinkTarget(paths.cliManagedBin);
	const previousTarget = transaction.previousIdentity?.activeTarget ?? null;
	if (transaction.phase === "prepared") {
		if (activeTarget === transaction.newIdentity.activeTarget) {
			const verification = verifyStoredCliIdentity(paths, transaction.newIdentity);
			if (!verification) {
				rollBackInvalidTransaction(paths, transaction);
				return cliReconciliationResult(paths, "rolled_back", opts.runningVersion);
			}
			writeCliBootstrapStatus(paths, transaction.newIdentity, verification);
			activateCliUpgradeTransaction(paths);
			pruneCliPackagePrefixes(paths, [
				transaction.newIdentity.npmPrefix,
				transaction.previousIdentity?.npmPrefix ?? null,
			]);
			return cliReconciliationResult(paths, "activated", opts.runningVersion);
		}
		if (activeTarget === previousTarget) {
			if (transaction.previousIdentity) {
				const verification = verifyStoredCliIdentity(paths, transaction.previousIdentity);
				if (!verification) {
					throw new Error("prepared clawdi CLI transaction has an invalid previous identity");
				}
				writeCliBootstrapStatus(paths, transaction.previousIdentity, verification);
			}
			writeCliUpgradeState(paths, { ...state, transaction: null });
			pruneCliPackagePrefixes(paths, [transaction.previousIdentity?.npmPrefix ?? null]);
			return cliReconciliationResult(paths, "unchanged", opts.runningVersion);
		}
		rollBackInvalidTransaction(paths, transaction);
		return cliReconciliationResult(paths, "rolled_back", opts.runningVersion);
	}

	if (activeTarget === transaction.newIdentity.activeTarget) {
		if (!verifyStoredCliIdentity(paths, transaction.newIdentity)) {
			rollBackInvalidTransaction(paths, transaction);
			return cliReconciliationResult(paths, "rolled_back", opts.runningVersion);
		}
		return cliReconciliationResult(paths, "unchanged", opts.runningVersion);
	}
	if (transaction.previousIdentity && activeTarget === previousTarget) {
		const rollbackTransaction = withRecoveryRollback(transaction);
		writeCliUpgradeState(paths, { ...state, transaction: rollbackTransaction });
		finishCliRollback(paths, rollbackTransaction);
		return cliReconciliationResult(paths, "rolled_back", opts.runningVersion);
	}
	// The root image bootstrap is an independent activation owner. Transfer the
	// journal to its exact identity before ordinary reconciliation may continue.
	if (handoffCliUpgradeTransactionToBootstrap(paths, transaction)) {
		return cliReconciliationResult(paths, "activated", opts.runningVersion);
	}
	rollBackInvalidTransaction(paths, transaction);
	return cliReconciliationResult(paths, "rolled_back", opts.runningVersion);
}

function handoffCliUpgradeTransactionToBootstrap(
	paths: RuntimePaths,
	expectedTransaction: RuntimeCliUpgradeTransaction,
): boolean {
	const bootstrapIdentity = verifiedActiveBootstrapIdentity(paths);
	if (!bootstrapIdentity) return false;

	// cli-upgrade-state has one writer under the runtime convergence lock. The
	// complete prior transaction is the fence for this compare-and-replace.
	const currentState = readCliUpgradeState(paths);
	if (!cliUpgradeTransactionsMatch(currentState.transaction ?? null, expectedTransaction)) {
		throw new Error("clawdi CLI transaction changed during bootstrap ownership handoff");
	}
	const currentBootstrapIdentity = verifiedActiveBootstrapIdentity(paths);
	if (
		!currentBootstrapIdentity ||
		!cliInstallIdentitiesMatch(currentBootstrapIdentity, bootstrapIdentity)
	) {
		throw new Error("clawdi CLI bootstrap identity changed during ownership handoff");
	}

	writeCliUpgradeState(paths, {
		...currentState,
		transaction: {
			phase: "activated",
			previousIdentity: null,
			newIdentity: bootstrapIdentity,
			rollbackEligible: false,
			installedAt: new Date().toISOString(),
			rollback: null,
		},
	});
	if (activeLinkTarget(paths.cliManagedBin) !== bootstrapIdentity.activeTarget) {
		throw new Error("clawdi CLI bootstrap identity changed after ownership handoff");
	}
	pruneCliPackagePrefixes(paths, [bootstrapIdentity.npmPrefix]);
	return true;
}

function cliUpgradeTransactionsMatch(
	left: RuntimeCliUpgradeTransaction | null,
	right: RuntimeCliUpgradeTransaction | null,
): boolean {
	if (left === null || right === null) return left === right;
	return (
		left.phase === right.phase &&
		cliInstallIdentitiesMatch(left.previousIdentity, right.previousIdentity) &&
		cliInstallIdentitiesMatch(left.newIdentity, right.newIdentity) &&
		left.rollbackEligible === right.rollbackEligible &&
		left.installedAt === right.installedAt &&
		left.rollback?.reason === right.rollback?.reason &&
		left.rollback?.markedAt === right.rollback?.markedAt
	);
}

function cliInstallIdentitiesMatch(
	left: RuntimeCliInstallIdentity | null,
	right: RuntimeCliInstallIdentity | null,
): boolean {
	if (left === null || right === null) return left === right;
	return (
		left.packageSpec === right.packageSpec &&
		left.registry === right.registry &&
		left.npmPrefix === right.npmPrefix &&
		left.activeTarget === right.activeTarget &&
		left.version === right.version
	);
}

function verifiedActiveBootstrapIdentity(paths: RuntimePaths): RuntimeCliInstallIdentity | null {
	const status = readBootstrapStatus(paths.cliBootstrapStatus);
	const activeTarget = activeLinkTarget(paths.cliManagedBin);
	if (
		status?.schemaVersion !== "clawdi.cliNpmBootstrapStatus.v1" ||
		status.status !== "installed" ||
		status.source !== "npm" ||
		status.error !== null ||
		status.activePath !== paths.cliManagedBin ||
		status.activeTarget !== activeTarget ||
		status.npmCache !== paths.cliNpmCache ||
		typeof status.packageSpec !== "string" ||
		(status.registry !== null && typeof status.registry !== "string") ||
		typeof status.npmPrefix !== "string" ||
		typeof status.activeTarget !== "string" ||
		typeof status.version !== "string"
	) {
		return null;
	}
	const identity: RuntimeCliInstallIdentity = {
		packageSpec: status.packageSpec,
		registry: status.registry,
		npmPrefix: status.npmPrefix,
		activeTarget: status.activeTarget,
		version: status.version,
	};
	if (!verifyStoredCliIdentity(paths, identity)) return null;
	const currentStatus = readBootstrapStatus(paths.cliBootstrapStatus);
	return activeLinkTarget(paths.cliManagedBin) === identity.activeTarget &&
		statusMatchesIdentity(currentStatus, paths, identity) &&
		currentStatus?.schemaVersion === "clawdi.cliNpmBootstrapStatus.v1" &&
		currentStatus.error === null &&
		currentStatus.npmCache === paths.cliNpmCache
		? identity
		: null;
}

function cliReconciliationResult(
	paths: RuntimePaths,
	status: RuntimeCliReconciliationResult["status"],
	runningVersion: string | undefined,
): RuntimeCliReconciliationResult {
	const bootstrap = readBootstrapStatus(paths.cliBootstrapStatus);
	const activeTarget = activeLinkTarget(paths.cliManagedBin);
	const activeVersion = bootstrap?.activeTarget === activeTarget ? bootstrap.version : undefined;
	return {
		status,
		selfReexec:
			runningVersion !== undefined &&
			activeVersion !== undefined &&
			activeVersion !== runningVersion,
	};
}

function rollBackInvalidTransaction(
	paths: RuntimePaths,
	transaction: RuntimeCliUpgradeTransaction,
): void {
	if (
		!transaction.previousIdentity ||
		!verifyStoredCliIdentity(paths, transaction.previousIdentity)
	) {
		throw new Error("clawdi CLI transaction cannot restore a verified previous identity");
	}
	const rollbackTransaction = withRecoveryRollback(transaction);
	const state = readCliUpgradeState(paths);
	writeCliUpgradeState(paths, { ...state, transaction: rollbackTransaction });
	finishCliRollback(paths, rollbackTransaction);
}

function withRecoveryRollback(
	transaction: RuntimeCliUpgradeTransaction,
): RuntimeCliUpgradeTransaction {
	return {
		...transaction,
		rollback: {
			reason: "recovered interrupted or inconsistent clawdi CLI transaction",
			markedAt: new Date().toISOString(),
		},
	};
}

function finishCliRollback(paths: RuntimePaths, transaction: RuntimeCliUpgradeTransaction): void {
	const previousIdentity = transaction.previousIdentity;
	if (!transaction.rollback || !previousIdentity) {
		throw new Error("clawdi CLI rollback transaction is incomplete");
	}
	const verification = verifyStoredCliIdentity(paths, previousIdentity);
	if (!verification) {
		throw new Error("previous clawdi CLI identity failed rollback verification");
	}
	const activeTarget = activeLinkTarget(paths.cliManagedBin);
	if (activeTarget !== previousIdentity.activeTarget) {
		swapActiveCli(paths.cliManagedBin, previousIdentity.activeTarget);
	}
	writeCliBootstrapStatus(paths, previousIdentity, verification);
	const state = readCliUpgradeState(paths);
	writeCliUpgradeState(paths, {
		...state,
		transaction: null,
		badVersions: upsertBadVersion(state.badVersions ?? [], {
			packageSpec: transaction.newIdentity.packageSpec,
			registry: transaction.newIdentity.registry,
			version: transaction.newIdentity.version,
			reason: transaction.rollback.reason,
			markedAt: transaction.rollback.markedAt,
		}),
	});
	pruneCliPackagePrefixes(paths, [previousIdentity.npmPrefix]);
}

function verifyStoredCliIdentity(
	paths: RuntimePaths,
	identity: RuntimeCliInstallIdentity,
): RuntimeCliVerification | null {
	if (
		!hostedFixtureCliPackageSpecSchema.safeParse(identity.packageSpec).success ||
		(identity.registry !== null && identity.registry !== "https://registry.npmjs.org") ||
		!isManagedCliTarget(paths, identity.activeTarget) ||
		!isManagedCliPrefix(paths, identity.npmPrefix) ||
		resolve(prefixForActiveTarget(identity.activeTarget)) !== resolve(identity.npmPrefix) ||
		!isExecutable(identity.activeTarget)
	) {
		return null;
	}
	const exactVersion = exactNpmPackageVersion(identity.packageSpec);
	if (exactVersion && exactVersion !== identity.version) return null;
	const status = readBootstrapStatus(paths.cliBootstrapStatus);
	const fileIdentity = cliVerificationIdentity(identity.activeTarget);
	if (
		statusMatchesIdentity(status, paths, identity) &&
		fileIdentity &&
		status?.verification &&
		verificationIdentityMatches(status.verification, fileIdentity) &&
		verificationIsFresh(status.verification)
	) {
		return status.verification;
	}
	if (!fileIdentity) return null;
	try {
		if (smokeCliVersion(identity.activeTarget) !== identity.version) return null;
		verifyCliRuntime(identity.activeTarget);
		const verification = finishCliVerification(identity.activeTarget, fileIdentity);
		if (activeLinkTarget(paths.cliManagedBin) === identity.activeTarget) {
			writeCliBootstrapStatus(paths, identity, verification);
		}
		return verification;
	} catch {
		return null;
	}
}

function statusMatchesIdentity(
	status: RuntimeCliBootstrapStatus | null,
	paths: RuntimePaths,
	identity: RuntimeCliInstallIdentity,
): boolean {
	return (
		status?.status === "installed" &&
		status.source === "npm" &&
		status.packageSpec === identity.packageSpec &&
		(status.registry ?? null) === identity.registry &&
		status.npmPrefix === identity.npmPrefix &&
		status.activePath === paths.cliManagedBin &&
		status.activeTarget === identity.activeTarget &&
		status.version === identity.version
	);
}

function rollbackErrorResult(
	transaction: RuntimeCliUpgradeTransaction | null,
	error: unknown,
): RuntimeCliRollbackResult {
	return {
		status: "error",
		version: transaction?.newIdentity.version ?? null,
		previousVersion: transaction?.previousIdentity?.version ?? null,
		activeTarget: transaction?.newIdentity.activeTarget ?? null,
		previousActiveTarget: transaction?.previousIdentity?.activeTarget ?? null,
		error: error instanceof Error ? error.message : String(error),
	};
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
	if (!existsSync(paths.cliUpgradeState)) return emptyCliUpgradeState();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(paths.cliUpgradeState, "utf-8")) as unknown;
	} catch (error) {
		throw new Error(
			`invalid clawdi CLI upgrade transaction JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const schemaVersion =
		typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>).schemaVersion
			: undefined;
	if (schemaVersion === "clawdi.cliUpgradeState.v2") {
		const result = cliUpgradeStateV2Schema.safeParse(parsed);
		if (!result.success) {
			throw new Error(`invalid clawdi CLI upgrade transaction: ${result.error.issues[0]?.message}`);
		}
		return result.data;
	}
	throw new Error(`unsupported clawdi CLI upgrade transaction schema: ${String(schemaVersion)}`);
}

function writeCliUpgradeState(paths: RuntimePaths, state: RuntimeCliUpgradeState): void {
	writeRuntimePlatformFileAtomic(
		paths,
		paths.cliUpgradeState,
		`${JSON.stringify(normalizeCliUpgradeState(state), null, 2)}\n`,
		{ mode: 0o600, dirMode: 0o755 },
	);
}

function normalizeCliUpgradeState(state: RuntimeCliUpgradeState): RuntimeCliUpgradeState {
	return {
		schemaVersion: "clawdi.cliUpgradeState.v2",
		transaction: state.transaction ?? null,
		badVersions: state.badVersions ?? [],
	};
}

function emptyCliUpgradeState(): RuntimeCliUpgradeState {
	return {
		schemaVersion: "clawdi.cliUpgradeState.v2",
		transaction: null,
		badVersions: [],
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

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
