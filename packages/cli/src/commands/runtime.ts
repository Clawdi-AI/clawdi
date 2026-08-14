import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	accessSync,
	chmodSync,
	chownSync,
	constants,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { z } from "zod";
import { parseDotenv } from "../lib/dotenv";
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
import { withEffectiveFilesystemIdentity } from "../runtime/effective-identity";
import { buildEgressEngineEnv, SYSTEM_CA_BUNDLE } from "../runtime/egress-env";
import { readHostPolicy } from "../runtime/host-policy";
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
	type PreparedHostedSourcedSkill,
	prepareHostedSourcedSkillArchives,
} from "../runtime/hosted-sourced-skill-archive";
import {
	cacheRuntimeLastGoodManifest,
	convergeRuntimeManifest,
	loadRuntimeManifest,
	type RuntimePrivateAppliedAuthority,
	runtimeRecoverableSecretValues,
} from "../runtime/manifest";
import { manifestSchema as runtimeDesiredStateSchema } from "../runtime/manifest-contract";
import {
	loadCommittedRuntimeManifest,
	loadRemoteRuntimeManifest,
	type RuntimeManifestFailure,
	type RuntimeManifestLoad,
} from "../runtime/manifest-source";
import { detectRuntimeMode, getRuntimePaths, type RuntimePaths } from "../runtime/paths";
import { systemdEnvironmentFilePath } from "../runtime/runtime-systemd-reconciliation";
import {
	buildNumericUserCommand,
	buildRuntimeUserCommand,
	runtimeUserUid,
} from "../runtime/runtime-user-command";
import {
	assertRuntimePlatformRoots,
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
	runtimeUserSystemdEnvironment,
} from "../runtime/systemd-user";
import {
	applyTransparentEgressNftRulesFromEnv,
	cleanupTransparentEgressNftRulesFromEnv,
	loadTransparentEgressEnvConfig,
	type TransparentEgressEnvConfig,
} from "../runtime/transparent-egress";
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
	deferCliInstall?: boolean;
	deferCliInstallReason?: string;
	manifestIdentity?: RuntimeManifestIdentity;
	recoverFailedSystemdUnits?: boolean;
	requireSystemdApplied?: boolean;
	preparedHostedSourcedSkills?: ReadonlyMap<string, PreparedHostedSourcedSkill>;
	preparedHostedAgentPlugins?: PreparedHostedAgentPlugins | null;
	hostedAgentPluginCommandRunner?: HostedAgentPluginCommandRunner;
	hostedRuntimeContract?: HostedRuntimeContractOptions;
}

interface RuntimeManifestIdentity {
	generation?: number | null;
	etag?: string | null;
	previouslyApplied?: boolean;
}

interface RuntimeWatchFailureBackoff {
	backoffMs: number;
	etag: string | null;
	nextRetryAt: number;
}

interface RuntimeWatchTickOptions {
	forceRefresh: boolean;
	deferCliInstall?: boolean;
	deferCliInstallReason?: string;
	recoverFailedSystemdUnits?: boolean;
	failureBackoff?: RuntimeWatchFailureBackoff;
	now: number;
	applyContext?: RuntimeApplyContext;
	hostedRuntimeContract?: HostedRuntimeContractOptions;
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

function cacheRuntimeSourceManifest(load: RuntimeManifestLoad, paths: RuntimePaths): string | null {
	return cacheRuntimeLastGoodManifest(load.manifest, paths, load.secretValues);
}

export function runtimeAppliedContentIdentity(
	load: RuntimeManifestLoad,
): RuntimeAppliedContentIdentity {
	return {
		sourcePath: load.sourcePath,
		sha256: runtimeContentSha256({
			manifest: load.manifest,
			secretValues: runtimeRecoverableSecretValues(load.manifest, load.secretValues),
		}),
	};
}

// This revision may be surfaced through status/observation fallback fields.
// Keep secret-dependent recoverability verification in the root-only applied state.
export function runtimePublicContentRevision(load: RuntimeManifestLoad): string {
	return runtimeContentSha256({ manifest: load.manifest });
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
	} catch {
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
		const parsed = runtimeDesiredStateSchema.safeParse(
			JSON.parse(readFileSync(paths.manifestLastGood, "utf-8")),
		);
		if (!parsed.success) return null;
		return {
			apiUrl: parsed.data.controlPlane.apiUrl,
			apiKey,
			environmentId: parsed.data.environmentId,
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

function readFileIfExists(path: string): string | null {
	if (!existsSync(path)) return null;
	return readFileSync(path, "utf-8");
}

export interface SystemdUnitSnapshot {
	system: Map<string, string>;
	user: Map<string, string>;
}

type SystemdRuntimeScope = "system" | "user";

type SystemdRuntimeMutationStage =
	| "egress-prerequisite"
	| "official-installer"
	| "final-activation"
	| "quiesce"
	| "rollback";

type SystemdRuntimeMutationAction =
	| "daemon-reload"
	| "disable"
	| "enable"
	| "enable-and-start"
	| "install"
	| "reset-failed"
	| "restart"
	| "start"
	| "stop";

export interface SystemdRuntimeMutationJournalEntry {
	sequence: number;
	stage: SystemdRuntimeMutationStage;
	scope: SystemdRuntimeScope;
	action: SystemdRuntimeMutationAction;
	units: string[];
	outcome: "pending" | "succeeded" | "failed";
}

interface SystemdUnitManagerState {
	loadState: string;
	activeState: string;
	mainPid: number;
	needDaemonReload: boolean;
	enabledState?: string;
}

interface CommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

const RUNTIME_WATCH_SYSTEM_UNIT = "clawdi-runtime-watch.service";
const RUNTIME_DAEMON_SYSTEM_UNIT = "clawdi-daemon.service";
const RUNTIME_SIDECAR_SYSTEM_UNIT = "clawdi-runtime-sidecar.service";
const RUNTIME_REVISION_RE = /^[a-f0-9]{32}$/;

const SYSTEMD_ACTIVATION_STAGES = new Set<SystemdRuntimeMutationStage>([
	"egress-prerequisite",
	"official-installer",
	"final-activation",
]);

const systemdRuntimeTransactionInitialStates = new WeakMap<
	SystemdRuntimeTransaction,
	{ system: Map<string, SystemdUnitManagerState>; user: Map<string, SystemdUnitManagerState> }
>();

export class SystemdRuntimeTransaction {
	// Journal entries contain only systemd unit names and command outcomes. Command
	// output, environment, process metadata, and secret material never enter it.
	readonly journal: SystemdRuntimeMutationJournalEntry[] = [];

	constructor() {
		systemdRuntimeTransactionInitialStates.set(this, {
			system: new Map(),
			user: new Map(),
		});
	}

	get state(): "pristine" | "mutated" {
		return this.journal.some((entry) => SYSTEMD_ACTIVATION_STAGES.has(entry.stage))
			? "mutated"
			: "pristine";
	}

	installOfficialService(
		paths: ReturnType<typeof getRuntimePaths>,
		unit: string,
		install: () => string | null,
	): string | null {
		return runSystemdRuntimeOfficialInstaller(paths, this, unit, install);
	}

	quiesce(
		paths: ReturnType<typeof getRuntimePaths>,
		affectedUserUnits: readonly string[] = [],
	): void {
		quiesceSystemdRuntimeCandidate(paths, this, affectedUserUnits);
	}

	rollback(paths: ReturnType<typeof getRuntimePaths>): void {
		rollbackSystemdRuntimeTransaction(paths, this);
	}
}

function systemdRuntimeTransactionTouchedUnits(transaction: SystemdRuntimeTransaction): {
	systemUnits: string[];
	userUnits: string[];
} {
	const systemUnits = new Set<string>();
	const userUnits = new Set<string>();
	for (const entry of transaction.journal) {
		const restoresUnit =
			SYSTEMD_ACTIVATION_STAGES.has(entry.stage) ||
			(entry.stage === "quiesce" && entry.action === "stop");
		if (!restoresUnit || entry.action === "daemon-reload") continue;
		const target = entry.scope === "system" ? systemUnits : userUnits;
		for (const unit of entry.units) target.add(unit);
	}
	return {
		systemUnits: [...systemUnits].sort(),
		userUnits: [...userUnits].sort(),
	};
}

export function readSystemdUnitSnapshot(
	paths: ReturnType<typeof getRuntimePaths>,
): SystemdUnitSnapshot {
	return {
		system: readManagedSystemdUnits(paths.systemdSystemRoot),
		user: readManagedSystemdUnits(paths.systemdUserRoot),
	};
}

function systemdDesiredProgramRevision(
	paths: ReturnType<typeof getRuntimePaths>,
	unit: string,
): string {
	if (!unit.endsWith(".service")) {
		throw new Error(`managed systemd unit has invalid name: ${unit}`);
	}
	const programName = unit.slice(0, -".service".length);
	const content = readFileSync(systemdEnvironmentFilePath(paths, programName), "utf8");
	const parsed = parseDotenv(content).filter(([key]) => key === "CLAWDI_RUNTIME_REV");
	const declarations = content
		.split(/\r?\n/)
		.filter((line) => line.startsWith("CLAWDI_RUNTIME_REV="));
	const match = /^CLAWDI_RUNTIME_REV="([a-f0-9]{32})"$/.exec(declarations[0] ?? "");
	if (parsed.length !== 1 || declarations.length !== 1 || !match) {
		throw new Error("invalid revision declaration");
	}
	return match[1];
}

function readSystemdUserDesiredRevisions(
	paths: ReturnType<typeof getRuntimePaths>,
	units: Iterable<string>,
): ReadonlyMap<string, string> {
	const revisions = new Map<string, string>();
	for (const unit of units) {
		try {
			revisions.set(unit, systemdDesiredProgramRevision(paths, unit));
		} catch {
			// Missing or malformed predecessor authority is not eligible for adoption.
		}
	}
	return revisions;
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
): { added: string[]; changed: string[]; removed: string[]; present: string[] } {
	const added: string[] = [];
	const changed: string[] = [];
	const removed: string[] = [];
	for (const [name, contents] of after) {
		if (!before.has(name)) added.push(name);
		else if (before.get(name) !== contents) changed.push(name);
	}
	for (const name of before.keys()) {
		if (!after.has(name)) removed.push(name);
	}
	return {
		added: added.sort(),
		changed: changed.sort(),
		removed: removed.sort(),
		present: [...after.keys()].sort(),
	};
}

function withoutStaleSystemdUnits(
	snapshot: SystemdUnitSnapshot,
	staleSystemUnits: readonly string[],
	staleUserUnits: readonly string[],
): SystemdUnitSnapshot {
	const system = new Map(snapshot.system);
	const user = new Map(snapshot.user);
	for (const unit of staleSystemUnits) system.delete(unit);
	for (const unit of staleUserUnits) user.delete(unit);
	return { system, user };
}

export function applySystemdRuntimeUpdate(
	paths: ReturnType<typeof getRuntimePaths>,
	before: SystemdUnitSnapshot,
	after: SystemdUnitSnapshot,
	opts: {
		transaction: SystemdRuntimeTransaction;
		stage: Extract<SystemdRuntimeMutationStage, "egress-prerequisite" | "final-activation">;
		forceRestartSystemUnits?: readonly string[];
		forceStopSystemUnits?: readonly string[];
		forceRestartUserUnits?: readonly string[];
		recoverFailedUnits?: boolean;
		activationScope?: {
			systemUnits: readonly string[];
			userUnits: readonly string[];
		};
		preserveActiveUnits?: boolean;
		previousUserDesiredRevisions?: ReadonlyMap<string, string>;
		onUserProcessRevisionAliases?: (aliases: RuntimeUserProcessRevisionAliases) => void;
		skipActivatedSystemUnits?: readonly string[];
	},
): { applied: boolean; systemUnitsChanged: string[]; userUnitsChanged: string[] } {
	const { transaction, stage } = opts;
	const allSystem = changedSystemdUnits(before.system, after.system);
	const allUser = changedSystemdUnits(before.user, after.user);
	const filterChanges = (
		changes: ReturnType<typeof changedSystemdUnits>,
		units: readonly string[],
	): ReturnType<typeof changedSystemdUnits> => {
		const selected = new Set(units);
		return {
			added: changes.added.filter((unit) => selected.has(unit)),
			changed: changes.changed.filter((unit) => selected.has(unit)),
			removed: changes.removed.filter((unit) => selected.has(unit)),
			present: changes.present.filter((unit) => selected.has(unit)),
		};
	};
	const system = opts.activationScope
		? filterChanges(allSystem, opts.activationScope.systemUnits)
		: allSystem;
	const user = opts.activationScope
		? filterChanges(allUser, opts.activationScope.userUnits)
		: allUser;
	const systemUnitsChanged = new Set([...system.added, ...system.removed]);
	const userUnitsChanged = new Set([...user.added, ...user.removed]);
	const scopedSystemUnits = opts.activationScope ? new Set(opts.activationScope.systemUnits) : null;
	const forcedSystemRestarts = (opts.forceRestartSystemUnits ?? []).filter(
		(unit) => after.system.has(unit) && (!scopedSystemUnits || scopedSystemUnits.has(unit)),
	);
	const forcedSystemStops = (opts.forceStopSystemUnits ?? []).filter(
		(unit) => after.system.has(unit) && (!scopedSystemUnits || scopedSystemUnits.has(unit)),
	);
	const scopedUserUnits = opts.activationScope ? new Set(opts.activationScope.userUnits) : null;
	const forcedUserRestarts = (opts.forceRestartUserUnits ?? []).filter(
		(unit) => after.user.has(unit) && (!scopedUserUnits || scopedUserUnits.has(unit)),
	);
	const recoverFailedUnits = opts.recoverFailedUnits !== false;
	const activationChanged =
		system.added.length > 0 ||
		system.changed.length > 0 ||
		system.removed.length > 0 ||
		user.added.length > 0 ||
		user.changed.length > 0 ||
		user.removed.length > 0 ||
		forcedSystemRestarts.length > 0 ||
		forcedSystemStops.length > 0 ||
		forcedUserRestarts.length > 0;
	if (!shouldApplySystemdRuntimeUpdate(paths)) {
		return {
			applied: !activationChanged,
			systemUnitsChanged: [...systemUnitsChanged].sort(),
			userUnitsChanged: [...userUnitsChanged].sort(),
		};
	}
	const systemStates = preflightSystemdRuntimeUnits(paths, transaction, "system", [
		...system.present,
		...system.removed,
		...forcedSystemStops,
	]);
	const userStates = preflightSystemdRuntimeUnits(paths, transaction, "user", [
		...user.present,
		...user.removed,
	]);
	const systemManagerNeedsReload = new Set(
		system.present.filter((unit) => systemStates.get(unit)?.needDaemonReload),
	);
	const userManagerNeedsReload = new Set(
		user.present.filter((unit) => userStates.get(unit)?.needDaemonReload),
	);
	const changedSystemUnits = new Set(system.changed);
	const changedUserUnits = new Set(user.changed);
	const committedAliases = readRuntimeAppliedState(paths)?.userProcessRevisionAliases ?? {};
	const userProcessRevisionAliases: RuntimeUserProcessRevisionAliases = {};
	const userProcessRevisionDrift = new Set<string>();
	for (const unit of user.present) {
		const state = requiredSystemdUnitState(userStates, "user", unit);
		if (state.activeState !== "active") continue;
		const revisions = systemdProcessRevisions(paths, unit, state);
		if (revisions.processRevision === revisions.desiredRevision) continue;
		const committedAlias = committedAliases[unit];
		if (
			committedAlias?.desiredRevision === revisions.desiredRevision &&
			committedAlias.processRevision === revisions.processRevision
		) {
			userProcessRevisionAliases[unit] = committedAlias;
			continue;
		}
		if (
			opts.preserveActiveUnits &&
			opts.previousUserDesiredRevisions?.get(unit) === revisions.processRevision
		) {
			userProcessRevisionAliases[unit] = revisions;
			continue;
		}
		userProcessRevisionDrift.add(unit);
	}

	for (const unit of system.removed) {
		const state = requiredSystemdUnitState(systemStates, "system", unit);
		if (unit === RUNTIME_WATCH_SYSTEM_UNIT && !systemdUnitAbsentOrInactive(state)) continue;
		if (!systemdUnitAbsentOrInactive(state)) {
			runJournaledSystemdMutation(transaction, stage, "system", "stop", [unit], () =>
				systemctl(["stop", unit]),
			);
		}
	}
	for (const unit of user.removed) {
		const state = requiredSystemdUnitState(userStates, "user", unit);
		if (!systemdUnitAbsentOrInactive(state)) {
			runJournaledSystemdMutation(transaction, stage, "user", "stop", [unit], () =>
				runtimeUserSystemctl(paths, ["stop", unit]),
			);
		}
		if (!systemdUnitAbsentOrDisabled(state)) {
			runJournaledSystemdMutation(transaction, stage, "user", "disable", [unit], () =>
				runtimeUserSystemctl(paths, ["disable", unit]),
			);
		}
	}
	for (const unit of forcedSystemStops) {
		const state = requiredSystemdUnitState(systemStates, "system", unit);
		if (!systemdUnitAbsentOrInactive(state)) {
			runJournaledSystemdMutation(transaction, stage, "system", "stop", [unit], () =>
				systemctl(["stop", unit]),
			);
			systemUnitsChanged.add(unit);
		}
	}

	if (
		system.added.length > 0 ||
		system.changed.length > 0 ||
		system.removed.length > 0 ||
		systemManagerNeedsReload.size > 0
	) {
		runJournaledSystemdMutation(transaction, stage, "system", "daemon-reload", [], () =>
			systemctl(["daemon-reload"]),
		);
	}
	if (
		user.added.length > 0 ||
		user.changed.length > 0 ||
		user.removed.length > 0 ||
		userManagerNeedsReload.size > 0
	) {
		runJournaledSystemdMutation(transaction, stage, "user", "daemon-reload", [], () =>
			runtimeUserSystemctl(paths, ["daemon-reload"]),
		);
	}

	const addedSystemUnits = new Set(system.added);
	const forcedRestartUnits = new Set(forcedSystemRestarts);
	const forcedStopUnits = new Set(forcedSystemStops);
	const skipActivatedSystemUnits = new Set(opts.skipActivatedSystemUnits ?? []);
	const resetFailedSystemUnits: string[] = [];
	const startSystemUnits: string[] = [];
	const restartSystemUnits: string[] = [];
	for (const unit of system.present) {
		const state = requiredSystemdUnitState(systemStates, "system", unit);
		if (forcedStopUnits.has(unit)) continue;
		if (skipActivatedSystemUnits.has(unit)) continue;
		if (state.activeState === "failed" && recoverFailedUnits) {
			resetFailedSystemUnits.push(unit);
			startSystemUnits.push(unit);
			systemUnitsChanged.add(unit);
			continue;
		}
		if (state.activeState === "inactive") {
			startSystemUnits.push(unit);
			systemUnitsChanged.add(unit);
			continue;
		}
		if (
			state.activeState === "active" &&
			unit !== RUNTIME_WATCH_SYSTEM_UNIT &&
			((changedSystemUnits.has(unit) && !opts.preserveActiveUnits) ||
				(forcedRestartUnits.has(unit) &&
					(!addedSystemUnits.has(unit) || unit === RUNTIME_SIDECAR_SYSTEM_UNIT)))
		) {
			restartSystemUnits.push(unit);
			systemUnitsChanged.add(unit);
		}
	}
	// Each reconciliation makes at most one recovery attempt per failed unit.
	// Transitional units remain untouched and fail final proof below.
	if (resetFailedSystemUnits.length > 0) {
		runJournaledSystemdMutation(
			transaction,
			stage,
			"system",
			"reset-failed",
			resetFailedSystemUnits,
			() => systemctl(["reset-failed", ...resetFailedSystemUnits]),
		);
	}
	if (startSystemUnits.length > 0) {
		runJournaledSystemdMutation(transaction, stage, "system", "start", startSystemUnits, () =>
			systemctl(["start", ...startSystemUnits]),
		);
	}
	if (restartSystemUnits.length > 0) {
		runJournaledSystemdMutation(transaction, stage, "system", "restart", restartSystemUnits, () =>
			systemctl(["restart", ...restartSystemUnits]),
		);
	}

	const resetFailedUserUnits: string[] = [];
	const forcedRestartUserUnits = new Set(forcedUserRestarts);
	const startUserUnits: string[] = [];
	const enableUserUnits: string[] = [];
	const enableAndStartUserUnits: string[] = [];
	const restartUserUnits: string[] = [];
	for (const unit of user.present) {
		const state = requiredSystemdUnitState(userStates, "user", unit);
		const enabled = systemdUnitEnabled(state);
		if (state.activeState === "failed" && recoverFailedUnits) {
			resetFailedUserUnits.push(unit);
			userUnitsChanged.add(unit);
		}
		if (
			state.activeState === "inactive" ||
			(state.activeState === "failed" && recoverFailedUnits)
		) {
			if (enabled) startUserUnits.push(unit);
			else enableAndStartUserUnits.push(unit);
			userUnitsChanged.add(unit);
			continue;
		}
		if (state.activeState !== "active") continue;
		if (!enabled) {
			enableUserUnits.push(unit);
			userUnitsChanged.add(unit);
		}
		if (
			userProcessRevisionDrift.has(unit) ||
			(changedUserUnits.has(unit) && !opts.preserveActiveUnits) ||
			forcedRestartUserUnits.has(unit)
		) {
			restartUserUnits.push(unit);
			userUnitsChanged.add(unit);
		}
	}
	for (const unit of restartUserUnits) delete userProcessRevisionAliases[unit];
	if (resetFailedUserUnits.length > 0) {
		runJournaledSystemdMutation(
			transaction,
			stage,
			"user",
			"reset-failed",
			resetFailedUserUnits,
			() => runtimeUserSystemctl(paths, ["reset-failed", ...resetFailedUserUnits]),
		);
	}
	if (enableAndStartUserUnits.length > 0) {
		runJournaledSystemdMutation(
			transaction,
			stage,
			"user",
			"enable-and-start",
			enableAndStartUserUnits,
			() => runtimeUserSystemctl(paths, ["enable", "--now", ...enableAndStartUserUnits]),
		);
	}
	if (enableUserUnits.length > 0) {
		runJournaledSystemdMutation(transaction, stage, "user", "enable", enableUserUnits, () =>
			runtimeUserSystemctl(paths, ["enable", ...enableUserUnits]),
		);
	}
	if (startUserUnits.length > 0) {
		runJournaledSystemdMutation(transaction, stage, "user", "start", startUserUnits, () =>
			runtimeUserSystemctl(paths, ["start", ...startUserUnits]),
		);
	}
	if (restartUserUnits.length > 0) {
		runJournaledSystemdMutation(transaction, stage, "user", "restart", restartUserUnits, () =>
			runtimeUserSystemctl(paths, ["restart", ...restartUserUnits]),
		);
	}

	const systemConverged = system.present.every((unit) => {
		const state = systemdUnitManagerState(paths, "system", unit);
		if (forcedStopUnits.has(unit)) return systemdUnitAbsentOrInactive(state);
		return (
			state.loadState !== "not-found" && state.activeState === "active" && !state.needDaemonReload
		);
	});
	const userConverged = user.present.every((unit) => {
		const state = systemdUnitManagerState(paths, "user", unit);
		if (
			state.loadState === "not-found" ||
			state.activeState !== "active" ||
			state.needDaemonReload ||
			!systemdUnitEnabled(state)
		) {
			return false;
		}
		const revisions = systemdProcessRevisions(paths, unit, state);
		const alias = userProcessRevisionAliases[unit];
		return (
			revisions.processRevision === revisions.desiredRevision ||
			(alias?.desiredRevision === revisions.desiredRevision &&
				alias.processRevision === revisions.processRevision)
		);
	});
	const removedSystemConverged = system.removed.every(
		(unit) =>
			unit === RUNTIME_WATCH_SYSTEM_UNIT ||
			systemdUnitAbsentOrInactive(systemdUnitManagerState(paths, "system", unit)),
	);
	const removedUserConverged = user.removed.every((unit) => {
		const state = systemdUnitManagerState(paths, "user", unit);
		return systemdUnitAbsentOrInactive(state) && systemdUnitAbsentOrDisabled(state);
	});
	const applied =
		systemConverged && userConverged && removedSystemConverged && removedUserConverged;
	if (applied) opts.onUserProcessRevisionAliases?.(userProcessRevisionAliases);
	return {
		applied,
		systemUnitsChanged: [...systemUnitsChanged].sort(),
		userUnitsChanged: [...userUnitsChanged].sort(),
	};
}

function quiesceSystemdRuntimeCandidate(
	paths: ReturnType<typeof getRuntimePaths>,
	transaction: SystemdRuntimeTransaction,
	affectedUserUnits: readonly string[],
): void {
	if (!shouldApplySystemdRuntimeUpdate(paths)) return;
	const candidateUnits = systemdRuntimeCandidateUnits(transaction);
	const userUnits = [...new Set([...candidateUnits.user, ...affectedUserUnits])]
		.filter((unit) => unit !== RUNTIME_WATCH_SYSTEM_UNIT)
		.sort();
	const userStates = preflightSystemdRuntimeUnits(paths, transaction, "user", userUnits);
	for (const unit of userUnits) {
		const state = requiredSystemdUnitState(userStates, "user", unit);
		if (systemdUnitAbsentOrInactive(state)) continue;
		runJournaledSystemdMutation(transaction, "quiesce", "user", "stop", [unit], () =>
			runtimeUserSystemctl(paths, ["stop", unit]),
		);
	}
	const systemUnits = [...candidateUnits.system]
		.filter((unit) => unit !== RUNTIME_WATCH_SYSTEM_UNIT)
		.sort();
	for (const unit of systemUnits) {
		const state = systemdUnitManagerState(paths, "system", unit);
		if (systemdUnitAbsentOrInactive(state)) continue;
		runJournaledSystemdMutation(transaction, "quiesce", "system", "stop", [unit], () =>
			systemctl(["stop", unit]),
		);
	}
}

function systemdRuntimeCandidateUnits(transaction: SystemdRuntimeTransaction): {
	system: Set<string>;
	user: Set<string>;
} {
	const candidateActions = new Set<SystemdRuntimeMutationAction>([
		"enable-and-start",
		"install",
		"restart",
		"start",
	]);
	const candidateUnits = { system: new Set<string>(), user: new Set<string>() };
	for (const entry of transaction.journal) {
		if (!SYSTEMD_ACTIVATION_STAGES.has(entry.stage) || !candidateActions.has(entry.action)) {
			continue;
		}
		for (const unit of entry.units) candidateUnits[entry.scope].add(unit);
	}
	return candidateUnits;
}

function rollbackSystemdRuntimeTransaction(
	paths: ReturnType<typeof getRuntimePaths>,
	transaction: SystemdRuntimeTransaction,
): void {
	const activationJournal = transaction.journal.filter((entry) =>
		SYSTEMD_ACTIVATION_STAGES.has(entry.stage),
	);
	const touched = systemdRuntimeTransactionTouchedUnits(transaction);
	const reloadSystem = activationJournal.some(
		(entry) => entry.scope === "system" && entry.action === "daemon-reload",
	);
	const reloadUser = activationJournal.some(
		(entry) =>
			entry.scope === "user" && (entry.action === "daemon-reload" || entry.action === "install"),
	);
	if (reloadSystem) {
		runJournaledSystemdMutation(transaction, "rollback", "system", "daemon-reload", [], () =>
			systemctl(["daemon-reload"]),
		);
	}
	if (reloadUser) {
		runJournaledSystemdMutation(transaction, "rollback", "user", "daemon-reload", [], () =>
			runtimeUserSystemctl(paths, ["daemon-reload"]),
		);
	}
	for (const unit of touched.systemUnits) {
		const initial = systemdRuntimeTransactionStates(transaction).system.get(unit);
		if (!initial || initial.loadState === "not-found" || initial.activeState !== "active") continue;
		restoreActiveSystemdUnit(paths, transaction, "system", unit);
	}
	for (const unit of touched.userUnits) {
		const initial = systemdRuntimeTransactionStates(transaction).user.get(unit);
		if (!initial || initial.loadState === "not-found") continue;
		const initiallyEnabled = systemdUnitEnabled(initial);
		const currentlyEnabled = systemdUnitEnabled(systemdUnitManagerState(paths, "user", unit));
		if (initiallyEnabled !== currentlyEnabled) {
			const action = initiallyEnabled ? "enable" : "disable";
			runJournaledSystemdMutation(transaction, "rollback", "user", action, [unit], () =>
				runtimeUserSystemctl(paths, [action, unit]),
			);
		}
		if (initial.activeState !== "active") continue;
		restoreActiveSystemdUnit(paths, transaction, "user", unit);
		const restored = systemdUnitManagerState(paths, "user", unit);
		if (systemdUnitEnabled(restored) !== initiallyEnabled) {
			throw new Error(`systemd rollback did not restore user unit ${unit} enablement`);
		}
		if (!systemdProcessRevisionMatches(paths, unit, restored)) {
			throw new Error(`systemd rollback restored stale runtime revision for ${unit}`);
		}
	}
}

function restoreActiveSystemdUnit(
	paths: ReturnType<typeof getRuntimePaths>,
	transaction: SystemdRuntimeTransaction,
	scope: SystemdRuntimeScope,
	unit: string,
): void {
	let current = systemdUnitManagerState(paths, scope, unit);
	const mutate = (
		action: Extract<SystemdRuntimeMutationAction, "reset-failed" | "start" | "stop">,
	) =>
		runJournaledSystemdMutation(transaction, "rollback", scope, action, [unit], () =>
			scope === "system" ? systemctl([action, unit]) : runtimeUserSystemctl(paths, [action, unit]),
		);
	if (current.activeState === "failed") {
		mutate("reset-failed");
		current = systemdUnitManagerState(paths, scope, unit);
	}
	if (current.activeState !== "active") {
		if (current.activeState !== "inactive") {
			throw new Error(
				`systemd rollback could not restore ${scope} unit ${unit} from ${current.activeState}`,
			);
		}
		mutate("start");
		current = systemdUnitManagerState(paths, scope, unit);
	}
	if (current.activeState !== "active") {
		throw new Error(`systemd rollback did not restore ${scope} unit ${unit} activity`);
	}
}

function runSystemdRuntimeOfficialInstaller(
	paths: ReturnType<typeof getRuntimePaths>,
	transaction: SystemdRuntimeTransaction,
	unit: string,
	install: () => string | null,
): string | null {
	const states = preflightSystemdRuntimeUnits(paths, transaction, "user", [unit]);
	const state = requiredSystemdUnitState(states, "user", unit);
	if (state.activeState === "active") {
		systemdProcessRevisionMatches(paths, unit, state);
	}
	return runJournaledSystemdMutation(
		transaction,
		"official-installer",
		"user",
		"install",
		[unit],
		install,
		(error) => error !== null,
	);
}

function preflightSystemdRuntimeUnits(
	paths: ReturnType<typeof getRuntimePaths>,
	transaction: SystemdRuntimeTransaction,
	scope: SystemdRuntimeScope,
	units: readonly string[],
): Map<string, SystemdUnitManagerState> {
	const states = new Map<string, SystemdUnitManagerState>();
	const initialStates = systemdRuntimeTransactionStates(transaction)[scope];
	for (const unit of [...new Set(units)].sort()) {
		const state = systemdUnitManagerState(paths, scope, unit);
		states.set(unit, state);
		if (!initialStates.has(unit)) initialStates.set(unit, state);
	}
	return states;
}

function systemdRuntimeTransactionStates(transaction: SystemdRuntimeTransaction): {
	system: Map<string, SystemdUnitManagerState>;
	user: Map<string, SystemdUnitManagerState>;
} {
	const states = systemdRuntimeTransactionInitialStates.get(transaction);
	if (!states) throw new Error("systemd runtime transaction is not initialized");
	return states;
}
function requiredSystemdUnitState(
	states: ReadonlyMap<string, SystemdUnitManagerState>,
	scope: SystemdRuntimeScope,
	unit: string,
): SystemdUnitManagerState {
	const state = states.get(unit);
	if (!state) throw new Error(`systemd ${scope} unit ${unit} was not preflighted`);
	return state;
}

function runJournaledSystemdMutation<T>(
	transaction: SystemdRuntimeTransaction,
	stage: SystemdRuntimeMutationStage,
	scope: SystemdRuntimeScope,
	action: SystemdRuntimeMutationAction,
	units: readonly string[],
	mutation: () => T,
	failed: (result: T) => boolean = () => false,
): T {
	const entry: SystemdRuntimeMutationJournalEntry = {
		sequence: transaction.journal.length + 1,
		stage,
		scope,
		action,
		units: [...new Set(units)].sort(),
		outcome: "pending",
	};
	transaction.journal.push(entry);
	try {
		const result = mutation();
		entry.outcome = failed(result) ? "failed" : "succeeded";
		return result;
	} catch (error) {
		entry.outcome = "failed";
		throw error;
	}
}

function systemdUnitManagerState(
	paths: ReturnType<typeof getRuntimePaths>,
	scope: "system" | "user",
	unit: string,
): SystemdUnitManagerState {
	const showArgs = [
		"show",
		unit,
		"--property=LoadState",
		"--property=ActiveState",
		"--property=MainPID",
		"--property=NeedDaemonReload",
	];
	const show =
		scope === "system" ? systemctlResult(showArgs) : runtimeUserSystemctlResult(paths, showArgs);
	assertCommandSucceeded(scope === "system" ? systemctlPath() : "systemctl --user", showArgs, show);
	const properties = Object.fromEntries(
		show.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const separator = line.indexOf("=");
				return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
			}),
	);
	const loadState = properties.LoadState;
	const activeState = properties.ActiveState;
	const mainPidValue = properties.MainPID;
	const needDaemonReload = properties.NeedDaemonReload;
	if (!loadState || !activeState || mainPidValue === undefined || !needDaemonReload) {
		throw new Error(`systemd ${scope} unit ${unit} returned incomplete manager state`);
	}
	if (!/^(0|[1-9]\d*)$/.test(mainPidValue)) {
		throw new Error(`systemd ${scope} unit ${unit} returned invalid MainPID`);
	}
	const mainPid = Number(mainPidValue);
	if (!Number.isSafeInteger(mainPid)) {
		throw new Error(`systemd ${scope} unit ${unit} returned invalid MainPID`);
	}
	if (needDaemonReload !== "yes" && needDaemonReload !== "no") {
		throw new Error(
			`systemd ${scope} unit ${unit} returned invalid NeedDaemonReload: ${needDaemonReload}`,
		);
	}
	const managerState = {
		loadState,
		activeState,
		mainPid,
		needDaemonReload: needDaemonReload === "yes",
	};
	if (scope === "system") return managerState;

	const enabledArgs = ["is-enabled", unit];
	const enabled = runtimeUserSystemctlResult(paths, enabledArgs);
	const enabledState = enabled.stdout.trim().split(/\s+/)[0] ?? "";
	if (!SYSTEMD_ENABLED_STATES.has(enabledState) && !SYSTEMD_DISABLED_STATES.has(enabledState)) {
		assertCommandSucceeded("systemctl --user", enabledArgs, enabled);
		throw new Error(`systemd user unit ${unit} returned unknown enabled state: ${enabledState}`);
	}
	return { ...managerState, enabledState };
}

function systemdProcessRevisionMatches(
	paths: ReturnType<typeof getRuntimePaths>,
	unit: string,
	state: SystemdUnitManagerState,
): boolean {
	const revisions = systemdProcessRevisions(paths, unit, state);
	return revisions.processRevision === revisions.desiredRevision;
}

function systemdProcessRevisions(
	paths: ReturnType<typeof getRuntimePaths>,
	unit: string,
	state: SystemdUnitManagerState,
): { desiredRevision: string; processRevision: string } {
	if (state.mainPid === 0) {
		throw new Error(`active managed systemd unit ${unit} has no MainPID`);
	}
	let desiredRevision: string;
	try {
		desiredRevision = systemdDesiredProgramRevision(paths, unit);
	} catch (error) {
		throw new Error(`could not prove desired runtime revision for managed systemd unit ${unit}`, {
			cause: error,
		});
	}

	let processRevision: string;
	try {
		const procDir = `/proc/${state.mainPid}`;
		const owner = statSync(procDir);
		const readEnvironment = () => readFileSync(join(procDir, "environ"));
		let environment: Buffer;
		try {
			environment = readEnvironment();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (owner.uid === 0 || (code !== "EACCES" && code !== "EPERM")) throw error;
			environment = withEffectiveFilesystemIdentity(
				{ uid: owner.uid, gid: owner.gid },
				readEnvironment,
			);
		}
		processRevision = runtimeRevisionFromProcessEnvironment(environment);
	} catch (error) {
		throw new Error(`could not prove active runtime revision for managed systemd unit ${unit}`, {
			cause: error,
		});
	}
	return { desiredRevision, processRevision };
}

function runtimeRevisionFromProcessEnvironment(environment: Buffer): string {
	const prefix = Buffer.from("CLAWDI_RUNTIME_REV=");
	const revisions: string[] = [];
	for (let start = 0; start < environment.length; ) {
		const separator = environment.indexOf(0, start);
		const end = separator < 0 ? environment.length : separator;
		const entry = environment.subarray(start, end);
		if (entry.subarray(0, prefix.length).equals(prefix)) {
			revisions.push(entry.subarray(prefix.length).toString("ascii"));
		}
		start = end + 1;
	}
	if (revisions.length !== 1 || !RUNTIME_REVISION_RE.test(revisions[0])) {
		throw new Error("invalid revision entry");
	}
	return revisions[0];
}

const SYSTEMD_ENABLED_STATES = new Set([
	"enabled",
	"enabled-runtime",
	"linked",
	"linked-runtime",
	"alias",
]);
const SYSTEMD_DISABLED_STATES = new Set([
	"disabled",
	"not-found",
	"static",
	"indirect",
	"masked",
	"generated",
	"transient",
]);

function systemdUnitEnabled(state: SystemdUnitManagerState): boolean {
	return state.enabledState !== undefined && SYSTEMD_ENABLED_STATES.has(state.enabledState);
}

function systemdUnitAbsentOrInactive(state: SystemdUnitManagerState): boolean {
	return state.loadState === "not-found" || state.activeState === "inactive";
}

function systemdUnitAbsentOrDisabled(state: SystemdUnitManagerState): boolean {
	return (
		state.loadState === "not-found" ||
		state.enabledState === "not-found" ||
		state.enabledState === "disabled"
	);
}

function shouldApplySystemdRuntimeUpdate(paths: ReturnType<typeof getRuntimePaths>): boolean {
	const override = process.env.CLAWDI_SYSTEMD_APPLY?.trim().toLowerCase();
	if (override === "1" || override === "true") return true;
	if (override === "0" || override === "false") return false;
	return paths.systemdSystemRoot === "/run/systemd/system";
}

function systemctl(args: string[]): string {
	return runCommand(systemctlPath(), args);
}

function systemctlResult(args: string[]): CommandResult {
	return runCommandResult(systemctlPath(), args);
}

function systemctlPath(): string {
	return process.env.CLAWDI_SYSTEMCTL_PATH?.trim() || "systemctl";
}

function runtimeUserSystemctl(paths: ReturnType<typeof getRuntimePaths>, args: string[]): string {
	const result = runtimeUserSystemctlResult(paths, args);
	assertCommandSucceeded("systemctl --user", args, result);
	return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function runtimeUserSystemctlResult(
	paths: ReturnType<typeof getRuntimePaths>,
	args: string[],
): CommandResult {
	const runtimeUser = runtimeUserName();
	if (runtimeUser !== "root") {
		const uid = String(runtimeUserUid(runtimeUser));
		const child = buildRuntimeUserCommand(
			runtimeUser,
			paths.userHome,
			systemctlPath(),
			["--user", ...args],
			{ environment: runtimeUserSystemdEnvironment(uid) },
		);
		return runCommandResult(child.command, child.args, child.env);
	}
	return runCommandResult(systemctlPath(), ["--user", ...args]);
}

function assertRuntimeUserCanRead(path: string, home: string): void {
	const runtimeUser = runtimeUserName();
	const proof = buildRuntimeUserCommand(runtimeUser, home, "test", ["-r", path]);
	runCommand(proof.command, proof.args, proof.env);
}

function runCommand(command: string, args: string[], env?: Record<string, string>): string {
	const result = runCommandResult(command, args, env);
	assertCommandSucceeded(command, args, result);
	return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function runCommandResult(
	command: string,
	args: string[],
	env?: Record<string, string>,
): CommandResult {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		...(env ? { env: { ...process.env, ...env } } : {}),
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		...(result.error ? { error: result.error } : {}),
	};
}

function assertCommandSucceeded(command: string, args: string[], result: CommandResult): void {
	if (result.status === 0) return;
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
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
	if (event.status === "cli_handoff") {
		console.log("runtime watch handed off to the managed CLI");
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
	const activeAppliedState = readRuntimeAppliedState(input.paths);
	const status = buildRuntimeBootStatus(
		{
			mode: input.manifestLoad?.offline ? "degraded-offline" : "normal",
			status: "ok",
			stage: "config",
			bootId: input.bootId,
			runtimeMode: input.mode,
			activeGeneration: activeAppliedState?.generation ?? null,
			rejectedGeneration: null,
			instanceId: activeAppliedState?.instanceId ?? null,
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
		input.paths,
	);
	writeRuntimeBootStatus(status, input.paths);
	if (input.opts.json || !process.stdout.isTTY) {
		console.log(
			JSON.stringify(
				{
					...status,
					handoff: "cli_reexec",
					...input.detail,
					selfReexec: true,
				},
				null,
				2,
			),
		);
	} else {
		console.log(chalk.bold("clawdi runtime init"));
		console.log(chalk.green("  CLI activated; restarting under the managed binary"));
		console.log(chalk.gray(`  status: ${input.paths.bootStatus}`));
	}
	process.exitCode = RUNTIME_INIT_CLI_HANDOFF_EXIT_CODE;
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
		const status = repairStatus(
			{
				bootId,
				runtimeMode: mode,
				stage: "detect",
				exitCode: 2,
				errors: [
					"runtime init requires CLAWDI_RUNTIME_MODE=hosted explicitly; host policy files do not select runtime mode",
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
	let applyContext: RuntimeApplyContext;
	try {
		applyContext = opts.applyContext ?? readRuntimeApplyContext();
		assertHostedRuntimeContract(paths, applyContext, {
			...opts.hostedRuntimeContract,
			platformRoots: "deferred",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status = repairStatus(
			{
				bootId,
				runtimeMode: mode,
				stage: "detect",
				exitCode: 20,
				errors: [message],
			},
			paths,
		);
		if (opts.json || !process.stdout.isTTY) console.log(JSON.stringify(status, null, 2));
		else console.log(chalk.red(message));
		process.exitCode = 20;
		return;
	}
	try {
		ensureRuntimeStateDirs(paths);
	} catch (error) {
		const status = repairStatus(
			{
				bootId,
				runtimeMode: mode,
				stage: "detect",
				exitCode: 20,
				errors: [
					`could not create runtime state directories: ${
						error instanceof Error ? error.message : String(error)
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
	try {
		const reconciliation = reconcilePendingRuntimeCliUpgrade(paths, getCliVersion());
		if (reconciliation.selfReexec) {
			finishRuntimeInitCliHandoff({
				opts,
				paths,
				mode,
				bootId,
				hostPolicy,
				detail: { reconciliation },
			});
			return;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status = repairStatus(
			{
				bootId,
				runtimeMode: mode,
				stage: "local",
				exitCode: 23,
				errors: [message],
			},
			paths,
		);
		writeRuntimeBootStatus(status, paths);
		if (opts.json || !process.stdout.isTTY) console.log(JSON.stringify(status, null, 2));
		else console.log(chalk.red(message));
		process.exitCode = 23;
		return;
	}

	const nonInteractiveOk = opts.nonInteractive === true;
	const errors: string[] = [];
	let stage: RuntimeBootStage = "detect";
	let exitCode = 20;
	if (!nonInteractiveOk) {
		errors.push("runtime init requires --non-interactive in hosted mode");
	}
	if (errors.length === 0) {
		stage = "local";
		const loaded = await loadRuntimeManifest(paths, { applyContext: opts.applyContext });
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

		let convergenceLoad = loaded;
		let applyResult: RuntimeApplyResult;
		try {
			convergenceLoad = applyRuntimeBundleChannelsToManifestLoad(loaded, paths);
			const contentRevision = runtimePublicContentRevision(convergenceLoad);
			const applyIdentity = convergenceLoad.applyContext?.identity ?? null;
			applyResult = await applyRuntimeDesiredState(convergenceLoad, paths, {
				authorityCommit: (convergence, authority) =>
					commitRuntimeAppliedState({
						load: convergenceLoad,
						paths,
						etag: loaded.etag ?? `"sha256:${contentRevision}"`,
						sourceRevision: loaded.sourceRevision ?? contentRevision,
						convergence,
						applyIdentity,
						daemonAuthTokenRevision: authority.daemonAuthTokenRevision,
						daemonProgramRevision: authority.daemonProgramRevision,
						egressSidecarSecretRevision: authority.egressSidecarSecretRevision,
						userProcessRevisionAliases: authority.userProcessRevisionAliases,
					}),
				manifestIdentity: {
					generation: convergenceLoad.manifest.generation,
					etag: loaded.etag ?? null,
				},
				requireSystemdApplied: applyIdentity !== null,
				hostedRuntimeContract: opts.hostedRuntimeContract,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const activeAppliedState = readRuntimeAppliedState(paths);
			const status = buildRuntimeBootStatus(
				{
					mode: "repair",
					status: "error",
					stage: "final",
					bootId,
					runtimeMode: mode,
					activeGeneration: activeAppliedState?.generation ?? null,
					rejectedGeneration: convergenceLoad.manifest.generation,
					instanceId: activeAppliedState?.instanceId ?? null,
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
		if (applyResult.kind === "cli_update_failed") {
			const message = applyResult.cliUpdate.error ?? "CLI update failed";
			const activeAppliedState = readRuntimeAppliedState(paths);
			const status = buildRuntimeBootStatus(
				{
					mode: "repair",
					status: "error",
					stage: "config",
					bootId,
					runtimeMode: mode,
					activeGeneration: activeAppliedState?.generation ?? null,
					rejectedGeneration: convergenceLoad.manifest.generation,
					instanceId: activeAppliedState?.instanceId ?? null,
					enabledRuntimes: [],
					error: message,
					errors: [message],
					exitCode: 23,
					datasource: "RuntimeSource",
					hostPolicy: hostPolicySummary(hostPolicy),
				},
				paths,
			);
			writeRuntimeBootStatus(status, paths);
			if (opts.json || !process.stdout.isTTY) console.log(JSON.stringify(status, null, 2));
			process.exitCode = 23;
			return;
		}
		if (applyResult.kind === "cli_handoff") {
			finishRuntimeInitCliHandoff({
				opts,
				paths,
				mode,
				bootId,
				hostPolicy,
				manifestLoad: convergenceLoad,
				detail: { cliUpdate: applyResult.cliUpdate },
			});
			return;
		}
		const { convergence } = applyResult;
		const runtimeErrors = [...convergence.installErrors];
		const installOk = runtimeErrors.length === 0;
		if (installOk) completePendingRuntimeCliUpgrade(paths, getCliVersion());
		const activeAppliedState = readRuntimeAppliedState(paths);
		const status = buildRuntimeBootStatus(
			{
				mode: convergence.mode,
				status: installOk ? "ok" : "error",
				stage: "final",
				bootId,
				runtimeMode: mode,
				activeGeneration: activeAppliedState?.generation ?? null,
				rejectedGeneration: installOk ? null : convergence.manifest.generation,
				instanceId: activeAppliedState?.instanceId ?? null,
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
	opts: RuntimeWatchTickOptions,
): Promise<Record<string, unknown> | null> {
	return withRuntimeConvergeLockAsync(paths, () => runtimeWatchTickLocked(paths, opts));
}

async function runtimeWatchTickLocked(
	paths: ReturnType<typeof getRuntimePaths>,
	opts: RuntimeWatchTickOptions,
): Promise<Record<string, unknown> | null> {
	let reconciliation: RuntimeCliReconciliationResult;
	try {
		reconciliation = reconcilePendingRuntimeCliUpgrade(paths, getCliVersion());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "error",
			stage: "cli-update",
			errors: [message],
			error: message,
			selfReexec: false,
		};
	}
	if (reconciliation.selfReexec) {
		return {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "cli_handoff",
			stage: "cli-update",
			handoff: "cli_reexec",
			reconciliation,
			selfReexec: true,
		};
	}
	if (opts.failureBackoff?.etag === null && opts.now < opts.failureBackoff.nextRetryAt) {
		return null;
	}
	const event = await runtimeWatchTickAfterCliReconciliation(paths, opts);
	if (event === null) return null;
	return {
		...event,
		selfReexec: reconciliation.selfReexec || event.selfReexec === true,
	};
}

async function runtimeWatchTickAfterCliReconciliation(
	paths: ReturnType<typeof getRuntimePaths>,
	opts: RuntimeWatchTickOptions,
): Promise<Record<string, unknown> | null> {
	const activeAppliedState = readRuntimeAppliedState(paths);
	let failureEtag: string | null = null;
	const retryDeferred =
		opts.failureBackoff !== undefined && opts.now < opts.failureBackoff.nextRetryAt;
	const manifestEtag =
		retryDeferred && opts.failureBackoff?.etag
			? opts.failureBackoff.etag
			: opts.forceRefresh
				? undefined
				: (activeAppliedState?.etag ?? undefined);
	const manifestLoad = await loadRemoteRuntimeManifest(paths, {
		ifNoneMatch: manifestEtag,
		applyContext: opts.applyContext,
	});
	if ("errors" in manifestLoad) {
		if (
			retryDeferred &&
			opts.failureBackoff &&
			(!manifestLoad.etag || manifestLoad.etag === opts.failureBackoff.etag)
		) {
			return null;
		}
		return runtimeManifestFailureWatchEvent(manifestLoad);
	}
	const responseManifestEtag = manifestLoad.etag ?? manifestEtag ?? null;
	failureEtag = responseManifestEtag;
	if (retryDeferred && opts.failureBackoff?.etag === responseManifestEtag) {
		return null;
	}
	if (
		"notModified" in manifestLoad &&
		activeAppliedState !== null &&
		activeAppliedState.etag === responseManifestEtag &&
		runtimeApplyIdentitiesEqual(
			manifestLoad.applyContext?.identity ?? null,
			runtimeAppliedApplyIdentity(activeAppliedState),
		)
	) {
		const completion = completePendingRuntimeCliUpgrade(paths, getCliVersion());
		return {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "not_modified",
			sourcePath: manifestLoad.sourcePath,
			etag: responseManifestEtag,
			sourceRevision: activeAppliedState.sourceRevision,
			generation: activeAppliedState.generation,
			instanceId: activeAppliedState.instanceId,
			selfReexec: completion.selfReexec,
		};
	}

	try {
		const fresh =
			"notModified" in manifestLoad
				? await loadFullRuntimeManifestForWatch(paths, opts.applyContext)
				: manifestLoad;
		if ("errors" in fresh) {
			return runtimeManifestFailureWatchEvent(fresh);
		}
		failureEtag = fresh.etag ?? failureEtag;
		if (retryDeferred && opts.failureBackoff && opts.failureBackoff.etag === fresh.etag) {
			return null;
		}
		const loaded = applyRuntimeBundleChannelsToManifestLoad(fresh, paths);
		const bundleEtag = loaded.etag;
		const sourceRevision = loaded.sourceRevision;
		if (!bundleEtag || !sourceRevision) {
			throw new Error("runtime bundle is missing applied authority identity");
		}
		failureEtag = bundleEtag;
		const manifestIdentity = runtimeManifestIdentityForWatch(
			loaded.manifest.generation,
			bundleEtag,
			paths,
		);
		const applyIdentity = loaded.applyContext?.identity ?? null;
		const applyResult = await applyRuntimeDesiredState(loaded, paths, {
			authorityCommit: (convergence, authority) =>
				commitRuntimeAppliedState({
					load: loaded,
					paths,
					etag: bundleEtag,
					sourceRevision,
					convergence,
					applyIdentity,
					daemonAuthTokenRevision: authority.daemonAuthTokenRevision,
					daemonProgramRevision: authority.daemonProgramRevision,
					egressSidecarSecretRevision: authority.egressSidecarSecretRevision,
					userProcessRevisionAliases: authority.userProcessRevisionAliases,
				}),
			continueOnCliUpdateError: true,
			deferCliInstall: opts.deferCliInstall,
			deferCliInstallReason: opts.deferCliInstallReason,
			manifestIdentity,
			recoverFailedSystemdUnits: opts.recoverFailedSystemdUnits,
			requireSystemdApplied: applyIdentity !== null,
			hostedRuntimeContract: opts.hostedRuntimeContract,
		});
		if (applyResult.kind === "cli_handoff") {
			const activeAppliedState = readRuntimeAppliedState(paths);
			return {
				schemaVersion: "clawdi.runtimeWatchEvent.v1",
				status: "cli_handoff",
				stage: "cli-update",
				handoff: "cli_reexec",
				activeGeneration: activeAppliedState?.generation ?? null,
				desiredGeneration: loaded.manifest.generation,
				instanceId: activeAppliedState?.instanceId ?? null,
				cliUpdate: applyResult.cliUpdate,
				selfReexec: true,
				systemdUnitsChanged: false,
				systemdApply: {
					applied: false,
					systemUnitsChanged: [],
					userUnitsChanged: [],
				},
			};
		}
		if (applyResult.kind === "cli_update_failed") {
			const error = applyResult.cliUpdate.error ?? "CLI update failed";
			const activeAppliedState = readRuntimeAppliedState(paths);
			return {
				schemaVersion: "clawdi.runtimeWatchEvent.v1",
				status: "error",
				stage: "cli-update",
				errors: [error],
				error,
				activeGeneration: activeAppliedState?.generation ?? null,
				rejectedGeneration: loaded.manifest.generation,
				instanceId: activeAppliedState?.instanceId ?? null,
				etag: bundleEtag,
				cliUpdate: applyResult.cliUpdate,
				selfReexec: applyResult.cliUpdate.selfReexec,
				systemdUnitsChanged: false,
				systemdApply: {
					applied: false,
					systemUnitsChanged: [],
					userUnitsChanged: [],
				},
			};
		}
		const { convergence, cliUpdate, systemdApply: systemdApplyResult } = applyResult;
		const cliUpdateError =
			cliUpdate.status === "error" ? (cliUpdate.error ?? "CLI update failed") : null;
		const errors = [...(cliUpdateError ? [cliUpdateError] : []), ...convergence.installErrors];
		let selfReexec = cliUpdate.selfReexec;
		const systemdUnitsChanged =
			systemdApplyResult.systemUnitsChanged.length > 0 ||
			systemdApplyResult.userUnitsChanged.length > 0;
		if (errors.length > 0) {
			const cliRollback = maybeRollbackFailedCliUpgrade(paths, errors);
			if (cliRollback.status === "rolled_back") selfReexec = true;
			const activeAppliedState = readRuntimeAppliedState(paths);
			return {
				schemaVersion: "clawdi.runtimeWatchEvent.v1",
				status: "error",
				stage: cliUpdateError ? "cli-update" : "final",
				errors,
				error: errors[0],
				activeGeneration: activeAppliedState?.generation ?? null,
				rejectedGeneration: convergence.manifest.generation,
				instanceId: activeAppliedState?.instanceId ?? null,
				etag: bundleEtag,
				cliUpdate,
				cliRollback,
				selfReexec,
				systemdUnitsChanged,
				systemdApply: systemdApplyResult,
				convergence: convergence.outputs,
			};
		}
		const completion = completePendingRuntimeCliUpgrade(paths, getCliVersion());
		selfReexec = selfReexec || completion.selfReexec;
		return {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "applied",
			sourcePath: loaded.sourcePath,
			etag: loaded.etag,
			sourceRevision: loaded.sourceRevision,
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
		const message = error instanceof Error ? error.message : String(error);
		return {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "error",
			stage: "final",
			errors: [message],
			error: message,
			...(failureEtag ? { etag: failureEtag } : {}),
		};
	}
}

function runtimeManifestFailureWatchEvent(
	failure: RuntimeManifestFailure,
): Record<string, unknown> {
	return {
		schemaVersion: "clawdi.runtimeWatchEvent.v1",
		status: "error",
		mode: failure.mode,
		stage: failure.stage,
		errors: failure.errors,
		error: failure.errors[0],
		activeGeneration: failure.activeGeneration ?? null,
		rejectedGeneration: failure.rejectedGeneration ?? null,
		...(failure.etag ? { etag: failure.etag } : {}),
	};
}

function runtimeWatchFailureBackoff(
	previous: RuntimeWatchFailureBackoff | null,
	event: Record<string, unknown>,
	now: number,
): RuntimeWatchFailureBackoff {
	const etag = typeof event.etag === "string" ? event.etag : null;
	const backoffMs = nextBoundedBackoffMs(previous?.etag === etag ? previous.backoffMs : 0);
	return {
		backoffMs,
		etag,
		nextRetryAt: now + backoffMs,
	};
}

async function applyRuntimeDesiredState(
	load: RuntimeManifestLoad,
	paths: ReturnType<typeof getRuntimePaths>,
	opts: RuntimeApplyOptions = {},
): Promise<RuntimeApplyResult> {
	let preparedHostedAgentPlugins = opts.preparedHostedAgentPlugins;
	let preservePreparedAgentPluginArchives = false;
	try {
		let cliUpdate: RuntimeCliUpdateResult;
		try {
			cliUpdate = applyRuntimeCliDesiredState(load.manifest, paths, {
				deferInstall: opts.deferCliInstall,
				deferReason: opts.deferCliInstallReason,
				rollbackEligible: opts.manifestIdentity?.previouslyApplied,
				runningVersion: getCliVersion(),
			});
		} catch (error) {
			if (!opts.continueOnCliUpdateError) throw error;
			return {
				kind: "cli_update_failed",
				cliUpdate: runtimeCliUpdateError(load.manifest, paths, error),
			};
		}
		if (cliUpdate.selfReexec) {
			return { kind: "cli_handoff", cliUpdate };
		}
		const preserveActiveUnits = isRuntimeCliOnlyCheckpoint(load, paths);
		if (preparedHostedAgentPlugins === undefined) {
			preparedHostedAgentPlugins = await prepareHostedAgentPluginPackages(load.manifest, paths, {
				offline: load.offline,
				secretValues: load.secretValues,
			});
		}
		const preparedHostedSourcedSkills =
			opts.preparedHostedSourcedSkills ??
			(await prepareHostedSourcedSkillArchives(load.manifest, paths, {
				authToken: load.applyContext?.manifestSource.auth.token,
			}));
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
							`transparent-egress prerequisite activation failed: ${
								error instanceof Error ? error.message : String(error)
							}`,
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
						throw new Error(
							`systemd apply failed: ${error instanceof Error ? error.message : String(error)}`,
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
				gcHostedAgentPluginArchives(readHostedAgentPluginReceipt(paths), paths);
			} catch (error) {
				console.warn(
					`post-commit Agent Plugin archive cleanup deferred: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
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
		selfReexec: false,
		error: error instanceof Error ? error.message : String(error),
	};
}

function runtimeManifestIdentityForWatch(
	generation: number,
	observedManifestEtag: string | null,
	paths: RuntimePaths,
): RuntimeManifestIdentity {
	const appliedState = readRuntimeAppliedState(paths);
	return {
		generation,
		etag: observedManifestEtag,
		previouslyApplied: appliedState?.etag === observedManifestEtag,
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

async function loadFullRuntimeManifestForWatch(
	paths: ReturnType<typeof getRuntimePaths>,
	applyContext?: RuntimeApplyContext,
): Promise<RuntimeManifestLoad | RuntimeManifestFailure> {
	const loaded = await loadRemoteRuntimeManifest(paths, { applyContext });
	if ("notModified" in loaded) {
		throw new Error("runtime manifest datasource returned 304 without If-None-Match");
	}
	return loaded;
}

export async function runtimeWatch(opts: RuntimeWatchOptions = {}) {
	const paths = getRuntimePaths();
	const mode = detectRuntimeMode();
	const intervalMs = parsePositiveMs(opts.intervalMs, 15_000, "--interval-ms");
	const selfHealMs = parsePositiveMs(opts.selfHealMs, 300_000, "--self-heal-ms");
	let cliInstallRetryPending = false;
	let cliInstallBackoffMs = 0;
	let nextCliInstallRetryAt = 0;
	let failureBackoff: RuntimeWatchFailureBackoff | null = null;
	const wakeSignal = createRuntimeWatchWakeSignal();
	let notificationSubscription: RuntimeWatchNotificationSubscription | null = null;

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
	let applyContext: RuntimeApplyContext;
	try {
		applyContext = opts.applyContext ?? readRuntimeApplyContext();
		assertHostedRuntimeContract(paths, applyContext, {
			...opts.hostedRuntimeContract,
			platformRoots: "deferred",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
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
			const cliInstallRetryDue = cliInstallRetryPending && tickNow >= nextCliInstallRetryAt;
			const deferCliInstall = cliInstallRetryPending && !cliInstallRetryDue;
			const failureRetryDue = failureBackoff !== null && tickNow >= failureBackoff.nextRetryAt;
			// Full refreshes also re-resolve floating CLI channels when manifest ETags are unchanged.
			const forceRefresh =
				tickNow - lastFullFetchAt >= selfHealMs || cliInstallRetryDue || failureRetryDue;
			const fullFetchAttempted =
				forceRefresh && (!failureBackoff || tickNow >= failureBackoff.nextRetryAt);
			let event: Record<string, unknown> | null;
			try {
				event = await runtimeWatchTick(paths, {
					forceRefresh,
					applyContext,
					hostedRuntimeContract: opts.hostedRuntimeContract,
					deferCliInstall,
					failureBackoff: failureBackoff ?? undefined,
					now: tickNow,
					// Conditional retries run every 15 seconds. Recover failed units
					// only on the five-minute full refresh, or once in one-shot mode.
					recoverFailedSystemdUnits: forceRefresh || opts.once === true,
					deferCliInstallReason: deferCliInstall
						? `CLI install retry is in backoff until ${new Date(nextCliInstallRetryAt).toISOString()}`
						: undefined,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				event = {
					schemaVersion: "clawdi.runtimeWatchEvent.v1",
					status: "error",
					stage: "watch",
					errors: [message],
					error: message,
				};
			}
			if (event !== null) {
				const cliUpdateStatus = runtimeWatchCliUpdateStatus(event);
				if (cliUpdateStatus === "error") {
					cliInstallRetryPending = true;
					cliInstallBackoffMs = nextBoundedBackoffMs(cliInstallBackoffMs);
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

function nextBoundedBackoffMs(previousMs: number): number {
	if (previousMs <= 0) return 60_000;
	return Math.min(previousMs * 2, 300_000);
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
	const child = runningAsRootCommand()
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
	if (runningAsRootCommand()) chownSync(config.systemCaBundle, 0, config.runtimeGid);
	chmodSync(config.systemCaBundle, 0o640);
}

function runningAsRootCommand(): boolean {
	return typeof process.getuid === "function" && process.getuid() === 0;
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
		runtimeContextDetail = error instanceof Error ? error.message : String(error);
	}
	let platformRootsOk = true;
	let platformRootsDetail = "trusted";
	try {
		assertRuntimePlatformRoots(paths);
	} catch (error) {
		platformRootsOk = false;
		platformRootsDetail = error instanceof Error ? error.message : String(error);
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
