import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { accessSync, chmodSync, chownSync, constants, existsSync, readFileSync } from "node:fs";
import chalk from "chalk";
import { z } from "zod";
import { writePrivateFileAtomic } from "../lib/private-file";
import { getCliVersion } from "../lib/version";
import {
	type RuntimeAppliedContentIdentity,
	type RuntimeUserProcessRevisionAliases,
	readRuntimeAppliedState,
	runtimeAppliedApplyIdentity,
	runtimeContentSha256,
	writeRuntimeAppliedState,
} from "../runtime/applied-state";
import {
	type RuntimeApplyContext,
	type RuntimeApplyIdentity,
	readRuntimeApplyContext,
	resolveRuntimeApplyGeneration,
	runtimeApplyIdentitiesEqual,
} from "../runtime/apply-identity";
import { readRuntimeAuthToken } from "../runtime/auth-token";
import { applyRuntimeBundleChannelsToManifestLoad } from "../runtime/channels";
import {
	applyRuntimeCliDesiredState,
	completePendingRuntimeCliUpgrade,
	type RuntimeCliReconciliationResult,
	type RuntimeCliRollbackResult,
	type RuntimeCliUpdateResult,
	reconcilePendingRuntimeCliUpgrade,
	rollbackPendingRuntimeCliUpgrade,
} from "../runtime/cli-update";
import { withRuntimeConvergeLockAsync } from "../runtime/converge-lock";
import { buildEgressEngineEnv, SYSTEM_CA_BUNDLE } from "../runtime/egress-env";
import { readHostPolicy } from "../runtime/host-policy";
import { failedHostedAgentPluginsObservation } from "../runtime/hosted-agent-plugin-observation";
import {
	cleanupHostedAgentPluginTransientArchives,
	gcHostedAgentPluginArchives,
	type PreparedHostedAgentPlugins,
	prepareHostedAgentPluginPackages,
	readHostedAgentPluginReceipt,
} from "../runtime/hosted-agent-plugin-package";
import type { HostedAgentPluginCommandRunner } from "../runtime/hosted-agent-plugin-runtime";
import {
	assertHostedRuntimeContract,
	type HostedRuntimeContractOptions,
	inspectHostedRuntimeIdentity,
} from "../runtime/hosted-runtime-contract";
import {
	gcHostedSkillArchives,
	type PreparedHostedSkill,
	prepareHostedSkillArchives,
} from "../runtime/hosted-sourced-skill-archive";
import {
	cacheRuntimeLastGoodManifest,
	convergeRuntimeManifest,
	loadRuntimeManifest,
	type RuntimePrivateAppliedAuthority,
	type RuntimeResourcePreparationFailures,
	runtimeRecoverableSecretValues,
} from "../runtime/manifest";
import {
	hostedRuntimeBundleV2Schema,
	loadCommittedRuntimeManifest,
	loadRemoteRuntimeManifest,
	type RuntimeManifestFailure,
	type RuntimeManifestLoad,
} from "../runtime/manifest-source";
import { detectRuntimeMode, getRuntimePaths, type RuntimePaths } from "../runtime/paths";
import { buildNumericUserCommand, runningAsRoot } from "../runtime/runtime-user-command";
import {
	assertRuntimePlatformRoots,
	buildRuntimeBootStatus,
	ensureRuntimeStateDirs,
	hostPolicySummary,
	type RuntimeBootStage,
	type RuntimeBootStatus,
	readRuntimeBootStatus,
	writeRuntimeBootStatus,
	writeRuntimeWatchStatus,
} from "../runtime/state";
import {
	applySystemdRuntimeUpdate,
	assertRuntimeUserCanRead,
	RUNTIME_DAEMON_SYSTEM_UNIT,
	RUNTIME_SIDECAR_SYSTEM_UNIT,
	readSystemdUnitSnapshot,
	readSystemdUserDesiredRevisions,
	SystemdRuntimeTransaction,
	withoutStaleSystemdUnits,
} from "../runtime/systemd-transaction";
import {
	applyTransparentEgressNftRulesFromEnv,
	cleanupTransparentEgressNftRulesFromEnv,
	loadTransparentEgressEnvConfig,
	type TransparentEgressEnvConfig,
} from "../runtime/transparent-egress";
import { log, toErrorMessage } from "../serve/log";
import { consumeSse } from "../serve/sse-client";

interface RuntimeInitOptions {
	nonInteractive?: boolean;
	json?: boolean;
	applyContext?: RuntimeApplyContext;
	hostedRuntimeContract?: HostedRuntimeContractOptions;
}

interface RuntimeWatchOptions {
	intervalMs?: number | string;
	selfHealMs?: number | string;
	once?: boolean;
	json?: boolean;
	abort?: AbortSignal;
	notifications?: boolean;
	notificationConsumer?: typeof consumeSse;
	applyContext?: RuntimeApplyContext;
	hostedRuntimeContract?: HostedRuntimeContractOptions;
}

interface RuntimeVerifyOptions {
	json?: boolean;
}

// The image bootstrap is a RemainAfterExit oneshot with Restart=on-failure.
// A dedicated temporary-failure exit makes it start the newly activated CLI;
// runtime watch instead exits cleanly because its unit uses Restart=always.
const RUNTIME_INIT_CLI_HANDOFF_EXIT_CODE = 75;
const ACTIVE_CLI_VERSION = getCliVersion();
const RUNTIME_WATCH_INTERVAL_MS = 15_000;
const RUNTIME_WATCH_SELF_HEAL_MS = 300_000;
const RUNTIME_WATCH_INITIAL_BACKOFF_MS = 60_000;
const RUNTIME_WATCH_MAX_BACKOFF_MS = 300_000;
const EGRESS_LISTEN_TIMEOUT_MS = 15_000;
const EGRESS_CA_TIMEOUT_MS = 10_000;
const EGRESS_READY_POLL_MS = 100;

interface RuntimeDoctorCheck {
	name: string;
	ok: boolean;
	detail?: string;
	hint?: string;
}

type RuntimeApplyResult =
	| RuntimeApplyConvergedResult
	| RuntimeApplyCliHandoffResult
	| RuntimeApplyCliUpdateFailedResult;

interface RuntimeApplyConvergedResult {
	kind: "converged";
	convergence: ReturnType<typeof convergeRuntimeManifest>;
	cliUpdate: RuntimeCliUpdateResult;
	systemdApply: ReturnType<typeof applySystemdRuntimeUpdate>;
}

interface RuntimeApplyCliHandoffResult {
	kind: "cli_handoff";
	cliUpdate: RuntimeCliUpdateResult;
}

interface RuntimeApplyCliUpdateFailedResult {
	kind: "cli_update_failed";
	cliUpdate: RuntimeCliUpdateResult;
}

interface RuntimeApplyOptions {
	authorityCommit?: (
		convergence: ReturnType<typeof convergeRuntimeManifest>,
		authority: RuntimePrivateAppliedAuthority,
	) => void;
	continueOnCliUpdateError?: boolean;
	recoverFailedSystemdUnits?: boolean;
	requireSystemdApplied?: boolean;
	preparedHostedSourcedSkills?: ReadonlyMap<string, PreparedHostedSkill>;
	preparedHostedAgentPlugins?: PreparedHostedAgentPlugins | null;
	hostedAgentPluginCommandRunner?: HostedAgentPluginCommandRunner;
	hostedRuntimeContract?: HostedRuntimeContractOptions;
}

export type RuntimeManifestApplyOptions = Omit<
	RuntimeApplyOptions,
	"authorityCommit" | "requireSystemdApplied"
>;

interface RuntimeWatchFailureBackoff {
	backoffMs: number;
	etag: string | null;
	nextRetryAt: number;
}

interface RuntimeWatchTickOptions {
	forceRefresh: boolean;
	recoverFailedSystemdUnits?: boolean;
	failureBackoff?: RuntimeWatchFailureBackoff;
	now: number;
	applyContext?: RuntimeApplyContext;
	hostedRuntimeContract?: HostedRuntimeContractOptions;
}

type ConvergeLoadResult =
	| { kind: "ready"; load: RuntimeManifestLoad }
	| {
			kind: "not_modified";
			sourcePath: string;
			etag: string | null;
			applied: NonNullable<ReturnType<typeof readRuntimeAppliedState>>;
	  }
	| { kind: "failed"; failure: RuntimeManifestFailure }
	| { kind: "error"; error: string; etag?: string }
	| { kind: "idle" };

type ConvergeOutcome =
	| { kind: "idle" }
	| { kind: "reconciliation_error"; error: string }
	| {
			kind: "cli_handoff";
			detail:
				| { kind: "reconciliation"; reconciliation: RuntimeCliReconciliationResult }
				| { kind: "update"; load: RuntimeManifestLoad; cliUpdate: RuntimeCliUpdateResult };
	  }
	| { kind: "load_failed"; failure: RuntimeManifestFailure }
	| ({ kind: "not_modified"; selfReexec: boolean } & Extract<
			ConvergeLoadResult,
			{ kind: "not_modified" }
	  >)
	| { kind: "apply_error"; error: string; load?: RuntimeManifestLoad; etag?: string }
	| { kind: "cli_update_failed"; load: RuntimeManifestLoad; cliUpdate: RuntimeCliUpdateResult }
	| {
			kind: "converged";
			load: RuntimeManifestLoad;
			convergence: RuntimeApplyConvergedResult["convergence"];
			cliUpdate: RuntimeCliUpdateResult;
			systemdApply: RuntimeApplyConvergedResult["systemdApply"];
			runtimeErrors: string[];
			resourceProjectionErrors: string[];
			cliRollback: RuntimeCliRollbackResult | null;
			cliRollbackErrors: string[];
			selfReexec: boolean;
	  };

type ConvergePolicy = RuntimeManifestApplyOptions & {
	requireAppliedAuthority?: boolean;
};

type RuntimeWatchEventPayload = {
	cliUpdate?: RuntimeCliUpdateResult;
	etag?: string | null;
	selfReexec?: boolean;
	stage?: RuntimeBootStage | "cli-update" | "watch";
} & (
	| { status: "applied"; generation: number }
	| { status: "not_modified" }
	| { status: "cli_handoff"; stage: "cli-update"; selfReexec: true }
	| {
			status: "error";
			stage: RuntimeBootStage | "cli-update" | "watch";
			errors: string[];
			error: string | undefined;
	  }
);

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

function cacheRuntimeSourceManifest(load: RuntimeManifestLoad, paths: RuntimePaths): string | null {
	if (load.sourceBundle === undefined) return null;
	return cacheRuntimeLastGoodManifest(load.sourceBundle, paths, load.secretValues, load.manifest);
}

export function runtimeAppliedContentIdentity(
	load: RuntimeManifestLoad,
): RuntimeAppliedContentIdentity {
	return {
		sourcePath: load.sourcePath,
		sha256: runtimeContentSha256({
			manifest: load.sourceBundle ?? load.manifest,
			secretValues: runtimeRecoverableSecretValues(load.manifest, load.secretValues),
		}),
	};
}

// This revision may be surfaced through status/observation fallback fields.
// Keep secret-dependent recoverability verification in the root-only applied state.
export function runtimePublicContentRevision(load: RuntimeManifestLoad): string {
	return runtimeContentSha256({ manifest: load.manifest });
}

function runtimeAppliedStatus(paths: RuntimePaths): {
	activeGeneration: number | null;
	instanceId: string | null;
} {
	const applied = readRuntimeAppliedState(paths);
	return {
		activeGeneration: applied?.generation ?? null,
		instanceId: applied?.instanceId ?? null,
	};
}

function runtimeCheckpointContent(
	load: Pick<RuntimeManifestLoad, "manifest" | "secretValues">,
): unknown {
	const {
		generation: _generation,
		applyGeneration: _applyGeneration,
		issuedAt: _issuedAt,
		clawdiCli,
		...manifest
	} = load.manifest;
	const { packageSpec: _packageSpec, ...cliPolicy } = clawdiCli ?? {};
	return {
		manifest: {
			...manifest,
			...(clawdiCli === undefined ? {} : { clawdiCli: cliPolicy }),
		},
		secretValues: runtimeRecoverableSecretValues(load.manifest, load.secretValues),
	};
}

export function runtimeOnlyChangesCliPackage(
	previous: Pick<RuntimeManifestLoad, "manifest" | "secretValues">,
	next: Pick<RuntimeManifestLoad, "manifest" | "secretValues">,
): boolean {
	const previousPackageSpec = previous.manifest.clawdiCli?.packageSpec?.trim();
	const nextPackageSpec = next.manifest.clawdiCli?.packageSpec?.trim();
	if (!previousPackageSpec || !nextPackageSpec || previousPackageSpec === nextPackageSpec) {
		return false;
	}
	try {
		return (
			runtimeContentSha256(runtimeCheckpointContent(previous)) ===
			runtimeContentSha256(runtimeCheckpointContent(next))
		);
	} catch (error) {
		log.warn("runtime.cli_only_checkpoint_compare_failed", { error: toErrorMessage(error) });
		return false;
	}
}

function isRuntimeCliOnlyCheckpoint(load: RuntimeManifestLoad, paths: RuntimePaths): boolean {
	const activeAppliedState = readRuntimeAppliedState(paths);
	const activeApplyIdentity = activeAppliedState
		? runtimeAppliedApplyIdentity(activeAppliedState)
		: null;
	if (
		!load.applyContext ||
		!activeApplyIdentity ||
		!runtimeApplyIdentitiesEqual(load.applyContext.identity, activeApplyIdentity)
	) {
		return false;
	}
	const committed = loadCommittedRuntimeManifest(paths, load.applyContext);
	return "errors" in committed ? false : runtimeOnlyChangesCliPackage(committed, load);
}

export function commitRuntimeAppliedState(input: {
	load: RuntimeManifestLoad;
	paths: RuntimePaths;
	etag: string;
	sourceRevision: string;
	convergence: ReturnType<typeof convergeRuntimeManifest>;
	applyIdentity: RuntimeApplyIdentity | null;
	daemonAuthTokenRevision?: string;
	daemonProgramRevision?: string;
	egressSidecarSecretRevision?: string;
	userProcessRevisionAliases?: RuntimeUserProcessRevisionAliases;
	officialServiceCommandRevisions?: Record<string, string>;
}): void {
	if (
		input.applyIdentity &&
		input.applyIdentity.generation !== resolveRuntimeApplyGeneration(input.convergence.manifest)
	) {
		throw new Error(
			`runtime apply identity generation ${input.applyIdentity.generation} does not match resolved manifest apply generation ${resolveRuntimeApplyGeneration(input.convergence.manifest)}`,
		);
	}
	// The apply identity names the Hosted control-plane snapshot; `etag` names
	// the independently rendered runtime bundle. Persist both authorities.
	const providerIds = runtimeSourceProviderIds(input.load.manifest);
	input.convergence.outputs.manifestLastGood = cacheRuntimeSourceManifest(input.load, input.paths);
	input.convergence.outputs.appliedState = writeRuntimeAppliedState(
		{
			schemaVersion: "clawdi.runtimeAppliedState.v2",
			appliedAt: new Date().toISOString(),
			instanceId: input.convergence.manifest.instanceId,
			etag: input.etag,
			sourceRevision: input.sourceRevision,
			generation: input.convergence.manifest.generation,
			...(input.convergence.manifest.applyGeneration === undefined
				? {}
				: { applyGeneration: input.convergence.manifest.applyGeneration }),
			...(input.applyIdentity
				? {
						manifestETag: input.applyIdentity.manifestETag,
						applyReceiptId: input.applyIdentity.applyReceiptId,
						bootNonce: input.applyIdentity.bootNonce,
					}
				: {}),
			contentIdentity: runtimeAppliedContentIdentity(input.load),
			...(input.daemonAuthTokenRevision
				? { daemonAuthTokenRevision: input.daemonAuthTokenRevision }
				: {}),
			...(input.daemonProgramRevision
				? { daemonProgramRevision: input.daemonProgramRevision }
				: {}),
			...(input.egressSidecarSecretRevision
				? { egressSidecarSecretRevision: input.egressSidecarSecretRevision }
				: {}),
			...(input.userProcessRevisionAliases &&
			Object.keys(input.userProcessRevisionAliases).length > 0
				? { userProcessRevisionAliases: input.userProcessRevisionAliases }
				: {}),
			officialServiceCommandRevisions: input.officialServiceCommandRevisions ?? {},
			providerIds,
			projectedProviderIds: input.convergence.projectedProviderIds,
		},
		input.paths,
	);
}

function runtimeSourceProviderIds(manifest: RuntimeManifestLoad["manifest"]): string[] {
	const selectedRuntime = manifest.runtime;
	if (!selectedRuntime) return [];
	return [...new Set(manifest.runtimes[selectedRuntime]?.provider_ids ?? [])].sort();
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

interface RuntimeWatchWakeSignal {
	signal: () => void;
	wait: (ms: number, abort?: AbortSignal) => Promise<"notification" | "poll" | "aborted">;
}

function createRuntimeWatchWakeSignal(): RuntimeWatchWakeSignal {
	let queued = false;
	let wake: (() => void) | null = null;
	return {
		signal: () => {
			queued = true;
			wake?.();
		},
		wait: async (ms, abort) => {
			if (abort?.aborted) return "aborted";
			if (queued) {
				queued = false;
				return "notification";
			}
			return new Promise((resolveWait) => {
				let settled = false;
				const finish = (reason: "notification" | "poll" | "aborted") => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					abort?.removeEventListener("abort", onAbort);
					wake = null;
					if (reason === "notification") queued = false;
					resolveWait(reason);
				};
				const timer = setTimeout(() => finish("poll"), ms);
				const onAbort = () => finish("aborted");
				wake = () => finish("notification");
				abort?.addEventListener("abort", onAbort, { once: true });
			});
		},
	};
}

interface RuntimeWatchNotificationConfig {
	apiUrl: string;
	apiKey: string;
	environmentId: string;
}

interface RuntimeWatchNotificationSubscription {
	config: RuntimeWatchNotificationConfig;
	abort: AbortController;
	task: Promise<void>;
	settled: boolean;
}

function sameRuntimeWatchNotificationConfig(
	left: RuntimeWatchNotificationConfig,
	right: RuntimeWatchNotificationConfig,
): boolean {
	return (
		left.apiUrl === right.apiUrl &&
		left.apiKey === right.apiKey &&
		left.environmentId === right.environmentId
	);
}

function readRuntimeWatchNotificationConfig(
	paths: ReturnType<typeof getRuntimePaths>,
): RuntimeWatchNotificationConfig | null {
	const apiKey = readRuntimeAuthToken(paths);
	if (!apiKey || !existsSync(paths.manifestLastGood)) return null;
	try {
		const parsed = hostedRuntimeBundleV2Schema.safeParse(
			JSON.parse(readFileSync(paths.manifestLastGood, "utf-8")),
		);
		if (!parsed.success) return null;
		return {
			apiUrl: parsed.data.manifest.controlPlane.apiUrl,
			apiKey,
			environmentId: parsed.data.manifest.environmentId,
		};
	} catch {
		return null;
	}
}

function ensureRuntimeWatchNotificationSubscription(
	current: RuntimeWatchNotificationSubscription | null,
	paths: ReturnType<typeof getRuntimePaths>,
	wakeSignal: RuntimeWatchWakeSignal,
	opts: RuntimeWatchOptions,
): RuntimeWatchNotificationSubscription | null {
	if (opts.once || opts.notifications === false) return current;
	const config = readRuntimeWatchNotificationConfig(paths);
	if (!config) {
		current?.abort.abort();
		return null;
	}
	if (current && !current.settled && sameRuntimeWatchNotificationConfig(current.config, config)) {
		return current;
	}
	current?.abort.abort();
	const abort = new AbortController();
	const consumer = opts.notificationConsumer ?? consumeSse;
	const subscription: RuntimeWatchNotificationSubscription = {
		config,
		abort,
		task: Promise.resolve(),
		settled: false,
	};
	subscription.task = consumer({
		apiUrl: config.apiUrl,
		apiKey: config.apiKey,
		abort: abort.signal,
		onEvent: (event) => {
			if (
				event.type === "runtime_manifest_changed" &&
				event.environment_id === config.environmentId
			) {
				wakeSignal.signal();
			}
		},
		// Runtime-watch keeps ETag polling alive after auth failure. The settled
		// subscription becomes eligible for replacement on the next watch pass.
		onAuthFailure: () => {},
	}).finally(() => {
		subscription.settled = true;
	});
	void subscription.task.catch(() => {
		// The shared SSE consumer already handles transient reconnects. An
		// unexpected terminal failure must not take down the polling fallback.
	});
	return subscription;
}

function runtimeWatchEvent<T extends RuntimeWatchEventPayload>(
	payload: T,
): { schemaVersion: "clawdi.runtimeWatchEvent.v1" } & T {
	return { schemaVersion: "clawdi.runtimeWatchEvent.v1", ...payload };
}

type RuntimeWatchEvent = ReturnType<typeof runtimeWatchEvent>;

function runtimeWatchError<T extends object>(
	stage: Extract<RuntimeWatchEventPayload, { status: "error" }>["stage"],
	errors: string[],
	detail?: T,
): RuntimeWatchEvent {
	return runtimeWatchEvent({ ...detail, status: "error", stage, errors, error: errors[0] });
}

const NO_SYSTEMD_APPLY = {
	applied: false,
	systemUnitsChanged: [],
	userUnitsChanged: [],
} as const;

function emitRuntimeWatchEvent(event: RuntimeWatchEvent, json: boolean | undefined): void {
	if (json) {
		console.log(JSON.stringify(event));
		return;
	}
	if (event.status === "applied") {
		console.log(`runtime watch applied generation ${event.generation ?? "unknown"}`);
		return;
	}
	if (event.status === "cli_handoff") {
		console.log("runtime watch handed off to the managed CLI");
		return;
	}
	if (event.status === "error") {
		console.error(`runtime watch error: ${event.error ?? event.errors?.[0] ?? "unknown error"}`);
	}
}

function emitRuntimeInitStatus(input: {
	opts: RuntimeInitOptions;
	paths: RuntimePaths;
	status: Parameters<typeof buildRuntimeBootStatus>[0];
	persist?: boolean;
	jsonExtras?: Record<string, unknown>;
	render?: (status: RuntimeBootStatus) => void;
}): void {
	const status = buildRuntimeBootStatus(input.status, input.paths);
	if (input.persist !== false) writeRuntimeBootStatus(status, input.paths);
	if (input.opts.json || !process.stdout.isTTY) {
		console.log(
			JSON.stringify(input.jsonExtras ? { ...status, ...input.jsonExtras } : status, null, 2),
		);
	} else {
		input.render?.(status);
	}
	process.exitCode = status.exitCode;
}

function renderRuntimeInit(
	paths: RuntimePaths,
	message: string,
	color: (value: string) => string,
): () => void {
	return () => {
		console.log(chalk.bold("clawdi runtime init"));
		console.log(color(`  ${message}`));
		console.log(chalk.gray(`  status: ${paths.bootStatus}`));
	};
}

function emitRuntimeInitRepair(
	input: Pick<RuntimeBootStatus, "bootId" | "stage" | "runtimeMode" | "errors" | "exitCode"> & {
		opts: RuntimeInitOptions;
		paths: RuntimePaths;
		persist?: boolean;
		render?: (status: RuntimeBootStatus) => void;
		active?: ReturnType<typeof runtimeAppliedStatus>;
		rejectedGeneration?: number | null;
		manifestLoad?: RuntimeManifestLoad;
	},
): void {
	const { opts, paths, persist, render, active, rejectedGeneration, manifestLoad, ...repair } =
		input;
	emitRuntimeInitStatus({
		opts,
		paths,
		status: {
			...repair,
			mode: "repair",
			status: "error",
			activeGeneration: active?.activeGeneration ?? null,
			...(rejectedGeneration === undefined ? {} : { rejectedGeneration }),
			...(active ? { instanceId: active.instanceId } : {}),
			enabledRuntimes: [],
			error: repair.errors[0],
			datasource: "RuntimeSource",
			hostPolicy: hostPolicySummary(readHostPolicy(paths.hostPolicy)),
			...(manifestLoad
				? {
						manifestSource: {
							type: manifestLoad.source,
							path: manifestLoad.sourcePath,
							offline: manifestLoad.offline,
						},
					}
				: {}),
		},
		persist,
		render,
	});
}

function finishRuntimeInitCliHandoff(input: {
	opts: RuntimeInitOptions;
	paths: ReturnType<typeof getRuntimePaths>;
	mode: "hosted";
	bootId: string;
	hostPolicy: ReturnType<typeof readHostPolicy>;
	manifestLoad?: RuntimeManifestLoad;
	detail:
		| { cliUpdate: RuntimeCliUpdateResult }
		| { reconciliation: RuntimeCliReconciliationResult };
}): void {
	const applied = runtimeAppliedStatus(input.paths);
	emitRuntimeInitStatus({
		opts: input.opts,
		paths: input.paths,
		status: {
			mode: input.manifestLoad?.offline ? "degraded-offline" : "normal",
			status: "ok",
			stage: "config",
			bootId: input.bootId,
			runtimeMode: input.mode,
			activeGeneration: applied.activeGeneration,
			rejectedGeneration: null,
			instanceId: applied.instanceId,
			enabledRuntimes: [],
			errors: [],
			exitCode: RUNTIME_INIT_CLI_HANDOFF_EXIT_CODE,
			datasource: "RuntimeSource",
			hostPolicy: hostPolicySummary(input.hostPolicy),
			...(input.manifestLoad
				? {
						manifestSource: {
							type: input.manifestLoad.source,
							path: input.manifestLoad.sourcePath,
							offline: input.manifestLoad.offline,
						},
					}
				: {}),
		},
		jsonExtras: {
			handoff: "cli_reexec",
			...input.detail,
			selfReexec: true,
		},
		render: renderRuntimeInit(
			input.paths,
			"CLI activated; restarting under the managed binary",
			chalk.green,
		),
	});
}

export async function runtimeVerify(opts: RuntimeVerifyOptions = {}) {
	const paths = getRuntimePaths();
	const manifestCacheExists = existsSync(paths.manifestLastGood);
	const errors: string[] = [];
	if (manifestCacheExists) {
		try {
			const raw = JSON.parse(readFileSync(paths.manifestLastGood, "utf-8")) as unknown;
			const parsed = hostedRuntimeBundleV2Schema.safeParse(raw);
			if (!parsed.success) {
				errors.push(`cached manifest parse failed: ${z.prettifyError(parsed.error)}`);
			}
		} catch (error) {
			errors.push(`cached manifest parse failed: ${toErrorMessage(error)}`);
		}
	}
	const result = {
		schemaVersion: "clawdi.runtimeVerify.v1",
		status: errors.length === 0 ? "ok" : "error",
		cliVersion: ACTIVE_CLI_VERSION,
		manifestCache: {
			path: paths.manifestLastGood,
			exists: manifestCacheExists,
			valid: manifestCacheExists ? errors.length === 0 : null,
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
		emitRuntimeInitRepair({
			opts,
			paths,
			bootId,
			runtimeMode: mode,
			stage: "detect",
			exitCode: 2,
			errors: [
				"runtime init requires CLAWDI_RUNTIME_MODE=hosted explicitly; host policy files do not select runtime mode",
			],
			persist: false,
			render: () =>
				console.log(chalk.red("runtime init is only available in hosted runtime mode.")),
		});
		return;
	}
	let applyContext: RuntimeApplyContext;
	try {
		applyContext = opts.applyContext ?? readRuntimeApplyContext();
		assertHostedRuntimeContract(paths, applyContext, {
			...opts.hostedRuntimeContract,
			platformRoots: "deferred",
		});
	} catch (error) {
		const message = toErrorMessage(error);
		emitRuntimeInitRepair({
			opts,
			paths,
			bootId,
			runtimeMode: mode,
			stage: "detect",
			exitCode: 20,
			errors: [message],
			persist: false,
			render: () => console.log(chalk.red(message)),
		});
		return;
	}
	try {
		ensureRuntimeStateDirs(paths);
	} catch (error) {
		emitRuntimeInitRepair({
			opts,
			paths,
			bootId,
			runtimeMode: mode,
			stage: "detect",
			exitCode: 20,
			errors: [`could not create runtime state directories: ${toErrorMessage(error)}`],
			persist: false,
			render: (status) => console.log(chalk.red(status.error)),
		});
		return;
	}
	return withRuntimeConvergeLockAsync(paths, () =>
		runtimeInitLocked({ ...opts, applyContext }, paths, mode, bootId),
	);
}

async function runtimeInitLocked(
	opts: RuntimeInitOptions,
	paths: ReturnType<typeof getRuntimePaths>,
	mode: "hosted",
	bootId: string,
): Promise<void> {
	const hostPolicy = readHostPolicy(paths.hostPolicy);
	const repair = (stage: RuntimeBootStage, errors: string[], exitCode = 23, prefix = ""): void =>
		emitRuntimeInitRepair({
			opts,
			paths,
			bootId,
			runtimeMode: mode,
			stage,
			exitCode,
			errors,
			render: (status) =>
				console.log((exitCode === 20 ? chalk.yellow : chalk.red)(`${prefix}${status.error}`)),
		});
	if (opts.nonInteractive !== true) {
		repair("detect", ["runtime init requires --non-interactive in hosted mode"], 20, "  repair: ");
		return;
	}

	const outcome = await convergeOnce(
		async () => {
			const loaded = await loadRuntimeManifest(paths, { applyContext: opts.applyContext });
			return "errors" in loaded
				? { kind: "failed" as const, failure: loaded }
				: { kind: "ready" as const, load: loaded };
		},
		paths,
		{ hostedRuntimeContract: opts.hostedRuntimeContract },
	);

	if (outcome.kind === "reconciliation_error") {
		repair("local", [outcome.error]);
		return;
	}
	if (outcome.kind === "cli_handoff") {
		finishRuntimeInitCliHandoff({
			opts,
			paths,
			mode,
			bootId,
			hostPolicy,
			...(outcome.detail.kind === "update" ? { manifestLoad: outcome.detail.load } : {}),
			detail:
				outcome.detail.kind === "update"
					? { cliUpdate: outcome.detail.cliUpdate }
					: { reconciliation: outcome.detail.reconciliation },
		});
		return;
	}
	if (outcome.kind === "load_failed") {
		const { failure } = outcome;
		emitRuntimeInitStatus({
			opts,
			paths,
			status: {
				mode: failure.mode,
				status: "error",
				stage: failure.stage,
				bootId,
				runtimeMode: mode,
				activeGeneration: failure.activeGeneration ?? null,
				rejectedGeneration: failure.rejectedGeneration ?? null,
				enabledRuntimes: [],
				error: failure.errors[0],
				errors: failure.errors,
				exitCode: failure.mode === "manifest-rejected" ? 22 : 21,
				datasource: "RuntimeSource",
				hostPolicy: hostPolicySummary(hostPolicy),
			},
			render: renderRuntimeInit(paths, `${failure.mode}: ${failure.errors[0]}`, chalk.yellow),
		});
		return;
	}
	if (outcome.kind === "apply_error" || outcome.kind === "cli_update_failed") {
		const message =
			outcome.kind === "apply_error"
				? outcome.error
				: (outcome.cliUpdate.error ?? "CLI update failed");
		const load = outcome.load;
		const applied = runtimeAppliedStatus(paths);
		emitRuntimeInitRepair({
			opts,
			paths,
			stage: outcome.kind === "cli_update_failed" ? "config" : "final",
			bootId,
			runtimeMode: mode,
			errors: [message],
			exitCode: 23,
			active: applied,
			rejectedGeneration: load?.manifest.generation ?? null,
			...(outcome.kind === "apply_error" && load ? { manifestLoad: load } : {}),
			render: renderRuntimeInit(paths, `repair: ${message}`, chalk.red),
		});
		return;
	}
	if (outcome.kind === "converged") {
		const runtimeErrors = [...outcome.runtimeErrors, ...outcome.cliRollbackErrors];
		const runtimeReady = runtimeErrors.length === 0;
		const applied = runtimeAppliedStatus(paths);
		emitRuntimeInitStatus({
			opts,
			paths,
			status: {
				mode: outcome.convergence.mode,
				status: runtimeReady ? "ok" : "error",
				stage: "final",
				bootId,
				runtimeMode: mode,
				activeGeneration: applied.activeGeneration,
				rejectedGeneration: runtimeReady ? null : outcome.convergence.manifest.generation,
				instanceId: applied.instanceId,
				enabledRuntimes: outcome.convergence.enabledRuntimes,
				error: runtimeErrors[0],
				errors: runtimeErrors,
				...(outcome.resourceProjectionErrors.length > 0
					? { resourceProjectionErrors: outcome.resourceProjectionErrors }
					: {}),
				exitCode: runtimeReady ? 0 : 23,
				datasource: "RuntimeSource",
				hostPolicy: hostPolicySummary(hostPolicy),
				manifestSource: {
					type: outcome.convergence.source,
					path: outcome.convergence.sourcePath,
					offline: outcome.convergence.offline,
				},
				convergence: outcome.convergence.outputs,
			},
			render: renderRuntimeInit(
				paths,
				`${outcome.convergence.mode}: generation ${outcome.convergence.manifest.generation}`,
				chalk.green,
			),
		});
		return;
	}

	const message = "runtime init manifest loader returned no desired state";
	repair("local", [message]);
}

async function runtimeWatchTick(
	paths: ReturnType<typeof getRuntimePaths>,
	opts: RuntimeWatchTickOptions,
): Promise<RuntimeWatchEvent | null> {
	return withRuntimeConvergeLockAsync(paths, async () =>
		runtimeWatchEventForOutcome(
			await convergeOnce(() => loadRuntimeManifestForWatch(paths, opts), paths, {
				continueOnCliUpdateError: true,
				recoverFailedSystemdUnits: opts.recoverFailedSystemdUnits,
				hostedRuntimeContract: opts.hostedRuntimeContract,
				requireAppliedAuthority: true,
			}),
			paths,
		),
	);
}

async function convergeOnce(
	load: () => Promise<ConvergeLoadResult>,
	paths: RuntimePaths,
	policy: ConvergePolicy,
): Promise<ConvergeOutcome> {
	const { requireAppliedAuthority, ...apply } = policy;
	let reconciliation: RuntimeCliReconciliationResult;
	try {
		reconciliation = reconcilePendingRuntimeCliUpgrade(paths, ACTIVE_CLI_VERSION);
	} catch (error) {
		return { kind: "reconciliation_error", error: toErrorMessage(error) };
	}
	if (reconciliation.selfReexec) {
		return { kind: "cli_handoff", detail: { kind: "reconciliation", reconciliation } };
	}

	const requested = await load();
	if (requested.kind === "idle") return requested;
	if (requested.kind === "failed") return { kind: "load_failed", failure: requested.failure };
	if (requested.kind === "error") return { ...requested, kind: "apply_error" };
	if (requested.kind === "not_modified") {
		const completion = completePendingRuntimeCliUpgrade(paths, ACTIVE_CLI_VERSION);
		return { ...requested, selfReexec: completion.selfReexec };
	}

	let convergenceLoad = requested.load;
	let applyResult: RuntimeApplyResult;
	try {
		convergenceLoad = applyRuntimeBundleChannelsToManifestLoad(convergenceLoad, paths);
		if (requireAppliedAuthority && (!convergenceLoad.etag || !convergenceLoad.sourceRevision)) {
			throw new Error("runtime bundle is missing applied authority identity");
		}
		applyResult = await applyRuntimeManifestLoad(convergenceLoad, paths, apply);
	} catch (error) {
		return {
			kind: "apply_error",
			error: toErrorMessage(error),
			load: convergenceLoad,
			...(convergenceLoad.etag ? { etag: convergenceLoad.etag } : {}),
		};
	}
	if (applyResult.kind === "cli_handoff") {
		return {
			kind: "cli_handoff",
			detail: { kind: "update", load: convergenceLoad, cliUpdate: applyResult.cliUpdate },
		};
	}
	if (applyResult.kind === "cli_update_failed") {
		return { kind: "cli_update_failed", load: convergenceLoad, cliUpdate: applyResult.cliUpdate };
	}

	const cliUpdateError =
		applyResult.cliUpdate.status === "error"
			? (applyResult.cliUpdate.error ?? "CLI update failed")
			: null;
	const runtimeErrors = [
		...(cliUpdateError ? [cliUpdateError] : []),
		...applyResult.convergence.installErrors,
	];
	const resourceProjectionErrors = [...applyResult.convergence.resourceProjectionErrors];
	let selfReexec = applyResult.cliUpdate.selfReexec;
	let cliRollback: RuntimeCliRollbackResult | null = null;
	let cliRollbackErrors: string[] = [];
	if (runtimeErrors.length > 0) {
		const rollbackErrors = [...runtimeErrors, ...resourceProjectionErrors];
		const errorCount = rollbackErrors.length;
		cliRollback = maybeRollbackFailedCliUpgrade(paths, rollbackErrors);
		cliRollbackErrors = rollbackErrors.slice(errorCount);
		if (cliRollback.status === "rolled_back") selfReexec = true;
	} else {
		const completion = completePendingRuntimeCliUpgrade(paths, ACTIVE_CLI_VERSION);
		selfReexec = selfReexec || completion.selfReexec;
	}
	return {
		kind: "converged",
		load: convergenceLoad,
		convergence: applyResult.convergence,
		cliUpdate: applyResult.cliUpdate,
		systemdApply: applyResult.systemdApply,
		runtimeErrors,
		resourceProjectionErrors,
		cliRollback,
		cliRollbackErrors,
		selfReexec,
	};
}

async function loadRuntimeManifestForWatch(
	paths: RuntimePaths,
	opts: RuntimeWatchTickOptions,
): Promise<ConvergeLoadResult> {
	if (opts.failureBackoff?.etag === null && opts.now < opts.failureBackoff.nextRetryAt) {
		return { kind: "idle" };
	}
	const active = readRuntimeAppliedState(paths);
	const retryDeferred =
		opts.failureBackoff !== undefined && opts.now < opts.failureBackoff.nextRetryAt;
	const manifestEtag =
		retryDeferred && opts.failureBackoff?.etag
			? opts.failureBackoff.etag
			: opts.forceRefresh
				? undefined
				: (active?.etag ?? undefined);
	const conditional = await loadRemoteRuntimeManifest(paths, {
		ifNoneMatch: manifestEtag,
		applyContext: opts.applyContext,
	});
	if ("errors" in conditional) {
		return retryDeferred &&
			opts.failureBackoff &&
			(!conditional.etag || conditional.etag === opts.failureBackoff.etag)
			? { kind: "idle" }
			: { kind: "failed", failure: conditional };
	}
	const responseEtag = conditional.etag ?? manifestEtag ?? null;
	if (retryDeferred && opts.failureBackoff?.etag === responseEtag) return { kind: "idle" };
	if (
		"notModified" in conditional &&
		active !== null &&
		active.etag === responseEtag &&
		runtimeApplyIdentitiesEqual(
			conditional.applyContext?.identity ?? null,
			runtimeAppliedApplyIdentity(active),
		)
	) {
		return {
			kind: "not_modified",
			sourcePath: conditional.sourcePath,
			etag: responseEtag,
			applied: active,
		};
	}

	try {
		const fresh =
			"notModified" in conditional
				? await loadRemoteRuntimeManifest(paths, { applyContext: opts.applyContext })
				: conditional;
		if ("notModified" in fresh) {
			throw new Error("runtime manifest datasource returned 304 without If-None-Match");
		}
		if ("errors" in fresh) return { kind: "failed", failure: fresh };
		if (retryDeferred && opts.failureBackoff?.etag === fresh.etag) return { kind: "idle" };
		return { kind: "ready", load: fresh };
	} catch (error) {
		return {
			kind: "error",
			error: toErrorMessage(error),
			...(responseEtag ? { etag: responseEtag } : {}),
		};
	}
}

function runtimeWatchEventForOutcome(
	outcome: ConvergeOutcome,
	paths: RuntimePaths,
): RuntimeWatchEvent | null {
	if (outcome.kind === "idle") return null;
	if (outcome.kind === "reconciliation_error") {
		return runtimeWatchError("cli-update", [outcome.error], { selfReexec: false });
	}
	if (outcome.kind === "cli_handoff") {
		if (outcome.detail.kind === "reconciliation") {
			return runtimeWatchEvent({
				status: "cli_handoff",
				stage: "cli-update",
				handoff: "cli_reexec",
				reconciliation: outcome.detail.reconciliation,
				selfReexec: true,
			});
		}
		const applied = runtimeAppliedStatus(paths);
		return runtimeWatchEvent({
			status: "cli_handoff",
			stage: "cli-update",
			handoff: "cli_reexec",
			activeGeneration: applied.activeGeneration,
			desiredGeneration: outcome.detail.load.manifest.generation,
			instanceId: applied.instanceId,
			cliUpdate: outcome.detail.cliUpdate,
			selfReexec: true,
			systemdUnitsChanged: false,
			systemdApply: NO_SYSTEMD_APPLY,
		});
	}
	if (outcome.kind === "load_failed") {
		return runtimeWatchError(outcome.failure.stage, outcome.failure.errors, {
			mode: outcome.failure.mode,
			activeGeneration: outcome.failure.activeGeneration ?? null,
			rejectedGeneration: outcome.failure.rejectedGeneration ?? null,
			...(outcome.failure.etag ? { etag: outcome.failure.etag } : {}),
		});
	}
	if (outcome.kind === "not_modified") {
		return runtimeWatchEvent({
			status: "not_modified",
			sourcePath: outcome.sourcePath,
			etag: outcome.etag,
			sourceRevision: outcome.applied.sourceRevision,
			generation: outcome.applied.generation,
			instanceId: outcome.applied.instanceId,
			selfReexec: outcome.selfReexec,
		});
	}
	if (outcome.kind === "apply_error") {
		return runtimeWatchError("final", [outcome.error], {
			...(outcome.etag ? { etag: outcome.etag } : {}),
		});
	}
	if (outcome.kind === "cli_update_failed") {
		const error = outcome.cliUpdate.error ?? "CLI update failed";
		const applied = runtimeAppliedStatus(paths);
		return runtimeWatchError("cli-update", [error], {
			activeGeneration: applied.activeGeneration,
			rejectedGeneration: outcome.load.manifest.generation,
			instanceId: applied.instanceId,
			etag: outcome.load.etag,
			cliUpdate: outcome.cliUpdate,
			selfReexec: outcome.cliUpdate.selfReexec,
			systemdUnitsChanged: false,
			systemdApply: NO_SYSTEMD_APPLY,
		});
	}

	const resourceProjectionOnly =
		outcome.runtimeErrors.length === 0 && outcome.resourceProjectionErrors.length > 0;
	const errors = [
		...outcome.runtimeErrors,
		...outcome.resourceProjectionErrors,
		...outcome.cliRollbackErrors,
	];
	const systemdUnitsChanged =
		outcome.systemdApply.systemUnitsChanged.length > 0 ||
		outcome.systemdApply.userUnitsChanged.length > 0;
	if (errors.length > 0) {
		const agentPlugins = outcome.load.sourceRevision
			? failedHostedAgentPluginsObservation(
					outcome.load.manifest,
					outcome.load.sourceRevision,
					outcome.convergence.agentPluginFailedNames,
				)
			: null;
		const applied = runtimeAppliedStatus(paths);
		return runtimeWatchError(
			outcome.cliUpdate.status === "error" ? "cli-update" : "final",
			errors,
			{
				activeGeneration: applied.activeGeneration,
				rejectedGeneration: resourceProjectionOnly ? null : outcome.convergence.manifest.generation,
				instanceId: applied.instanceId,
				etag: outcome.load.etag,
				cliUpdate: outcome.cliUpdate,
				...(outcome.cliRollback ? { cliRollback: outcome.cliRollback } : {}),
				selfReexec: outcome.selfReexec,
				systemdUnitsChanged,
				systemdApply: outcome.systemdApply,
				convergence: outcome.convergence.outputs,
				...(resourceProjectionOnly ? { healthImpact: "resource_projection" } : {}),
				...(agentPlugins ? { agentPlugins } : {}),
			},
		);
	}
	return runtimeWatchEvent({
		status: "applied",
		sourcePath: outcome.load.sourcePath,
		etag: outcome.load.etag,
		sourceRevision: outcome.load.sourceRevision,
		generation: outcome.convergence.manifest.generation,
		instanceId: outcome.convergence.manifest.instanceId,
		enabledRuntimes: outcome.convergence.enabledRuntimes,
		cliUpdate: outcome.cliUpdate,
		selfReexec: outcome.selfReexec,
		systemdUnitsChanged,
		systemdApply: outcome.systemdApply,
		convergence: outcome.convergence.outputs,
	});
}

function runtimeWatchFailureBackoff(
	previous: RuntimeWatchFailureBackoff | null,
	event: RuntimeWatchEvent,
	now: number,
): RuntimeWatchFailureBackoff {
	const etag = event.etag ?? null;
	const backoffMs = nextBoundedBackoffMs(previous?.etag === etag ? previous.backoffMs : 0);
	return {
		backoffMs,
		etag,
		nextRetryAt: now + backoffMs,
	};
}

export async function applyRuntimeManifestLoad(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	opts: RuntimeManifestApplyOptions = {},
): Promise<RuntimeApplyResult> {
	const contentRevision = runtimePublicContentRevision(load);
	const applyIdentity = load.applyContext?.identity ?? null;
	return applyRuntimeDesiredState(load, paths, {
		...opts,
		authorityCommit: (convergence, authority) =>
			commitRuntimeAppliedState({
				load,
				paths,
				etag: load.etag ?? `"sha256:${contentRevision}"`,
				sourceRevision: load.sourceRevision ?? contentRevision,
				convergence,
				applyIdentity,
				daemonAuthTokenRevision: authority.daemonAuthTokenRevision,
				daemonProgramRevision: authority.daemonProgramRevision,
				egressSidecarSecretRevision: authority.egressSidecarSecretRevision,
				userProcessRevisionAliases: authority.userProcessRevisionAliases,
				officialServiceCommandRevisions: authority.officialServiceCommandRevisions,
			}),
		requireSystemdApplied: applyIdentity !== null,
	});
}

async function applyRuntimeDesiredState(
	load: RuntimeManifestLoad,
	paths: ReturnType<typeof getRuntimePaths>,
	opts: RuntimeApplyOptions = {},
): Promise<RuntimeApplyResult> {
	let preparedHostedAgentPlugins = opts.preparedHostedAgentPlugins;
	const resourcePreparationFailures: RuntimeResourcePreparationFailures = {};
	let preservePreparedAgentPluginArchives = false;
	try {
		let cliUpdate: RuntimeCliUpdateResult;
		try {
			cliUpdate = applyRuntimeCliDesiredState(load.manifest, paths, {
				runningVersion: ACTIVE_CLI_VERSION,
			});
		} catch (error) {
			if (!opts.continueOnCliUpdateError) throw error;
			return {
				kind: "cli_update_failed",
				cliUpdate: runtimeCliUpdateError(load.manifest, paths, error),
			};
		}
		if (cliUpdate.status === "error") {
			if (!opts.continueOnCliUpdateError) {
				throw new Error(cliUpdate.error ?? "CLI update failed");
			}
			return { kind: "cli_update_failed", cliUpdate };
		}
		if (cliUpdate.selfReexec) {
			return { kind: "cli_handoff", cliUpdate };
		}
		const preserveActiveUnits = isRuntimeCliOnlyCheckpoint(load, paths);
		if (preparedHostedAgentPlugins === undefined) {
			try {
				preparedHostedAgentPlugins = await prepareHostedAgentPluginPackages(load.manifest, paths, {
					offline: load.offline,
				});
			} catch (error) {
				resourcePreparationFailures.agentPlugins = {
					error: `runtime Agent Plugin package preparation failed: ${toErrorMessage(error)}`,
					installationNames: Object.keys(
						load.manifest.projection?.agentPlugins?.installations ?? {},
					).sort(),
				};
			}
		}
		let preparedHostedSourcedSkills = opts.preparedHostedSourcedSkills;
		if (preparedHostedSourcedSkills === undefined) {
			try {
				preparedHostedSourcedSkills = await prepareHostedSkillArchives(load.manifest, paths, {
					authToken: load.applyContext?.manifestSource.auth.token,
				});
			} catch (error) {
				resourcePreparationFailures.sourcedSkills = `runtime sourced Skill archive preparation failed: ${toErrorMessage(error)}`;
			}
		}
		const previousSystemdUnits = readSystemdUnitSnapshot(paths);
		const previousUserDesiredRevisions = preserveActiveUnits
			? readSystemdUserDesiredRevisions(paths, previousSystemdUnits.user.keys())
			: new Map<string, string>();
		const systemdTransaction = new SystemdRuntimeTransaction();
		let userProcessRevisionAliases: RuntimeUserProcessRevisionAliases = {};
		let systemdApply = {
			applied: false,
			systemUnitsChanged: [] as string[],
			userUnitsChanged: [] as string[],
		};
		let egressPrerequisiteApply: typeof systemdApply | null = null;
		let egressPrerequisiteActivated = false;
		const convergence = convergeRuntimeManifest(load, paths, {
			cacheLastGood: false,
			hostedRuntimeContract: opts.hostedRuntimeContract,
			preparedHostedSourcedSkills,
			...(preparedHostedAgentPlugins ? { preparedHostedAgentPlugins } : {}),
			...(Object.keys(resourcePreparationFailures).length > 0
				? { resourcePreparationFailures }
				: {}),
			...(opts.hostedAgentPluginCommandRunner
				? { hostedAgentPluginCommandRunner: opts.hostedAgentPluginCommandRunner }
				: {}),
			commitAuthority: (committedConvergence, authority) => {
				if (opts.requireSystemdApplied && !systemdApply.applied) {
					throw new Error("systemd apply did not activate the rendered runtime manifest");
				}
				opts.authorityCommit?.(committedConvergence, {
					...authority,
					...(Object.keys(userProcessRevisionAliases).length > 0
						? { userProcessRevisionAliases }
						: {}),
				});
			},
			systemdApply: {
				transactionState: () => systemdTransaction.state,
				installOfficialService: (unit, install) =>
					systemdTransaction.installOfficialService(paths, unit, install),
				activateEgressPrerequisite: ({ restartEgressSidecar }) => {
					const candidateSystemdUnits = readSystemdUnitSnapshot(paths);
					try {
						const prerequisite = applySystemdRuntimeUpdate(
							paths,
							previousSystemdUnits,
							candidateSystemdUnits,
							{
								transaction: systemdTransaction,
								stage: "egress-prerequisite",
								activationScope: {
									systemUnits: [RUNTIME_SIDECAR_SYSTEM_UNIT],
									userUnits: [],
								},
								forceRestartSystemUnits: restartEgressSidecar ? [RUNTIME_SIDECAR_SYSTEM_UNIT] : [],
								preserveActiveUnits,
								recoverFailedUnits: opts.recoverFailedSystemdUnits,
							},
						);
						if (prerequisite.applied) {
							assertRuntimeUserCanRead(paths.egressSystemCaFile, paths.userHome);
							egressPrerequisiteActivated = true;
						}
						egressPrerequisiteApply = prerequisite;
						return prerequisite;
					} catch (error) {
						throw new Error(
							`transparent-egress prerequisite activation failed: ${toErrorMessage(error)}`,
						);
					}
				},
				activate: ({
					restartDaemon,
					restartEgressSidecar,
					restartUserUnits,
					staleSystemUnits,
					staleUserUnits,
				}) => {
					// Official installers run after the prerequisite phase and add their
					// base units, so final reconciliation must observe a fresh rendered state.
					const candidateSystemdUnits = readSystemdUnitSnapshot(paths);
					try {
						const activationTarget = withoutStaleSystemdUnits(
							candidateSystemdUnits,
							staleSystemUnits,
							staleUserUnits,
						);
						const activation = applySystemdRuntimeUpdate(
							paths,
							previousSystemdUnits,
							activationTarget,
							{
								transaction: systemdTransaction,
								stage: "final-activation",
								forceRestartSystemUnits: [
									...(restartDaemon ? [RUNTIME_DAEMON_SYSTEM_UNIT] : []),
									...(restartEgressSidecar ? [RUNTIME_SIDECAR_SYSTEM_UNIT] : []),
								],
								forceRestartUserUnits: restartUserUnits,
								preserveActiveUnits,
								previousUserDesiredRevisions,
								onUserProcessRevisionAliases: (aliases) => {
									userProcessRevisionAliases = aliases;
								},
								recoverFailedUnits: opts.recoverFailedSystemdUnits,
								skipActivatedSystemUnits: egressPrerequisiteActivated
									? [RUNTIME_SIDECAR_SYSTEM_UNIT]
									: [],
							},
						);
						systemdApply = {
							applied: activation.applied && (egressPrerequisiteApply?.applied ?? true),
							systemUnitsChanged: [
								...new Set([
									...(egressPrerequisiteApply?.systemUnitsChanged ?? []),
									...activation.systemUnitsChanged,
								]),
							].sort(),
							userUnitsChanged: [
								...new Set([
									...(egressPrerequisiteApply?.userUnitsChanged ?? []),
									...activation.userUnitsChanged,
								]),
							].sort(),
						};
						return systemdApply;
					} catch (error) {
						const mutationJournal = systemdTransaction.journal
							.map(
								(entry) =>
									`${entry.sequence}:${entry.stage}/${entry.scope}/${entry.action}(${entry.units.join(",") || "manager"})=${entry.outcome}`,
							)
							.join(", ");
						throw new Error(
							`systemd apply failed: ${toErrorMessage(error)}${
								mutationJournal ? `; mutation journal: ${mutationJournal}` : ""
							}`,
						);
					}
				},
				quiesce: (affectedUserUnits) => systemdTransaction.quiesce(paths, affectedUserUnits),
				rollback: () => systemdTransaction.rollback(paths),
			},
		});
		if (convergence.installErrors.length === 0) {
			preservePreparedAgentPluginArchives = true;
			try {
				gcHostedSkillArchives(load.manifest, paths);
			} catch (error) {
				console.warn(`post-commit Skill archive cleanup deferred: ${toErrorMessage(error)}`);
			}
			try {
				gcHostedAgentPluginArchives(
					readHostedAgentPluginReceipt(paths),
					paths,
					[...(preparedHostedAgentPlugins?.desired.values() ?? [])].map(
						(plugin) => plugin.installation.ownershipIdentity,
					),
				);
			} catch (error) {
				console.warn(`post-commit Agent Plugin archive cleanup deferred: ${toErrorMessage(error)}`);
			}
		}
		return { kind: "converged", cliUpdate, convergence, systemdApply };
	} finally {
		if (!preservePreparedAgentPluginArchives) {
			cleanupHostedAgentPluginTransientArchives(preparedHostedAgentPlugins ?? null, paths);
		}
	}
}

function runtimeCliUpdateError(
	manifest: RuntimeManifestLoad["manifest"],
	paths: ReturnType<typeof getRuntimePaths>,
	error: unknown,
): RuntimeCliUpdateResult {
	const rawRegistry = manifest.clawdiCli?.registry;
	return {
		status: "error",
		packageSpec: manifest.clawdiCli?.packageSpec?.trim() || null,
		registry: typeof rawRegistry === "string" && rawRegistry.trim() ? rawRegistry.trim() : null,
		npmPrefix: paths.cliNpmPrefix,
		npmCache: paths.cliNpmCache,
		activePath: paths.cliManagedBin,
		activeTarget: null,
		version: null,
		retryAt: null,
		selfReexec: false,
		error: toErrorMessage(error),
	};
}

function maybeRollbackFailedCliUpgrade(
	paths: RuntimePaths,
	errors: string[],
): RuntimeCliRollbackResult {
	const rollback = rollbackPendingRuntimeCliUpgrade(
		paths,
		`first converge after CLI upgrade failed: ${errors[0] ?? "unknown error"}`,
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

export async function runtimeWatch(opts: RuntimeWatchOptions = {}) {
	const paths = getRuntimePaths();
	const mode = detectRuntimeMode();
	const intervalMs = parsePositiveMs(opts.intervalMs, RUNTIME_WATCH_INTERVAL_MS, "--interval-ms");
	const selfHealMs = parsePositiveMs(opts.selfHealMs, RUNTIME_WATCH_SELF_HEAL_MS, "--self-heal-ms");
	let nextCliInstallRetryAt = 0;
	let failureBackoff: RuntimeWatchFailureBackoff | null = null;
	const wakeSignal = createRuntimeWatchWakeSignal();
	let notificationSubscription: RuntimeWatchNotificationSubscription | null = null;

	if (mode !== "hosted") {
		const event = runtimeWatchError("detect", ["runtime watch requires hosted runtime mode"]);
		emitRuntimeWatchEvent(event, opts.json);
		process.exitCode = 2;
		return;
	}
	let applyContext: RuntimeApplyContext;
	try {
		applyContext = opts.applyContext ?? readRuntimeApplyContext();
		assertHostedRuntimeContract(paths, applyContext, {
			...opts.hostedRuntimeContract,
			platformRoots: "deferred",
		});
	} catch (error) {
		const message = toErrorMessage(error);
		const event = runtimeWatchError("detect", [message]);
		emitRuntimeWatchEvent(event, opts.json);
		process.exitCode = 20;
		return;
	}

	try {
		ensureRuntimeStateDirs(paths);
	} catch (error) {
		const message = `could not create runtime state directories: ${toErrorMessage(error)}`;
		const event = runtimeWatchError("detect", [message]);
		emitRuntimeWatchEvent(event, opts.json);
		process.exitCode = 20;
		return;
	}

	try {
		notificationSubscription = ensureRuntimeWatchNotificationSubscription(
			notificationSubscription,
			paths,
			wakeSignal,
			opts,
		);
		// Startup work must not consume the self-heal interval. The first watch
		// tick should remain conditional, with full refresh timing measured from
		// the point at which the polling loop is ready.
		let lastFullFetchAt = Date.now();
		for (;;) {
			if (opts.abort?.aborted) return;
			const tickNow = Date.now();
			const cliInstallRetryDue = nextCliInstallRetryAt > 0 && tickNow >= nextCliInstallRetryAt;
			const failureRetryDue = failureBackoff !== null && tickNow >= failureBackoff.nextRetryAt;
			// Full refreshes also re-resolve floating CLI channels when manifest ETags are unchanged.
			const forceRefresh =
				tickNow - lastFullFetchAt >= selfHealMs || cliInstallRetryDue || failureRetryDue;
			const fullFetchAttempted =
				forceRefresh && (!failureBackoff || tickNow >= failureBackoff.nextRetryAt);
			let event: RuntimeWatchEvent | null;
			try {
				event = await runtimeWatchTick(paths, {
					forceRefresh,
					applyContext,
					hostedRuntimeContract: opts.hostedRuntimeContract,
					failureBackoff: failureBackoff ?? undefined,
					now: tickNow,
					// Conditional retries run every 15 seconds. Recover failed units
					// only on the five-minute full refresh, or once in one-shot mode.
					recoverFailedSystemdUnits: forceRefresh || opts.once === true,
				});
			} catch (error) {
				const message = toErrorMessage(error);
				event = runtimeWatchError("watch", [message]);
			}
			if (event !== null) {
				const cliUpdateStatus = event.cliUpdate?.status;
				const retryAt = event.cliUpdate?.retryAt;
				const parsedRetryAt = retryAt === null || retryAt === undefined ? NaN : Date.parse(retryAt);
				const cliRetryAt = Number.isFinite(parsedRetryAt) ? parsedRetryAt : null;
				if (cliRetryAt !== null) {
					nextCliInstallRetryAt = cliRetryAt;
				} else if (
					cliUpdateStatus === "installed" ||
					cliUpdateStatus === "current" ||
					cliUpdateStatus === "not_requested"
				) {
					nextCliInstallRetryAt = 0;
				}
				if (event.status === "error" && event.stage !== "cli-update") {
					failureBackoff = runtimeWatchFailureBackoff(failureBackoff, event, Date.now());
				} else if (event.status !== "error" || event.stage === "cli-update") {
					failureBackoff = null;
				}
				if (event.status === "applied" || fullFetchAttempted) lastFullFetchAt = Date.now();
				writeRuntimeWatchStatus(event, paths);
				emitRuntimeWatchEvent(event, opts.json);
			}
			notificationSubscription = ensureRuntimeWatchNotificationSubscription(
				notificationSubscription,
				paths,
				wakeSignal,
				opts,
			);
			if (event !== null && opts.once) {
				if (event.status === "error") process.exitCode = 1;
				else process.exitCode = 0;
				return;
			}
			if (event?.selfReexec === true || opts.abort?.aborted) {
				return;
			}
			if ((await wakeSignal.wait(intervalMs, opts.abort)) === "aborted") return;
		}
	} finally {
		notificationSubscription?.abort.abort();
		await notificationSubscription?.task.catch(() => {});
	}
}

function nextBoundedBackoffMs(previousMs: number): number {
	if (previousMs <= 0) return RUNTIME_WATCH_INITIAL_BACKOFF_MS;
	return Math.min(previousMs * 2, RUNTIME_WATCH_MAX_BACKOFF_MS);
}

export async function runtimeSidecar(): Promise<void> {
	if (detectRuntimeMode() !== "hosted") {
		throw new Error("runtime sidecar is only available in hosted runtime mode");
	}
	const shouldStartEgress = Boolean(process.env.CLAWDI_EGRESS_ENV_FILE?.trim());
	if (!shouldStartEgress) {
		throw new Error("runtime sidecar requires egress configuration.");
	}

	let egress: RuntimeEgressModule | null = null;
	try {
		if (shouldStartEgress) {
			egress = await startRuntimeEgress();
			console.error(`runtime sidecar egress module listening on 127.0.0.1:${egress.port}`);
		}
		notifySystemdReady("runtime sidecar ready");
	} catch (error) {
		egress?.close();
		throw error;
	}

	const shutdown = waitForShutdownSignal().then(() => ({ kind: "shutdown" as const }));
	const egressExit = egress?.wait().then(() => ({ kind: "egress-exit" as const }));
	try {
		await (egressExit ? Promise.race([shutdown, egressExit]) : shutdown);
	} finally {
		egress?.close();
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
			console.error(`transparent egress nft cleanup failed: ${toErrorMessage(error)}`);
		}
		redirectApplied = false;
	};
	const close = () => {
		closeRequested = true;
		cleanup();
		if (!mitmdump.killed) mitmdump.kill("SIGTERM");
	};
	try {
		await waitForTcpPort("127.0.0.1", config.transparentPort, EGRESS_LISTEN_TIMEOUT_MS, () =>
			childHasExited(mitmdump),
		);
		await waitForFile(config.caCertPath, EGRESS_CA_TIMEOUT_MS, () => childHasExited(mitmdump));
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
	const child = runningAsRoot()
		? spawnWithNumericIdentity(config.egressUid, config.egressGid, command, args, childEnv)
		: spawnWithCurrentEgressIdentity(config.egressUid, config.egressGid, command, args, childEnv);
	child.stdout?.pipe(process.stdout);
	child.stderr?.pipe(process.stderr);
	return child;
}

export function assertCurrentEgressIdentity(
	currentUid: number | undefined,
	currentGid: number | undefined,
	configuredUid: number,
	configuredGid: number,
): void {
	if (currentUid === undefined || currentGid === undefined) {
		throw new Error("cannot verify non-root egress engine UID/GID on this platform");
	}
	if (currentUid === 0 || currentGid === 0) {
		throw new Error("egress engine identity must be non-root");
	}
	if (currentUid !== configuredUid || currentGid !== configuredGid) {
		throw new Error(
			`current egress engine identity ${currentUid}:${currentGid} does not match configured ${configuredUid}:${configuredGid}`,
		);
	}
}

function spawnWithCurrentEgressIdentity(
	uid: number,
	gid: number,
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): ChildProcess {
	assertCurrentEgressIdentity(process.getuid?.(), process.getgid?.(), uid, gid);
	return spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
}

function spawnWithNumericIdentity(
	uid: number,
	gid: number,
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): ChildProcess {
	const child = buildNumericUserCommand(uid, gid, command, args);
	return spawn(child.command, child.args, {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
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
			setTimeout(attempt, EGRESS_READY_POLL_MS);
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
			setTimeout(attempt, EGRESS_READY_POLL_MS);
		};
		attempt();
	});
}

export function publishEgressSystemCaBundle(config: TransparentEgressEnvConfig): void {
	if (config.systemCaBundle === SYSTEM_CA_BUNDLE) {
		throw new Error("CLAWDI_EGRESS_SYSTEM_CA_BUNDLE must be a runtime-managed CA projection path");
	}
	const systemCa = readFileSync(SYSTEM_CA_BUNDLE, "utf-8");
	const egressCa = readFileSync(config.caCertPath, "utf-8");
	writePrivateFileAtomic(config.systemCaBundle, `${systemCa.trimEnd()}\n${egressCa.trimEnd()}\n`, {
		mode: 0o640,
		dirMode: 0o711,
	});
	if (runningAsRoot()) chownSync(config.systemCaBundle, 0, config.runtimeGid);
	chmodSync(config.systemCaBundle, 0o640);
}

function waitForShutdownSignal(): Promise<void> {
	const processEvents: EventEmitter = process;
	return new Promise((resolve) => {
		const done = () => {
			processEvents.removeListener("SIGTERM", done);
			processEvents.removeListener("SIGINT", done);
			resolve();
		};
		processEvents.once("SIGTERM", done);
		processEvents.once("SIGINT", done);
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
		},
		...read,
	};
	if (read.error || read.status?.status === "error") process.exitCode = 1;

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
	const identity = inspectHostedRuntimeIdentity(paths);
	let runtimeContextDetail: string;
	let runtimeContextOk = false;
	try {
		const context = readRuntimeApplyContext();
		runtimeContextOk = context.backend === "incus";
		runtimeContextDetail = context.backend;
	} catch (error) {
		runtimeContextDetail = toErrorMessage(error);
	}
	let platformRootsOk = true;
	let platformRootsDetail = "trusted";
	try {
		assertRuntimePlatformRoots(paths);
	} catch (error) {
		platformRootsOk = false;
		platformRootsDetail = toErrorMessage(error);
	}
	const checks: RuntimeDoctorCheck[] = [
		{
			name: "Runtime mode",
			ok: identity.mode.ok,
			detail: identity.mode.error ?? identity.mode.detail,
			hint: "Set CLAWDI_RUNTIME_MODE=hosted explicitly; host policy files do not select runtime mode.",
		},
		{
			name: "Hosted policy",
			ok: policy.exists && policy.valid,
			detail: policy.valid ? policy.source : (policy.error ?? "missing"),
			hint: "Hosted mode uses the built-in policy; policy files are ignored.",
		},
		{
			name: "Runtime identity",
			ok: identity.user.ok,
			detail: identity.user.error ?? identity.user.detail,
			hint: "The hosted tenant must run as clawdi with the expected non-root UID and GID.",
		},
		{
			name: "Runtime context backend",
			ok: runtimeContextOk,
			detail: runtimeContextDetail,
			hint: "Hosted v2 requires a valid runtime context attested with backend=incus.",
		},
		{
			name: "Platform roots",
			ok: platformRootsOk,
			detail: platformRootsDetail,
			hint: "Platform roots must remain real directories owned by the system boundary.",
		},
		{
			name: "Service state",
			ok: existsSync(paths.serviceStateRoot) && writable(paths.serviceStateRoot),
			detail: paths.serviceStateRoot,
			hint: "The hosted service-state directory must be writable by the platform service.",
		},
		{
			name: "Runtime HOME",
			ok: identity.home.ok && existsSync(paths.userHome) && writable(paths.userHome),
			detail: identity.home.error ?? paths.userHome,
			hint: "Hosted HOME must resolve to /home/clawdi and be a writable persistent volume.",
		},
		{
			name: "Ephemeral runtime state",
			ok: existsSync(paths.runRoot),
			detail: paths.runRoot,
			hint: "The runtime tmpfs path should be recreated on each boot and owned by the system boundary.",
		},
		{
			name: "Runtime auth token",
			ok: !existsSync(paths.daemonAuthToken) || readable(paths.daemonAuthToken),
			detail: existsSync(paths.daemonAuthToken) ? "present" : "absent",
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
