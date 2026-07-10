import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { z } from "zod";
import { writePrivateFileAtomic } from "../lib/private-file";
import { isSemverLessThan } from "../lib/semver";
import { getCliVersion } from "../lib/version";
import { ensureRuntimeAuthTokenFile, runtimeAuthTokenFileLabel } from "../runtime/auth-token";
import { RUNTIME_BRIDGE_SURFACES_ENV, startRuntimeBridge } from "../runtime/bridge";
import { applyRuntimeChannelsToManifestLoad } from "../runtime/channels";
import {
	applyRuntimeCliDesiredState,
	completePendingRuntimeCliUpgrade,
	type RuntimeCliRollbackResult,
	type RuntimeCliUpdateResult,
	rollbackPendingRuntimeCliUpgrade,
} from "../runtime/cli-update";
import { buildEgressEngineEnv, SYSTEM_CA_BUNDLE } from "../runtime/egress-env";
import { readHostPolicy } from "../runtime/host-policy";
import {
	cacheRuntimeLastGoodManifest,
	convergeRuntimeManifest,
	loadRuntimeManifest,
	withRuntimeConvergeLock,
} from "../runtime/manifest";
import { manifestSchema as runtimeDesiredStateSchema } from "../runtime/manifest-contract";
import {
	loadRemoteRuntimeChannels,
	loadRemoteRuntimeManifest,
	type RuntimeChannelsLoad,
	type RuntimeChannelsNotModified,
	type RuntimeManifestLoad,
	type RuntimeManifestNotModified,
} from "../runtime/manifest-source";
import { detectRuntimeMode, getRuntimePaths, type RuntimePaths } from "../runtime/paths";
import {
	buildRuntimeBootStatus,
	ensureRuntimeStateDirs,
	hostPolicySummary,
	type RuntimeBootStage,
	readRuntimeBootStatus,
	writeRuntimeBootStatus,
	writeRuntimeWatchStatus,
} from "../runtime/state";
import {
	isGeneratedRuntimeSystemdFile,
	runtimeUserName,
	runtimeUserSystemdEnvArgs,
} from "../runtime/systemd-user";
import {
	applyTransparentEgressNftRulesFromEnv,
	cleanupTransparentEgressNftRulesFromEnv,
	loadTransparentEgressEnvConfig,
	type TransparentEgressEnvConfig,
} from "../runtime/transparent-egress";

interface RuntimeInitOptions {
	nonInteractive?: boolean;
	json?: boolean;
	manifestFile?: string;
}

interface RuntimeWatchOptions {
	intervalMs?: number | string;
	selfHealMs?: number | string;
	once?: boolean;
	json?: boolean;
}

interface RuntimeVerifyOptions {
	json?: boolean;
}

interface RuntimeDoctorCheck {
	name: string;
	ok: boolean;
	detail?: string;
	hint?: string;
}

interface MinimumCliVersionGate {
	minimumCliVersion: string;
	currentCliVersion: string;
	rejectedGeneration: number;
	activeGeneration: number | null;
	error: string;
}

type RuntimeApplyResult = RuntimeApplyConvergedResult | RuntimeApplyGatedResult;

interface RuntimeApplyConvergedResult {
	kind: "converged";
	convergence: ReturnType<typeof convergeRuntimeManifest>;
	cliUpdate: RuntimeCliUpdateResult;
}

interface RuntimeApplyGatedResult {
	kind: "minimum_cli_version_gated";
	cliUpdate: RuntimeCliUpdateResult;
	gate: MinimumCliVersionGate;
}

interface RuntimeApplyOptions {
	continueOnCliUpdateError?: boolean;
	deferCliInstall?: boolean;
	deferCliInstallReason?: string;
	manifestIdentity?: RuntimeManifestIdentity;
}

interface RuntimeManifestIdentity {
	generation?: number | null;
	etag?: string | null;
	previouslyApplied?: boolean;
}

function hasRuntimeCredential(input: {
	manifestPath?: string;
	paths?: ReturnType<typeof getRuntimePaths>;
}): boolean {
	if (input.manifestPath) return true;
	const paths = input.paths ?? getRuntimePaths();
	if (existsSync(paths.manifestLastGood)) return true;
	return ensureRuntimeAuthTokenFile(paths) !== null;
}

function runtimeCredentialName(paths: ReturnType<typeof getRuntimePaths>): string {
	return runtimeAuthTokenFileLabel(paths);
}

function writable(path: string): boolean {
	try {
		accessSync(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function readable(path: string): boolean {
	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function readRuntimeManifestEtag(paths: ReturnType<typeof getRuntimePaths>): string | undefined {
	if (!existsSync(paths.manifestEtag)) return undefined;
	const etag = readFileSync(paths.manifestEtag, "utf-8").trim();
	return etag || undefined;
}

function writeRuntimeManifestEtag(
	paths: ReturnType<typeof getRuntimePaths>,
	etag: string | undefined,
): void {
	if (!etag) {
		rmSync(paths.manifestEtag, { force: true });
		return;
	}
	writePrivateFileAtomic(paths.manifestEtag, `${etag}\n`, { mode: 0o644, dirMode: 0o755 });
}

function cacheRuntimeSourceManifest(load: RuntimeManifestLoad, paths: RuntimePaths): string | null {
	return cacheRuntimeLastGoodManifest(
		load.sourceManifest ?? load.manifest,
		paths,
		load.secretValues,
	);
}

function readRuntimeChannelsEtag(paths: ReturnType<typeof getRuntimePaths>): string | undefined {
	if (!existsSync(paths.channelsEtag)) return undefined;
	const etag = readFileSync(paths.channelsEtag, "utf-8").trim();
	return etag || undefined;
}

function writeRuntimeChannelsEtag(
	paths: ReturnType<typeof getRuntimePaths>,
	etag: string | undefined,
): void {
	if (!etag) {
		rmSync(paths.channelsEtag, { force: true });
		return;
	}
	writePrivateFileAtomic(paths.channelsEtag, `${etag}\n`, { mode: 0o644, dirMode: 0o755 });
}

function parsePositiveMs(
	value: number | string | undefined,
	fallback: number,
	name: string,
): number {
	if (value === undefined) return fallback;
	const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer number of milliseconds`);
	}
	return parsed;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function readFileIfExists(path: string): string | null {
	if (!existsSync(path)) return null;
	return readFileSync(path, "utf-8");
}

interface SystemdUnitSnapshot {
	system: Map<string, string>;
	user: Map<string, string>;
}

const RUNTIME_WATCH_SYSTEM_UNIT = "clawdi-runtime-watch.service";

function readSystemdUnitSnapshot(paths: ReturnType<typeof getRuntimePaths>): SystemdUnitSnapshot {
	return {
		system: readManagedSystemdUnits(paths.systemdSystemRoot),
		user: readManagedSystemdUnits(paths.systemdUserRoot),
	};
}

function readManagedSystemdUnits(root: string): Map<string, string> {
	const units = new Map<string, string>();
	if (!existsSync(root)) return units;
	for (const entry of readdirSync(root)) {
		if (entry.endsWith(".service")) {
			const path = join(root, entry);
			const contents = readFileIfExists(path);
			if (
				contents === null ||
				(!entry.startsWith("clawdi-") && !isGeneratedRuntimeSystemdFile(contents))
			) {
				continue;
			}
			units.set(entry, contents);
			continue;
		}
		if (!entry.endsWith(".service.d")) {
			continue;
		}
		const unitName = entry.slice(0, -".d".length);
		const dropInPath = join(root, entry, "10-clawdi-hosted.conf");
		const dropIn = readFileIfExists(dropInPath);
		if (!dropIn || !isGeneratedRuntimeSystemdFile(dropIn)) continue;
		const base = readFileIfExists(join(root, unitName)) ?? "";
		units.set(unitName, `${base}\n${dropIn}`);
	}
	return units;
}

function changedSystemdUnits(
	before: Map<string, string>,
	after: Map<string, string>,
): { changed: string[]; removed: string[]; present: string[] } {
	const changed: string[] = [];
	const removed: string[] = [];
	for (const [name, contents] of after) {
		if (before.get(name) !== contents) changed.push(name);
	}
	for (const name of before.keys()) {
		if (!after.has(name)) removed.push(name);
	}
	return {
		changed: changed.sort(),
		removed: removed.sort(),
		present: [...after.keys()].sort(),
	};
}

function applySystemdRuntimeUpdate(
	paths: ReturnType<typeof getRuntimePaths>,
	before: SystemdUnitSnapshot,
	after: SystemdUnitSnapshot,
): { applied: boolean; systemUnitsChanged: string[]; userUnitsChanged: string[] } {
	const system = changedSystemdUnits(before.system, after.system);
	const user = changedSystemdUnits(before.user, after.user);
	if (
		system.changed.length === 0 &&
		system.removed.length === 0 &&
		user.changed.length === 0 &&
		user.removed.length === 0
	) {
		return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
	}
	if (!shouldApplySystemdRuntimeUpdate(paths)) {
		// Unit files changed on disk but this environment does not own a live
		// systemd (non-root/dev); report the divergence instead of hiding it.
		return { applied: false, systemUnitsChanged: system.changed, userUnitsChanged: user.changed };
	}

	const removableSystemUnits = system.removed.filter((unit) => unit !== RUNTIME_WATCH_SYSTEM_UNIT);
	if (removableSystemUnits.length > 0) {
		systemctl(["stop", ...removableSystemUnits], { allowNonZero: true });
	}
	systemctl(["daemon-reload"]);
	if (system.present.length > 0) systemctl(["start", ...system.present]);
	const restartSystemUnits = system.changed.filter((unit) => unit !== RUNTIME_WATCH_SYSTEM_UNIT);
	if (restartSystemUnits.length > 0) {
		systemctl(["restart", ...restartSystemUnits]);
	}

	if (user.removed.length > 0) {
		runtimeUserSystemctl(paths, ["stop", ...user.removed], {
			allowNonZero: true,
		});
	}
	runtimeUserSystemctl(paths, ["daemon-reload"]);
	if (user.present.length > 0) runtimeUserSystemctl(paths, ["enable", "--now", ...user.present]);
	if (user.removed.length > 0) {
		runtimeUserSystemctl(paths, ["disable", ...user.removed], { allowNonZero: true });
	}
	if (user.changed.length > 0) runtimeUserSystemctl(paths, ["restart", ...user.changed]);
	return { applied: true, systemUnitsChanged: system.changed, userUnitsChanged: user.changed };
}

function shouldApplySystemdRuntimeUpdate(paths: ReturnType<typeof getRuntimePaths>): boolean {
	const override = process.env.CLAWDI_SYSTEMD_APPLY?.trim().toLowerCase();
	if (override === "1" || override === "true") return true;
	if (override === "0" || override === "false") return false;
	return paths.systemdSystemRoot === "/run/systemd/system";
}

function systemctl(args: string[], opts: { allowNonZero?: boolean } = {}): string {
	return runCommand(systemctlPath(), args, opts);
}

function systemctlPath(): string {
	return process.env.CLAWDI_SYSTEMCTL_PATH?.trim() || "systemctl";
}

function runtimeUserSystemctl(
	paths: ReturnType<typeof getRuntimePaths>,
	args: string[],
	opts: { allowNonZero?: boolean } = {},
): string {
	const runtimeUser = runtimeUserName();
	if (process.getuid?.() === 0 && runtimeUser !== "root") {
		const uid = commandOutput("id", ["-u", runtimeUser]).trim();
		return runCommand(
			"gosu",
			[
				runtimeUser,
				"env",
				...runtimeUserSystemdEnvArgs(paths, runtimeUser, uid),
				"systemctl",
				"--user",
				...args,
			],
			opts,
		);
	}
	return runCommand(systemctlPath(), ["--user", ...args], opts);
}

function commandOutput(command: string, args: string[]): string {
	return runCommand(command, args);
}

function runCommand(
	command: string,
	args: string[],
	opts: { allowNonZero?: boolean } = {},
): string {
	const result = spawnSync(command, args, { encoding: "utf8" });
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
	if (result.status === 0 || opts.allowNonZero) return output;
	throw new Error(
		`${command} ${args.join(" ")} failed${result.status === null ? "" : ` (${result.status})`}${
			result.error ? `: ${result.error.message}` : ""
		}${output ? `: ${output.slice(0, 1000)}` : ""}`,
	);
}

function emitRuntimeWatchEvent(value: unknown, json: boolean | undefined): void {
	if (json) {
		console.log(JSON.stringify(value));
		return;
	}
	if (!value || typeof value !== "object") return;
	const event = value as {
		status?: string;
		generation?: number;
		error?: string;
		errors?: string[];
	};
	if (event.status === "applied") {
		console.log(`runtime watch applied generation ${event.generation ?? "unknown"}`);
		return;
	}
	if (event.status === "error") {
		console.error(`runtime watch error: ${event.error ?? event.errors?.[0] ?? "unknown error"}`);
	}
}

function repairStatus(
	input: {
		bootId: string;
		stage: RuntimeBootStage;
		runtimeMode: "local" | "hosted";
		errors: string[];
		exitCode: number;
	},
	paths = getRuntimePaths(),
) {
	const policy = readHostPolicy(paths.hostPolicy);
	return buildRuntimeBootStatus(
		{
			mode: "repair",
			status: "error",
			stage: input.stage,
			bootId: input.bootId,
			runtimeMode: input.runtimeMode,
			activeGeneration: null,
			enabledRuntimes: [],
			error: input.errors[0],
			errors: input.errors,
			exitCode: input.exitCode,
			datasource: "RuntimeSource",
			hostPolicy: hostPolicySummary(policy),
		},
		paths,
	);
}

export async function runtimeVerify(opts: RuntimeVerifyOptions = {}) {
	const paths = getRuntimePaths();
	const manifestCacheExists = existsSync(paths.manifestLastGood);
	const errors: string[] = [];
	if (manifestCacheExists) {
		try {
			const raw = JSON.parse(readFileSync(paths.manifestLastGood, "utf-8")) as unknown;
			const parsed = runtimeDesiredStateSchema.safeParse(raw);
			if (!parsed.success) {
				errors.push(`cached manifest parse failed: ${z.prettifyError(parsed.error)}`);
			}
		} catch (error) {
			errors.push(
				`cached manifest parse failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const result = {
		schemaVersion: "clawdi.runtimeVerify.v1",
		status: errors.length === 0 ? "ok" : "error",
		cliVersion: getCliVersion(),
		manifestCache: {
			path: paths.manifestLastGood,
			exists: manifestCacheExists,
			valid: errors.length === 0,
		},
		errors,
	};
	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(result, null, 2));
	} else if (errors.length === 0) {
		console.log(chalk.green("runtime verify ok"));
	} else {
		console.log(chalk.red(errors[0]));
	}
	if (errors.length > 0) process.exitCode = 1;
}

export async function runtimeInit(opts: RuntimeInitOptions = {}) {
	const paths = getRuntimePaths();
	const mode = detectRuntimeMode();
	const bootId = randomUUID();

	if (mode !== "hosted") {
		const status = repairStatus(
			{
				bootId,
				runtimeMode: mode,
				stage: "detect",
				exitCode: 2,
				errors: [
					"runtime init requires hosted runtime mode (host policy or CLAWDI_RUNTIME_MODE=hosted)",
				],
			},
			paths,
		);
		if (opts.json || !process.stdout.isTTY) {
			console.log(JSON.stringify(status, null, 2));
		} else {
			console.log(chalk.red("runtime init is only available in hosted runtime mode."));
		}
		process.exitCode = 2;
		return;
	}

	const hostPolicy = readHostPolicy(paths.hostPolicy);
	try {
		ensureRuntimeStateDirs(paths);
	} catch (e) {
		const status = repairStatus(
			{
				bootId,
				runtimeMode: mode,
				stage: "detect",
				exitCode: 20,
				errors: [
					`could not create runtime state directories: ${
						e instanceof Error ? e.message : String(e)
					}`,
				],
			},
			paths,
		);
		if (opts.json || !process.stdout.isTTY) console.log(JSON.stringify(status, null, 2));
		else console.log(chalk.red(status.error));
		process.exitCode = 20;
		return;
	}

	const credentialAvailable = hasRuntimeCredential({ manifestPath: opts.manifestFile, paths });
	const nonInteractiveOk = opts.nonInteractive === true;
	const errors: string[] = [];
	let stage: RuntimeBootStage = "detect";
	let exitCode = 20;
	if (!nonInteractiveOk) {
		errors.push("runtime init requires --non-interactive in hosted mode");
	}
	if (!hostPolicy.exists) {
		errors.push(`missing hosted runtime policy at ${hostPolicy.path}`);
	} else if (!hostPolicy.valid) {
		errors.push(
			`invalid hosted runtime policy at ${hostPolicy.path}: ${hostPolicy.error ?? "parse failed"}`,
		);
	}
	if (!credentialAvailable) {
		errors.push(`missing ${runtimeCredentialName(paths)} and no last-good runtime manifest cache`);
	}
	if (errors.length === 0) {
		stage = "local";
		const loaded = await loadRuntimeManifest(paths, { manifestPath: opts.manifestFile });
		if ("errors" in loaded) {
			stage = loaded.stage;
			exitCode = loaded.mode === "manifest-rejected" ? 22 : 21;
			errors.push(...loaded.errors);
			const status = buildRuntimeBootStatus(
				{
					mode: loaded.mode,
					status: "error",
					stage,
					bootId,
					runtimeMode: mode,
					activeGeneration: loaded.activeGeneration ?? null,
					rejectedGeneration: loaded.rejectedGeneration ?? null,
					enabledRuntimes: [],
					error: errors[0],
					errors,
					exitCode,
					datasource: "RuntimeSource",
					hostPolicy: hostPolicySummary(hostPolicy),
				},
				paths,
			);
			writeRuntimeBootStatus(status, paths);

			if (opts.json || !process.stdout.isTTY) {
				console.log(JSON.stringify(status, null, 2));
			} else {
				console.log(chalk.bold("clawdi runtime init"));
				console.log(chalk.yellow(`  ${loaded.mode}: ${errors[0]}`));
				console.log(chalk.gray(`  status: ${paths.bootStatus}`));
			}
			process.exitCode = exitCode;
			return;
		}

		let channelsLoad: RuntimeChannelsLoad | null = null;
		let convergenceLoad = loaded;
		if (loaded.source === "remote-datasource") {
			const loadedChannels = await loadRemoteRuntimeChannels(paths);
			if ("errors" in loadedChannels) {
				const status = buildRuntimeBootStatus(
					{
						mode: loadedChannels.mode,
						status: "error",
						stage: loadedChannels.stage,
						bootId,
						runtimeMode: mode,
						activeGeneration: null,
						enabledRuntimes: [],
						error: loadedChannels.errors[0],
						errors: loadedChannels.errors,
						exitCode: 21,
						datasource: "RuntimeSource",
						hostPolicy: hostPolicySummary(hostPolicy),
					},
					paths,
				);
				writeRuntimeBootStatus(status, paths);

				if (opts.json || !process.stdout.isTTY) {
					console.log(JSON.stringify(status, null, 2));
				} else {
					console.log(chalk.bold("clawdi runtime init"));
					console.log(chalk.yellow(`  ${loadedChannels.mode}: ${loadedChannels.errors[0]}`));
					console.log(chalk.gray(`  status: ${paths.bootStatus}`));
				}
				process.exitCode = 21;
				return;
			}
			if ("notModified" in loadedChannels) {
				const errors = ["runtime channels datasource returned 304 without If-None-Match"];
				const status = buildRuntimeBootStatus(
					{
						mode: "repair",
						status: "error",
						stage: "network",
						bootId,
						runtimeMode: mode,
						activeGeneration: null,
						enabledRuntimes: [],
						error: errors[0],
						errors,
						exitCode: 21,
						datasource: "RuntimeSource",
						hostPolicy: hostPolicySummary(hostPolicy),
					},
					paths,
				);
				writeRuntimeBootStatus(status, paths);

				if (opts.json || !process.stdout.isTTY) {
					console.log(JSON.stringify(status, null, 2));
				} else {
					console.log(chalk.bold("clawdi runtime init"));
					console.log(chalk.yellow(`  repair: ${errors[0]}`));
					console.log(chalk.gray(`  status: ${paths.bootStatus}`));
				}
				process.exitCode = 21;
				return;
			}
			channelsLoad = loadedChannels;
			convergenceLoad = applyRuntimeChannelsToManifestLoad(loaded, channelsLoad);
		}

		let applyResult: RuntimeApplyResult;
		const previousSystemdUnits = readSystemdUnitSnapshot(paths);
		try {
			applyResult = withRuntimeConvergeLock(paths, () =>
				applyRuntimeDesiredState(convergenceLoad, paths, {
					manifestIdentity: {
						generation: convergenceLoad.manifest.generation,
						etag: loaded.etag ?? null,
					},
				}),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = buildRuntimeBootStatus(
				{
					mode: "repair",
					status: "error",
					stage: "final",
					bootId,
					runtimeMode: mode,
					activeGeneration: convergenceLoad.manifest.generation,
					instanceId: convergenceLoad.manifest.instanceId,
					enabledRuntimes: [],
					error: message,
					errors: [message],
					exitCode: 23,
					datasource: "RuntimeSource",
					hostPolicy: hostPolicySummary(hostPolicy),
					manifestSource: {
						type: convergenceLoad.source,
						path: convergenceLoad.sourcePath,
						offline: convergenceLoad.offline,
					},
				},
				paths,
			);
			writeRuntimeBootStatus(status, paths);
			if (opts.json || !process.stdout.isTTY) {
				console.log(JSON.stringify(status, null, 2));
			} else {
				console.log(chalk.bold("clawdi runtime init"));
				console.log(chalk.red(`  repair: ${message}`));
				console.log(chalk.gray(`  status: ${paths.bootStatus}`));
			}
			process.exitCode = 23;
			return;
		}
		if (applyResult.kind === "minimum_cli_version_gated") {
			const status = buildRuntimeBootStatus(
				{
					mode: "repair",
					status: "error",
					stage: "config",
					bootId,
					runtimeMode: mode,
					activeGeneration: applyResult.gate.activeGeneration,
					rejectedGeneration: applyResult.gate.rejectedGeneration,
					instanceId: convergenceLoad.manifest.instanceId,
					enabledRuntimes: [],
					error: applyResult.gate.error,
					errors: [applyResult.gate.error],
					exitCode: 24,
					datasource: "RuntimeSource",
					hostPolicy: hostPolicySummary(hostPolicy),
					manifestSource: {
						type: convergenceLoad.source,
						path: convergenceLoad.sourcePath,
						offline: convergenceLoad.offline,
					},
				},
				paths,
			);
			writeRuntimeBootStatus(status, paths);
			if (opts.json || !process.stdout.isTTY) {
				console.log(
					JSON.stringify(
						{ ...status, cliUpdate: applyResult.cliUpdate, gate: applyResult.gate },
						null,
						2,
					),
				);
			} else {
				console.log(chalk.bold("clawdi runtime init"));
				console.log(chalk.yellow(`  repair: ${applyResult.gate.error}`));
				console.log(chalk.gray(`  status: ${paths.bootStatus}`));
			}
			process.exitCode = 24;
			return;
		}
		const { convergence } = applyResult;
		let systemdApplyError: string | null = null;
		// Convergence errors must not block systemd apply: unit files already
		// changed on disk, and stops/disables for removed units have to land
		// even when an unrelated runtime install or projection failed.
		try {
			applySystemdRuntimeUpdate(paths, previousSystemdUnits, readSystemdUnitSnapshot(paths));
		} catch (error) {
			systemdApplyError = `systemd apply failed: ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
		const runtimeErrors = [
			...convergence.installErrors,
			...(systemdApplyError ? [systemdApplyError] : []),
		];
		const installOk = runtimeErrors.length === 0;
		if (installOk && loaded.source === "remote-datasource") {
			convergence.outputs.manifestLastGood = cacheRuntimeSourceManifest(convergenceLoad, paths);
			writeRuntimeManifestEtag(paths, loaded.etag);
			if (channelsLoad) {
				writeRuntimeChannelsEtag(paths, channelsLoad.etag);
			}
		} else if (installOk) {
			convergence.outputs.manifestLastGood = cacheRuntimeSourceManifest(convergenceLoad, paths);
		}
		const status = buildRuntimeBootStatus(
			{
				mode: convergence.mode,
				status: installOk ? "ok" : "error",
				stage: "final",
				bootId,
				runtimeMode: mode,
				activeGeneration: convergence.manifest.generation,
				instanceId: convergence.manifest.instanceId,
				enabledRuntimes: convergence.enabledRuntimes,
				error: runtimeErrors[0],
				errors: runtimeErrors,
				exitCode: installOk ? 0 : 23,
				datasource: "RuntimeSource",
				hostPolicy: hostPolicySummary(hostPolicy),
				manifestSource: {
					type: convergence.source,
					path: convergence.sourcePath,
					offline: convergence.offline,
				},
				convergence: convergence.outputs,
			},
			paths,
		);
		writeRuntimeBootStatus(status, paths);

		if (opts.json || !process.stdout.isTTY) {
			console.log(JSON.stringify(status, null, 2));
		} else {
			console.log(chalk.bold("clawdi runtime init"));
			console.log(
				chalk.green(`  ${convergence.mode}: generation ${convergence.manifest.generation}`),
			);
			console.log(chalk.gray(`  status: ${paths.bootStatus}`));
		}
		process.exitCode = installOk ? 0 : 23;
		return;
	}

	const status = buildRuntimeBootStatus(
		{
			mode: "repair",
			status: "error",
			stage,
			bootId,
			runtimeMode: mode,
			activeGeneration: null,
			enabledRuntimes: [],
			error: errors[0],
			errors,
			exitCode,
			datasource: "RuntimeSource",
			hostPolicy: hostPolicySummary(hostPolicy),
		},
		paths,
	);
	writeRuntimeBootStatus(status, paths);

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(status, null, 2));
	} else {
		console.log(chalk.bold("clawdi runtime init"));
		console.log(chalk.yellow(`  repair: ${errors[0]}`));
		console.log(chalk.gray(`  status: ${paths.bootStatus}`));
	}
	process.exitCode = exitCode;
}

async function runtimeWatchTick(
	paths: ReturnType<typeof getRuntimePaths>,
	opts: { forceRefresh: boolean; deferCliInstall?: boolean; deferCliInstallReason?: string },
): Promise<Record<string, unknown>> {
	const manifestEtag = opts.forceRefresh ? undefined : readRuntimeManifestEtag(paths);
	const channelsEtag = opts.forceRefresh ? undefined : readRuntimeChannelsEtag(paths);
	const [manifestLoad, channelsLoad] = await Promise.all([
		loadRemoteRuntimeManifest(paths, { ifNoneMatch: manifestEtag }),
		loadRemoteRuntimeChannels(paths, { ifNoneMatch: channelsEtag }),
	]);
	if ("errors" in manifestLoad) {
		return {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "error",
			mode: manifestLoad.mode,
			stage: manifestLoad.stage,
			errors: manifestLoad.errors,
			error: manifestLoad.errors[0],
			activeGeneration: manifestLoad.activeGeneration ?? null,
			rejectedGeneration: manifestLoad.rejectedGeneration ?? null,
		};
	}
	if ("errors" in channelsLoad) {
		return {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "error",
			mode: channelsLoad.mode,
			stage: channelsLoad.stage,
			errors: channelsLoad.errors,
			error: channelsLoad.errors[0],
		};
	}
	if ("notModified" in manifestLoad && "notModified" in channelsLoad) {
		return {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "not_modified",
			sourcePath: manifestLoad.sourcePath,
			etag: manifestLoad.etag ?? manifestEtag ?? null,
			channelsSourcePath: channelsLoad.sourcePath,
			channelsEtag: channelsLoad.etag ?? channelsEtag ?? null,
		};
	}

	try {
		const previousSystemdUnits = readSystemdUnitSnapshot(paths);
		const loaded = await runtimeWatchLoadForApply(paths, manifestLoad, channelsLoad);
		const manifestIdentity = runtimeManifestIdentityForWatch(
			manifestLoad,
			manifestEtag,
			loaded.manifest.generation,
			paths,
		);
		const applyResult = withRuntimeConvergeLock(paths, () =>
			applyRuntimeDesiredState(loaded, paths, {
				continueOnCliUpdateError: true,
				deferCliInstall: opts.deferCliInstall,
				deferCliInstallReason: opts.deferCliInstallReason,
				manifestIdentity,
			}),
		);
		if (applyResult.kind === "minimum_cli_version_gated") {
			const cliUpdateError =
				applyResult.cliUpdate.status === "error"
					? (applyResult.cliUpdate.error ?? "CLI update failed")
					: null;
			const errors = [...(cliUpdateError ? [cliUpdateError] : []), applyResult.gate.error];
			return {
				schemaVersion: "clawdi.runtimeWatchEvent.v1",
				status: "error",
				stage: cliUpdateError ? "cli-update" : "config",
				mode: "minimum_cli_version_gated",
				errors,
				error: errors[0],
				activeGeneration: applyResult.gate.activeGeneration,
				rejectedGeneration: applyResult.gate.rejectedGeneration,
				cliUpdate: applyResult.cliUpdate,
				selfReexec: shouldSelfReexecForCliUpdate(applyResult.cliUpdate),
				gate: applyResult.gate,
			};
		}
		const { convergence, cliUpdate } = applyResult;
		const cliUpdateError =
			cliUpdate.status === "error" ? (cliUpdate.error ?? "CLI update failed") : null;
		let systemdApplyResult = {
			applied: false,
			systemUnitsChanged: [] as string[],
			userUnitsChanged: [] as string[],
		};
		let systemdApplyError: string | null = null;
		// Convergence errors must not block systemd apply: unit files already
		// changed on disk, and stops/disables for removed units have to land
		// even when an unrelated runtime install or projection failed.
		try {
			systemdApplyResult = applySystemdRuntimeUpdate(
				paths,
				previousSystemdUnits,
				readSystemdUnitSnapshot(paths),
			);
		} catch (error) {
			systemdApplyError = `systemd apply failed: ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
		const errors = [
			...(cliUpdateError ? [cliUpdateError] : []),
			...convergence.installErrors,
			...(systemdApplyError ? [systemdApplyError] : []),
		];
		let selfReexec = shouldSelfReexecForCliUpdate(cliUpdate);
		const systemdUnitsChanged =
			systemdApplyResult.systemUnitsChanged.length > 0 ||
			systemdApplyResult.userUnitsChanged.length > 0;
		if (errors.length > 0) {
			if (convergence.installErrors.length === 0 && !systemdApplyError) {
				convergence.outputs.manifestLastGood = cacheRuntimeSourceManifest(loaded, paths);
				if (!("notModified" in manifestLoad)) {
					writeRuntimeManifestEtag(paths, manifestLoad.etag);
				}
				if (!("notModified" in channelsLoad)) {
					writeRuntimeChannelsEtag(paths, channelsLoad.etag);
				}
			}
			const cliRollback = maybeRollbackFailedCliUpgrade(paths, manifestIdentity, errors);
			if (cliRollback.status === "rolled_back") selfReexec = false;
			return {
				schemaVersion: "clawdi.runtimeWatchEvent.v1",
				status: "error",
				stage: cliUpdateError ? "cli-update" : "final",
				errors,
				error: errors[0],
				activeGeneration: convergence.manifest.generation,
				cliUpdate,
				cliRollback,
				selfReexec,
				systemdUnitsChanged,
				systemdApply: systemdApplyResult,
				convergence: convergence.outputs,
			};
		}
		convergence.outputs.manifestLastGood = cacheRuntimeSourceManifest(loaded, paths);
		if (!("notModified" in manifestLoad)) {
			writeRuntimeManifestEtag(paths, manifestLoad.etag);
		}
		if (!("notModified" in channelsLoad)) {
			writeRuntimeChannelsEtag(paths, channelsLoad.etag);
		}
		completePendingRuntimeCliUpgrade(paths, getCliVersion(), manifestIdentity);
		return {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "applied",
			sourcePath: loaded.sourcePath,
			etag:
				"notModified" in manifestLoad
					? (manifestLoad.etag ?? manifestEtag ?? null)
					: (manifestLoad.etag ?? null),
			channelsSourcePath: channelsLoad.sourcePath,
			channelsEtag:
				"notModified" in channelsLoad
					? (channelsLoad.etag ?? channelsEtag ?? null)
					: (channelsLoad.etag ?? null),
			generation: convergence.manifest.generation,
			instanceId: convergence.manifest.instanceId,
			enabledRuntimes: convergence.enabledRuntimes,
			cliUpdate,
			selfReexec,
			systemdUnitsChanged,
			systemdApply: systemdApplyResult,
			convergence: convergence.outputs,
		};
	} catch (error) {
		return {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "error",
			stage: "final",
			errors: [error instanceof Error ? error.message : String(error)],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function applyRuntimeDesiredState(
	load: RuntimeManifestLoad,
	paths: ReturnType<typeof getRuntimePaths>,
	opts: RuntimeApplyOptions = {},
): RuntimeApplyResult {
	let cliUpdate: RuntimeCliUpdateResult;
	try {
		cliUpdate = applyRuntimeCliDesiredState(load.manifest, paths, {
			deferInstall: opts.deferCliInstall,
			deferReason: opts.deferCliInstallReason,
			manifestIdentity: opts.manifestIdentity,
		});
	} catch (error) {
		if (!opts.continueOnCliUpdateError) throw error;
		cliUpdate = runtimeCliUpdateError(load.manifest, paths, error);
	}
	const gate = minimumCliVersionGate(load.manifest, paths);
	if (gate) {
		return { kind: "minimum_cli_version_gated", cliUpdate, gate };
	}
	const convergence = convergeRuntimeManifest(load, paths, { cacheLastGood: false });
	return { kind: "converged", cliUpdate, convergence };
}

function minimumCliVersionGate(
	manifest: RuntimeManifestLoad["manifest"],
	paths: RuntimePaths,
): MinimumCliVersionGate | null {
	const minimumCliVersion = manifest.minimumCliVersion?.trim();
	if (!minimumCliVersion) return null;
	const currentCliVersion = getCliVersion();
	if (!isSemverLessThan(currentCliVersion, minimumCliVersion)) return null;
	return {
		minimumCliVersion,
		currentCliVersion,
		rejectedGeneration: manifest.generation,
		activeGeneration: readLastGoodManifestGeneration(paths),
		error: `runtime desired state requires clawdi CLI >= ${minimumCliVersion}; current CLI is ${currentCliVersion}. Keeping last-good applied state while CLI self-upgrade runs.`,
	};
}

function readLastGoodManifestGeneration(paths: RuntimePaths): number | null {
	try {
		const parsed = JSON.parse(readFileSync(paths.manifestLastGood, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const generation = (parsed as Record<string, unknown>).generation;
		return typeof generation === "number" && Number.isInteger(generation) ? generation : null;
	} catch {
		return null;
	}
}

function runtimeCliUpdateError(
	manifest: RuntimeManifestLoad["manifest"],
	paths: ReturnType<typeof getRuntimePaths>,
	error: unknown,
): RuntimeCliUpdateResult {
	const rawRegistry = (manifest.clawdiCli as Record<string, unknown> | undefined)?.registry;
	return {
		status: "error",
		packageSpec: manifest.clawdiCli?.packageSpec?.trim() || null,
		registry: typeof rawRegistry === "string" && rawRegistry.trim() ? rawRegistry.trim() : null,
		npmPrefix: paths.cliNpmPrefix,
		npmCache: paths.cliNpmCache,
		activePath: paths.cliManagedBin,
		activeTarget: null,
		version: null,
		error: error instanceof Error ? error.message : String(error),
	};
}

function shouldSelfReexecForCliUpdate(cliUpdate: RuntimeCliUpdateResult): boolean {
	if (cliUpdate.status === "installed") return true;
	if (!cliUpdate.version || !cliUpdate.activeTarget) return false;
	return cliUpdate.version !== getCliVersion();
}

function runtimeManifestIdentityForWatch(
	manifestLoad: RuntimeManifestLoad | RuntimeManifestNotModified,
	existingEtag: string | undefined,
	generation: number,
	paths: RuntimePaths,
): RuntimeManifestIdentity {
	const etag =
		"notModified" in manifestLoad
			? (manifestLoad.etag ?? existingEtag ?? null)
			: (manifestLoad.etag ?? null);
	const lastGoodGeneration = readLastGoodManifestGeneration(paths);
	return {
		generation,
		etag,
		previouslyApplied:
			(existingEtag !== undefined && etag === existingEtag) ||
			(existingEtag === undefined && lastGoodGeneration === generation),
	};
}

function maybeRollbackFailedCliUpgrade(
	paths: RuntimePaths,
	manifestIdentity: RuntimeManifestIdentity,
	errors: string[],
): RuntimeCliRollbackResult {
	const rollback = rollbackPendingRuntimeCliUpgrade(
		paths,
		`first converge after CLI upgrade failed: ${errors[0] ?? "unknown error"}`,
		manifestIdentity,
	);
	if (rollback.status === "rolled_back") {
		errors.push(
			`rolled back clawdi CLI ${rollback.version} to previous version ${rollback.previousVersion ?? "unknown"}`,
		);
	} else if (rollback.status === "error") {
		errors.push(`failed to roll back clawdi CLI ${rollback.version}: ${rollback.error}`);
	}
	return rollback;
}

async function runtimeWatchLoadForApply(
	paths: ReturnType<typeof getRuntimePaths>,
	manifestLoad: RuntimeManifestLoad | RuntimeManifestNotModified,
	channelsLoad: RuntimeChannelsLoad | RuntimeChannelsNotModified,
): Promise<RuntimeManifestLoad> {
	const loaded =
		"notModified" in manifestLoad ? await loadFullRuntimeManifestForWatch(paths) : manifestLoad;
	const channelDesired =
		"notModified" in channelsLoad ? await loadFullRuntimeChannelsForWatch(paths) : channelsLoad;
	return applyRuntimeChannelsToManifestLoad(loaded, channelDesired);
}

async function loadFullRuntimeManifestForWatch(
	paths: ReturnType<typeof getRuntimePaths>,
): Promise<RuntimeManifestLoad> {
	const loaded = await loadRemoteRuntimeManifest(paths);
	if ("notModified" in loaded) {
		throw new Error("runtime manifest datasource returned 304 without If-None-Match");
	}
	if ("errors" in loaded) {
		throw new Error(loaded.errors.join("; "));
	}
	return loaded;
}

async function loadFullRuntimeChannelsForWatch(
	paths: ReturnType<typeof getRuntimePaths>,
): Promise<RuntimeChannelsLoad> {
	const loaded = await loadRemoteRuntimeChannels(paths);
	if ("notModified" in loaded) {
		throw new Error("runtime channels datasource returned 304 without If-None-Match");
	}
	if ("errors" in loaded) {
		throw new Error(loaded.errors.join("; "));
	}
	return loaded;
}

export async function runtimeWatch(opts: RuntimeWatchOptions = {}) {
	const paths = getRuntimePaths();
	const mode = detectRuntimeMode();
	const intervalMs = parsePositiveMs(opts.intervalMs, 15_000, "--interval-ms");
	const selfHealMs = parsePositiveMs(opts.selfHealMs, 300_000, "--self-heal-ms");
	let lastFullFetchAt = Date.now();
	let cliInstallRetryPending = false;
	let cliInstallBackoffMs = 0;
	let nextCliInstallRetryAt = 0;

	if (mode !== "hosted") {
		const event = {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "error",
			stage: "detect",
			error: "runtime watch requires hosted runtime mode",
			errors: ["runtime watch requires hosted runtime mode"],
		};
		emitRuntimeWatchEvent(event, opts.json);
		process.exitCode = 2;
		return;
	}

	try {
		ensureRuntimeStateDirs(paths);
	} catch (error) {
		const message = `could not create runtime state directories: ${
			error instanceof Error ? error.message : String(error)
		}`;
		const event = {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "error",
			stage: "detect",
			error: message,
			errors: [message],
		};
		emitRuntimeWatchEvent(event, opts.json);
		process.exitCode = 20;
		return;
	}

	for (;;) {
		const now = Date.now();
		const cliInstallRetryDue = cliInstallRetryPending && now >= nextCliInstallRetryAt;
		const deferCliInstall = cliInstallRetryPending && !cliInstallRetryDue;
		const forceRefresh = now - lastFullFetchAt >= selfHealMs || cliInstallRetryDue;
		const event = await runtimeWatchTick(paths, {
			forceRefresh,
			deferCliInstall,
			deferCliInstallReason: deferCliInstall
				? `CLI install retry is in backoff until ${new Date(nextCliInstallRetryAt).toISOString()}`
				: undefined,
		});
		const cliUpdateStatus = runtimeWatchCliUpdateStatus(event);
		if (cliUpdateStatus === "error") {
			cliInstallRetryPending = true;
			cliInstallBackoffMs = nextCliInstallBackoffMs(cliInstallBackoffMs);
			nextCliInstallRetryAt = Date.now() + cliInstallBackoffMs;
		} else if (
			cliUpdateStatus === "installed" ||
			cliUpdateStatus === "current" ||
			cliUpdateStatus === "not_requested"
		) {
			cliInstallRetryPending = false;
			cliInstallBackoffMs = 0;
			nextCliInstallRetryAt = 0;
		}
		if (event.status === "applied" || forceRefresh) lastFullFetchAt = Date.now();
		writeRuntimeWatchStatus(event, paths);
		emitRuntimeWatchEvent(event, opts.json);
		if (opts.once) {
			if (event.status === "error") process.exitCode = 1;
			else process.exitCode = 0;
			return;
		}
		if (event.selfReexec === true) {
			return;
		}
		await sleep(intervalMs);
	}
}

function runtimeWatchCliUpdateStatus(
	event: Record<string, unknown>,
): RuntimeCliUpdateResult["status"] | null {
	const cliUpdate = event.cliUpdate;
	if (!cliUpdate || typeof cliUpdate !== "object" || Array.isArray(cliUpdate)) return null;
	const status = (cliUpdate as Record<string, unknown>).status;
	if (
		status === "not_requested" ||
		status === "current" ||
		status === "installed" ||
		status === "deferred" ||
		status === "error"
	) {
		return status;
	}
	return null;
}

function nextCliInstallBackoffMs(previousMs: number): number {
	if (previousMs <= 0) return 60_000;
	return Math.min(previousMs * 2, 300_000);
}

export async function runtimeSidecar(): Promise<void> {
	if (detectRuntimeMode() !== "hosted") {
		throw new Error("runtime sidecar is only available in hosted runtime mode");
	}
	const shouldStartBridge = Boolean(process.env[RUNTIME_BRIDGE_SURFACES_ENV]?.trim());
	const shouldStartEgress = Boolean(process.env.CLAWDI_EGRESS_ENV_FILE?.trim());
	if (!shouldStartBridge && !shouldStartEgress) {
		throw new Error("runtime sidecar requires at least one configured module.");
	}

	let bridge: Awaited<ReturnType<typeof startRuntimeBridge>> | null = null;
	let egress: RuntimeEgressModule | null = null;
	try {
		if (shouldStartEgress) {
			egress = await startRuntimeEgress();
			console.error(`runtime sidecar egress module listening on 127.0.0.1:${egress.port}`);
		}
		if (shouldStartBridge) {
			bridge = await startRuntimeBridge();
			console.error(
				`runtime sidecar bridge module listening on ${bridge.surfaces
					.map(
						(surface) =>
							`${surface.listenHost}:${surface.listenPort}->${surface.upstreamHost}:${surface.upstreamPort}`,
					)
					.join(", ")}`,
			);
		}
		notifySystemdReady("runtime sidecar ready");
	} catch (error) {
		egress?.close();
		await bridge?.close();
		throw error;
	}

	const shutdown = waitForShutdownSignal().then(() => ({ kind: "shutdown" as const }));
	const egressExit = egress?.wait().then(() => ({ kind: "egress-exit" as const }));
	try {
		await (egressExit ? Promise.race([shutdown, egressExit]) : shutdown);
	} finally {
		egress?.close();
		await bridge?.close();
		await egressExit?.catch(() => undefined);
	}
}

interface RuntimeEgressModule {
	port: number;
	close: () => void;
	wait: () => Promise<void>;
}

async function startRuntimeEgress(): Promise<RuntimeEgressModule> {
	const config = loadTransparentEgressEnvConfig(process.env);
	const mitmdump = startMitmdump(config);
	const mitmdumpExit = waitForChildExit(mitmdump);
	let redirectApplied = false;
	let closeRequested = false;
	const cleanup = () => {
		if (!redirectApplied) return;
		try {
			cleanupTransparentEgressNftRulesFromEnv(process.env);
		} catch (error) {
			console.error(
				`transparent egress nft cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		redirectApplied = false;
	};
	const close = () => {
		closeRequested = true;
		cleanup();
		if (!mitmdump.killed) mitmdump.kill("SIGTERM");
	};
	try {
		await waitForTcpPort("127.0.0.1", config.transparentPort, 15_000, () =>
			childHasExited(mitmdump),
		);
		await waitForFile(config.caCertPath, 10_000, () => childHasExited(mitmdump));
		publishEgressSystemCaBundle(config);
		applyTransparentEgressNftRulesFromEnv(process.env);
		redirectApplied = true;
		return {
			port: config.transparentPort,
			close,
			wait: async () => {
				const exit = await mitmdumpExit;
				cleanup();
				if (!closeRequested) {
					const reason = exit.signal === null ? `status ${exit.code}` : `signal ${exit.signal}`;
					throw new Error(`egress engine exited unexpectedly with ${reason}`);
				}
			},
		};
	} catch (error) {
		close();
		throw error;
	}
}

function startMitmdump(config: TransparentEgressEnvConfig): ChildProcess {
	if (!existsSync(config.engineBinaryPath)) {
		throw new Error(`egress engine binary is missing: ${config.engineBinaryPath}`);
	}
	if (!existsSync(config.addonPath)) {
		throw new Error(`egress addon is missing: ${config.addonPath}`);
	}
	const mitmdumpArgs = [
		"--mode",
		"transparent",
		"--listen-host",
		"127.0.0.1",
		"--listen-port",
		String(config.transparentPort),
		"--set",
		`confdir=${config.caDir}`,
		"--set",
		"stream_large_bodies=1",
		"--set",
		"termlog_verbosity=info",
		"-s",
		config.addonPath,
	];
	const childEnv = buildEgressEngineEnv(process.env, {
		envFile: config.envFile,
		home: config.caDir,
	});
	const command = config.engineBinaryPath;
	const args = mitmdumpArgs;
	const child =
		runningAsRootCommand() && config.egressUser !== "root"
			? spawnAsUser(config.egressUser, command, args, childEnv)
			: spawn(command, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout?.pipe(process.stdout);
	child.stderr?.pipe(process.stderr);
	return child;
}

function spawnAsUser(
	user: string,
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): ChildProcess {
	if (commandExistsOnPath("gosu")) {
		return spawn("gosu", [user, command, ...args], {
			env: { ...env, USER: user, LOGNAME: user },
			stdio: ["ignore", "pipe", "pipe"],
		});
	}
	if (commandExistsOnPath("runuser")) {
		return spawn("runuser", ["-u", user, "--", command, ...args], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
	}
	throw new Error(`cannot drop egress engine to ${user}; install gosu or runuser`);
}

function waitForChildExit(
	child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

function childHasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

function waitForTcpPort(
	host: string,
	port: number,
	timeoutMs: number,
	hasExited: () => boolean,
): Promise<void> {
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const attempt = () => {
			if (hasExited()) {
				reject(new Error(`egress engine exited before listening on ${host}:${port}`));
				return;
			}
			if (tcpPortIsListening(host, port)) {
				resolve();
				return;
			}
			if (Date.now() - startedAt >= timeoutMs) {
				reject(new Error(`timed out waiting for egress engine on ${host}:${port}`));
				return;
			}
			setTimeout(attempt, 100);
		};
		attempt();
	});
}

function tcpPortIsListening(host: string, port: number): boolean {
	const portHex = port.toString(16).toUpperCase().padStart(4, "0");
	const allowedHosts =
		host === "127.0.0.1" ? new Set(["0100007F"]) : new Set(["00000000", "0100007F"]);
	try {
		for (const raw of readFileSync("/proc/net/tcp", "utf-8").split(/\r?\n/).slice(1)) {
			const fields = raw.trim().split(/\s+/);
			const localAddress = fields[1] ?? "";
			const state = fields[3] ?? "";
			const [address, localPort] = localAddress.split(":");
			if (state === "0A" && localPort === portHex && address && allowedHosts.has(address)) {
				return true;
			}
		}
	} catch {
		return false;
	}
	return false;
}

function waitForFile(path: string, timeoutMs: number, hasExited: () => boolean): Promise<void> {
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const attempt = () => {
			if (hasExited()) {
				reject(new Error(`egress engine exited before writing ${path}`));
				return;
			}
			if (existsSync(path)) {
				resolve();
				return;
			}
			if (Date.now() - startedAt >= timeoutMs) {
				reject(new Error(`timed out waiting for ${path}`));
				return;
			}
			setTimeout(attempt, 100);
		};
		attempt();
	});
}

function publishEgressSystemCaBundle(config: TransparentEgressEnvConfig): void {
	if (config.systemCaBundle === SYSTEM_CA_BUNDLE) {
		throw new Error("CLAWDI_EGRESS_SYSTEM_CA_BUNDLE must be a runtime-managed CA projection path");
	}
	const systemCa = readFileSync(SYSTEM_CA_BUNDLE, "utf-8");
	const egressCa = readFileSync(config.caCertPath, "utf-8");
	mkdirSync(dirname(config.systemCaBundle), { recursive: true });
	writeFileSync(config.systemCaBundle, `${systemCa.trimEnd()}\n${egressCa.trimEnd()}\n`, {
		mode: 0o644,
	});
	chmodSync(config.systemCaBundle, 0o644);
}

function runningAsRootCommand(): boolean {
	return typeof process.getuid === "function" && process.getuid() === 0;
}

function commandExistsOnPath(command: string): boolean {
	const result = spawnSync("command", ["-v", command], {
		shell: true,
		stdio: "ignore",
	});
	return result.status === 0;
}

function waitForShutdownSignal(): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			process.off("SIGTERM", done);
			process.off("SIGINT", done);
			resolve();
		};
		process.once("SIGTERM", done);
		process.once("SIGINT", done);
	});
}

function notifySystemdReady(status: string): void {
	if (!process.env.NOTIFY_SOCKET) return;
	spawnSync("systemd-notify", ["--ready", `--status=${status}`], {
		stdio: "ignore",
		env: process.env,
	});
}

export async function runtimeStatus(opts: { json?: boolean } = {}) {
	const paths = getRuntimePaths();
	const read = readRuntimeBootStatus(paths);
	const payload = {
		schemaVersion: "clawdi.runtimeStatus.v1",
		runtimeMode: paths.mode,
		paths: {
			bootStatus: paths.bootStatus,
			cloudStatus: paths.cloudStatus,
			cloudResult: paths.cloudResult,
			installInventory: paths.installInventory,
			syncState: paths.syncState,
			instanceData: paths.instanceData,
		},
		...read,
	};

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	console.log(chalk.bold("clawdi runtime status"));
	console.log();
	if (!read.exists) {
		console.log(chalk.gray("  No runtime boot status has been written yet."));
		return;
	}
	if (read.error) {
		console.log(chalk.red(`  Could not read ${read.source}: ${read.error}`));
		process.exitCode = 1;
		return;
	}
	if (!read.status) {
		console.log(chalk.yellow("  Runtime status files exist, but boot-status.json is missing."));
		return;
	}
	console.log(`  Mode: ${read.status?.mode ?? "unknown"}`);
	console.log(`  Status: ${read.status?.status ?? "unknown"}`);
	console.log(`  Stage: ${read.status?.stage ?? "unknown"}`);
	console.log(chalk.gray(`  Source: ${read.source}`));
	if (read.status?.error) console.log(chalk.yellow(`  Error: ${read.status.error}`));
}

export async function runtimeDoctor(opts: { json?: boolean } = {}) {
	const paths = getRuntimePaths();
	const policy = readHostPolicy(paths.hostPolicy);
	const lastStatus = readRuntimeBootStatus(paths);
	const checks: RuntimeDoctorCheck[] = [
		{
			name: "Runtime mode",
			ok: paths.mode === "hosted",
			detail: paths.mode,
			hint: "Hosted mode requires a host policy or CLAWDI_RUNTIME_MODE=hosted.",
		},
		{
			name: "Host policy",
			ok: policy.exists && policy.valid,
			detail: policy.exists ? (policy.valid ? policy.path : policy.error) : "missing",
			hint: "Expected a readable JSON policy at the configured host policy path.",
		},
		{
			name: "Service state",
			ok: existsSync(paths.serviceStateRoot) && writable(paths.serviceStateRoot),
			detail: paths.serviceStateRoot,
			hint: "The hosted service-state volume must be writable by the runtime user.",
		},
		{
			name: "Runtime HOME",
			ok: existsSync(paths.userHome) && writable(paths.userHome),
			detail: paths.userHome,
			hint: "HOME should be the persistent runtime/user volume.",
		},
		{
			name: "Ephemeral runtime state",
			ok: existsSync(paths.runRoot),
			detail: paths.runRoot,
			hint: "The runtime tmpfs path should be recreated on each boot and owned by the system boundary.",
		},
		{
			name: "Sensitive instance data",
			ok: !existsSync(paths.sensitiveInstanceData) || readable(paths.sensitiveInstanceData),
			detail: existsSync(paths.sensitiveInstanceData) ? "present" : "absent",
		},
		{
			name: "Last boot status",
			ok:
				!lastStatus.exists ||
				(lastStatus.status?.status === "ok" && lastStatus.status.errors.length === 0),
			detail: !lastStatus.exists
				? "none"
				: (lastStatus.error ??
					`${lastStatus.status?.status ?? "unknown"} / ${lastStatus.status?.mode ?? "unknown"}`),
			hint: "Run `clawdi runtime status` for the last boot result.",
		},
	];
	const failed = checks.filter((check) => !check.ok).length;

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(checks, null, 2));
		if (failed > 0) process.exitCode = 1;
		return;
	}

	console.log(chalk.bold("clawdi runtime doctor"));
	console.log();
	for (const check of checks) {
		const icon = check.ok ? chalk.green("✓") : chalk.red("✗");
		const detail = check.detail ? chalk.gray(` — ${check.detail}`) : "";
		console.log(`  ${icon} ${check.name}${detail}`);
		if (!check.ok && check.hint) console.log(chalk.gray(`     ${check.hint}`));
	}
	if (failed > 0) process.exitCode = 1;
}
