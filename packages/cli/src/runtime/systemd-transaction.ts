import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseDotenv } from "../lib/dotenv";
import { type RuntimeUserProcessRevisionAliases, readRuntimeAppliedState } from "./applied-state";
import { withEffectiveFilesystemIdentity } from "./effective-identity";
import type { getRuntimePaths } from "./paths";
import { systemdEnvironmentFilePath } from "./runtime-systemd-reconciliation";
import { buildRuntimeUserCommand, runtimeUserUid } from "./runtime-user-command";
import { managedRuntimeSystemdUnitEntries, parseSystemctlShow, systemctlPath } from "./systemd";
import { runtimeUserName, runtimeUserSystemdEnvironment } from "./systemd-user";

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

export const RUNTIME_WATCH_SYSTEM_UNIT = "clawdi-runtime-watch.service";
export const RUNTIME_DAEMON_SYSTEM_UNIT = "clawdi-daemon.service";
export const RUNTIME_SIDECAR_SYSTEM_UNIT = "clawdi-runtime-sidecar.service";
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

export function readSystemdUserDesiredRevisions(
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
	for (const entry of managedRuntimeSystemdUnitEntries(root, readFileIfExists)) {
		if (entry.kind === "base-unit") {
			const contents = entry.generatedContents ?? readFileIfExists(entry.path);
			if (contents !== null) units.set(entry.unitName, contents);
			continue;
		}
		const base = readFileIfExists(join(root, entry.unitName)) ?? "";
		units.set(entry.unitName, `${base}\n${entry.generatedContents}`);
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

export function withoutStaleSystemdUnits(
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
		forceReloadUserUnits?: readonly string[];
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
	const forcedUserReloads = (opts.forceReloadUserUnits ?? []).filter(
		(unit) => !scopedUserUnits || scopedUserUnits.has(unit),
	);
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
		forcedUserReloads.length > 0 ||
		forcedUserRestarts.length > 0;
	for (const unit of forcedUserReloads) userUnitsChanged.add(unit);
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
		let revisions: ReturnType<typeof systemdProcessRevisions>;
		try {
			revisions = systemdProcessRevisions(paths, unit, state);
		} catch (error) {
			if (!state.needDaemonReload) throw error;
			// The manager may still be running the pre-candidate view. Reload and
			// restart before the final proof, while preserving reload-only behavior
			// when the current process already proves the desired revision.
			userProcessRevisionDrift.add(unit);
			continue;
		}
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
		forcedUserReloads.length > 0 ||
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
	const restartUserUnits: string[] = [];
	for (const unit of user.present) {
		const state = requiredSystemdUnitState(userStates, "user", unit);
		if (state.activeState === "failed" && recoverFailedUnits) {
			resetFailedUserUnits.push(unit);
			userUnitsChanged.add(unit);
		}
		if (
			state.activeState === "inactive" ||
			(state.activeState === "failed" && recoverFailedUnits)
		) {
			startUserUnits.push(unit);
			userUnitsChanged.add(unit);
			continue;
		}
		if (state.activeState !== "active") continue;
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
	const candidateActions = new Set<SystemdRuntimeMutationAction>(["install", "restart", "start"]);
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
			throw new Error(`systemd rollback did not restore user unit ${unit} enablement`);
		}
		if (initial.activeState !== "active") continue;
		restoreActiveSystemdUnit(paths, transaction, "user", unit);
		const restored = systemdUnitManagerState(paths, "user", unit);
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
	const properties = parseSystemctlShow(show.stdout);
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
		const detail = activeRuntimeRevisionProofFailureDetail(error);
		throw new Error(
			`could not prove active runtime revision for managed systemd unit ${unit}: ${detail}; manager reload required=${state.needDaemonReload ? "yes" : "no"}`,
			{ cause: error },
		);
	}
	return { desiredRevision, processRevision };
}

function activeRuntimeRevisionProofFailureDetail(error: unknown): string {
	if (error instanceof Error && error.message === "invalid revision entry") {
		return "active process environment does not contain exactly one valid CLAWDI_RUNTIME_REV";
	}
	const code =
		error && typeof error === "object" && "code" in error && typeof error.code === "string"
			? error.code
			: null;
	if (code === "ENOENT" || code === "ESRCH") return "active process exited during revision proof";
	if (code === "EACCES" || code === "EPERM") {
		return "active process environment was not readable under its filesystem identity";
	}
	return "active process environment could not be read";
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

export function assertRuntimeUserCanRead(path: string, home: string): void {
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
