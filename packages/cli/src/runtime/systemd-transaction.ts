import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readRuntimeAppliedState } from "./applied-state";
import type { getRuntimePaths } from "./paths";
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

interface SystemdUnitManagerState {
	loadState: string;
	activeState: string;
	needDaemonReload: boolean;
	enabled?: boolean;
}

interface CommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

export const RUNTIME_WATCH_SYSTEM_UNIT = "clawdi-runtime-watch.service";
export const RUNTIME_SIDECAR_SYSTEM_UNIT = "clawdi-runtime-sidecar.service";
const NON_TRANSACTIONAL_SYSTEM_UNITS = new Set([RUNTIME_WATCH_SYSTEM_UNIT]);

export function shouldRecoverFailedSystemdUnit(input: {
	activeState: string;
	changed: boolean;
	pendingActivation: boolean;
	recoverFailedUnits: boolean;
}): boolean {
	return (
		input.activeState === "failed" &&
		(input.recoverFailedUnits || input.changed || input.pendingActivation)
	);
}

export function readSystemdUnitSnapshot(
	paths: ReturnType<typeof getRuntimePaths>,
): SystemdUnitSnapshot {
	return {
		system: readManagedSystemdUnits(paths, paths.systemdSystemRoot),
		user: readManagedSystemdUnits(paths, paths.systemdUserRoot),
	};
}

function systemdUnitFingerprint(
	paths: ReturnType<typeof getRuntimePaths>,
	unit: string,
	contents: string,
): string {
	const environment = readFileIfExists(join(paths.systemdEnvRoot, `${unit}.env`)) ?? "";
	return createHash("sha256").update(contents).update(environment).digest("hex");
}

function readManagedSystemdUnits(
	paths: ReturnType<typeof getRuntimePaths>,
	root: string,
): Map<string, string> {
	const units = new Map<string, string>();
	for (const entry of managedRuntimeSystemdUnitEntries(root, readFileIfExists)) {
		if (entry.kind === "base-unit") {
			const contents = entry.generatedContents ?? readFileIfExists(entry.path);
			if (contents !== null) {
				units.set(entry.unitName, systemdUnitFingerprint(paths, entry.unitName, contents));
			}
			continue;
		}
		const base = readFileIfExists(join(root, entry.unitName)) ?? "";
		units.set(
			entry.unitName,
			systemdUnitFingerprint(paths, entry.unitName, `${base}\n${entry.generatedContents}`),
		);
	}
	return units;
}

function changedSystemdUnits(
	before: Map<string, string>,
	after: Map<string, string>,
	invalidated: readonly string[] = [],
): { added: string[]; changed: string[]; removed: string[]; present: string[] } {
	const added = new Set<string>();
	const changed = new Set<string>();
	const removed: string[] = [];
	for (const [name, contents] of after) {
		if (!before.has(name)) added.add(name);
		else if (before.get(name) !== contents) changed.add(name);
	}
	for (const name of invalidated) {
		if (before.has(name) && after.has(name)) changed.add(name);
	}
	for (const name of before.keys()) {
		if (!after.has(name)) removed.push(name);
	}
	return {
		added: [...added].sort(),
		changed: [...changed].sort(),
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
		recoverFailedUnits?: boolean;
		restartChangedUnits?: boolean;
		invalidatedUserUnits?: readonly string[];
		activationScope?: {
			systemUnits: readonly string[];
			userUnits: readonly string[];
		};
		skipActivatedSystemUnits?: readonly string[];
	},
): {
	applied: boolean;
	activated: Record<string, string>;
	systemUnitsChanged: string[];
	userUnitsChanged: string[];
} {
	const allSystem = changedSystemdUnits(before.system, after.system);
	const allUser = changedSystemdUnits(before.user, after.user, opts.invalidatedUserUnits);
	const filterChanges = (
		changes: ReturnType<typeof changedSystemdUnits>,
		units: Iterable<string>,
	): ReturnType<typeof changedSystemdUnits> => {
		const selected = new Set(units);
		return {
			added: changes.added.filter((unit) => selected.has(unit)),
			changed: changes.changed.filter((unit) => selected.has(unit)),
			removed: changes.removed.filter((unit) => selected.has(unit)),
			present: changes.present.filter((unit) => selected.has(unit)),
		};
	};
	const systemScope = new Set(
		opts.activationScope?.systemUnits ?? [...allSystem.present, ...allSystem.removed],
	);
	const system = filterChanges(allSystem, systemScope);
	const user = opts.activationScope
		? filterChanges(allUser, opts.activationScope.userUnits)
		: allUser;
	const systemUnitsChanged = new Set([...system.added, ...system.removed]);
	const userUnitsChanged = new Set([...user.added, ...user.removed]);
	const committedActivated = readRuntimeAppliedState(paths)?.activated ?? {};
	const pendingSystemActivation = new Set(
		system.present.filter(
			(unit) =>
				!NON_TRANSACTIONAL_SYSTEM_UNITS.has(unit) &&
				after.system.get(unit) !== committedActivated[unit],
		),
	);
	const pendingUserActivation = new Set(
		user.present.filter((unit) => after.user.get(unit) !== committedActivated[unit]),
	);
	const recoverFailedUnits = opts.recoverFailedUnits !== false;
	const activationChanged =
		system.added.length > 0 ||
		system.changed.length > 0 ||
		system.removed.length > 0 ||
		user.added.length > 0 ||
		user.changed.length > 0 ||
		user.removed.length > 0 ||
		pendingSystemActivation.size > 0 ||
		pendingUserActivation.size > 0;
	if (!shouldApplySystemdRuntimeUpdate(paths)) {
		return {
			applied: !activationChanged,
			activated: {},
			systemUnitsChanged: [...systemUnitsChanged]
				.filter((unit) => !NON_TRANSACTIONAL_SYSTEM_UNITS.has(unit))
				.sort(),
			userUnitsChanged: [...userUnitsChanged].sort(),
		};
	}
	const systemStates = readSystemdRuntimeUnits(paths, "system", [
		...system.present,
		...system.removed,
	]);
	const userStates = readSystemdRuntimeUnits(paths, "user", [...user.present, ...user.removed]);
	// Native updates and interrupted applies can predate the filesystem snapshot.
	if (
		system.added.length > 0 ||
		system.changed.length > 0 ||
		system.removed.length > 0 ||
		[...systemStates.values()].some((state) => state.needDaemonReload)
	) {
		systemctl(["daemon-reload"]);
	}
	if (
		user.added.length > 0 ||
		user.changed.length > 0 ||
		user.removed.length > 0 ||
		[...userStates.values()].some((state) => state.needDaemonReload)
	) {
		runtimeUserSystemctl(paths, ["daemon-reload"]);
	}
	if (system.removed.length > 0) {
		systemctl(["stop", ...system.removed]);
		systemctl(systemUnitFileMutationArgs(paths, "disable", system.removed));
	}
	if (user.removed.length > 0) {
		runtimeUserSystemctl(paths, ["stop", ...user.removed]);
		runtimeUserSystemctl(paths, ["disable", ...user.removed]);
	}

	const skipActivatedSystemUnits = new Set(opts.skipActivatedSystemUnits ?? []);
	const enableSystemUnits: string[] = [];
	const resetFailedSystemUnits: string[] = [];
	const startSystemUnits: string[] = [];
	const restartSystemUnits: string[] = [];
	for (const unit of system.present) {
		const state = requiredSystemdUnitState(systemStates, "system", unit);
		if (skipActivatedSystemUnits.has(unit)) continue;
		if (!systemdUnitEnabled(state)) enableSystemUnits.push(unit);
		if (
			shouldRecoverFailedSystemdUnit({
				activeState: state.activeState,
				changed: system.added.includes(unit) || system.changed.includes(unit),
				pendingActivation: pendingSystemActivation.has(unit),
				recoverFailedUnits,
			})
		) {
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
			((opts.restartChangedUnits && system.changed.includes(unit)) ||
				pendingSystemActivation.has(unit))
		) {
			restartSystemUnits.push(unit);
			systemUnitsChanged.add(unit);
		}
	}
	// Each reconciliation makes at most one recovery attempt per failed unit.
	// Transitional units remain untouched and fail final proof below.
	if (enableSystemUnits.length > 0) {
		systemctl(systemUnitFileMutationArgs(paths, "enable", enableSystemUnits));
	}
	if (resetFailedSystemUnits.length > 0) {
		systemctl(["reset-failed", ...resetFailedSystemUnits]);
	}
	if (startSystemUnits.length > 0) {
		systemctl(["start", ...startSystemUnits]);
	}
	if (restartSystemUnits.length > 0) {
		systemctl(["restart", ...restartSystemUnits]);
	}

	const enableUserUnits: string[] = [];
	const resetFailedUserUnits: string[] = [];
	const startUserUnits: string[] = [];
	const restartUserUnits: string[] = [];
	for (const unit of user.present) {
		const state = requiredSystemdUnitState(userStates, "user", unit);
		if (!systemdUnitEnabled(state)) enableUserUnits.push(unit);
		const recoverFailedUserUnit = shouldRecoverFailedSystemdUnit({
			activeState: state.activeState,
			changed: user.added.includes(unit) || user.changed.includes(unit),
			pendingActivation: pendingUserActivation.has(unit),
			recoverFailedUnits,
		});
		if (recoverFailedUserUnit) {
			resetFailedUserUnits.push(unit);
			userUnitsChanged.add(unit);
		}
		if (state.activeState === "inactive" || recoverFailedUserUnit) {
			startUserUnits.push(unit);
			userUnitsChanged.add(unit);
			continue;
		}
		if (state.activeState !== "active") continue;
		if (user.changed.includes(unit) || pendingUserActivation.has(unit)) {
			restartUserUnits.push(unit);
			userUnitsChanged.add(unit);
		}
	}
	if (enableUserUnits.length > 0) {
		runtimeUserSystemctl(paths, ["enable", ...enableUserUnits]);
	}
	if (resetFailedUserUnits.length > 0) {
		runtimeUserSystemctl(paths, ["reset-failed", ...resetFailedUserUnits]);
	}
	if (startUserUnits.length > 0) {
		runtimeUserSystemctl(paths, ["start", ...startUserUnits]);
	}
	if (restartUserUnits.length > 0) {
		runtimeUserSystemctl(paths, ["restart", ...restartUserUnits]);
	}
	if (
		!activationChanged &&
		system.present.every((unit) => {
			const state = requiredSystemdUnitState(systemStates, "system", unit);
			return (
				state.loadState !== "not-found" &&
				state.activeState === "active" &&
				!state.needDaemonReload &&
				systemdUnitEnabled(state)
			);
		}) &&
		user.present.every((unit) => {
			const state = requiredSystemdUnitState(userStates, "user", unit);
			return (
				state.loadState !== "not-found" &&
				state.activeState === "active" &&
				!state.needDaemonReload &&
				systemdUnitEnabled(state)
			);
		})
	) {
		return {
			applied: true,
			activated: Object.fromEntries(
				[
					...system.present.filter((unit) => !NON_TRANSACTIONAL_SYSTEM_UNITS.has(unit)),
					...user.present,
				]
					.map((unit) => [unit, after.system.get(unit) ?? after.user.get(unit)])
					.filter((entry): entry is [string, string] => entry[1] !== undefined),
			),
			systemUnitsChanged: [],
			userUnitsChanged: [],
		};
	}

	const systemConverged = system.present.every((unit) => {
		const state = systemdUnitManagerState(paths, "system", unit);
		return (
			state.loadState !== "not-found" &&
			state.activeState === "active" &&
			!state.needDaemonReload &&
			systemdUnitEnabled(state)
		);
	});
	const userConverged = user.present.every((unit) => {
		const state = systemdUnitManagerState(paths, "user", unit);
		return !(
			state.loadState === "not-found" ||
			state.activeState !== "active" ||
			state.needDaemonReload ||
			!systemdUnitEnabled(state)
		);
	});
	const removedSystemConverged = system.removed.every((unit) => {
		const state = systemdUnitManagerState(paths, "system", unit);
		return systemdUnitAbsentOrInactive(state) && systemdUnitAbsentOrDisabled(state);
	});
	const removedUserConverged = user.removed.every((unit) => {
		const state = systemdUnitManagerState(paths, "user", unit);
		return systemdUnitAbsentOrInactive(state) && systemdUnitAbsentOrDisabled(state);
	});
	const applied =
		systemConverged && userConverged && removedSystemConverged && removedUserConverged;
	const activated = applied
		? Object.fromEntries(
				[
					...system.present.filter((unit) => !NON_TRANSACTIONAL_SYSTEM_UNITS.has(unit)),
					...user.present,
				]
					.map((unit) => [unit, after.system.get(unit) ?? after.user.get(unit)])
					.filter((entry): entry is [string, string] => entry[1] !== undefined),
			)
		: {};
	return {
		applied,
		activated,
		systemUnitsChanged: [...systemUnitsChanged]
			.filter((unit) => !NON_TRANSACTIONAL_SYSTEM_UNITS.has(unit))
			.sort(),
		userUnitsChanged: [...userUnitsChanged].sort(),
	};
}

function readSystemdRuntimeUnits(
	paths: ReturnType<typeof getRuntimePaths>,
	scope: SystemdRuntimeScope,
	units: readonly string[],
): Map<string, SystemdUnitManagerState> {
	const uniqueUnits = [...new Set(units)].sort();
	const states = new Map<string, SystemdUnitManagerState>();
	if (uniqueUnits.length === 0) return states;
	const showArgs = [
		"show",
		...uniqueUnits,
		"--property=LoadState",
		"--property=ActiveState",
		"--property=NeedDaemonReload",
	];
	const show = systemdCommandResult(paths, scope, showArgs);
	assertCommandSucceeded(systemdCommandName(scope), showArgs, show);
	const blocks = show.stdout
		.trim()
		.split(/\r?\n\s*\r?\n/)
		.filter(Boolean);
	if (blocks.length !== uniqueUnits.length) {
		throw new Error(`systemd ${scope} returned incomplete batched manager state`);
	}
	const enabled = readSystemdUnitEnablement(paths, scope, uniqueUnits);
	for (const [index, unit] of uniqueUnits.entries()) {
		states.set(
			unit,
			parseSystemdUnitManagerState(scope, unit, blocks[index] ?? "", enabled.get(unit)),
		);
	}
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

function systemdUnitManagerState(
	paths: ReturnType<typeof getRuntimePaths>,
	scope: "system" | "user",
	unit: string,
): SystemdUnitManagerState {
	return requiredSystemdUnitState(readSystemdRuntimeUnits(paths, scope, [unit]), scope, unit);
}

function parseSystemdUnitManagerState(
	scope: SystemdRuntimeScope,
	unit: string,
	show: string,
	enabled: boolean | undefined,
): SystemdUnitManagerState {
	const properties = parseSystemctlShow(show);
	const loadState = properties.LoadState;
	const activeState = properties.ActiveState;
	const needDaemonReload = properties.NeedDaemonReload;
	if (!loadState || !activeState || !needDaemonReload) {
		throw new Error(`systemd ${scope} unit ${unit} returned incomplete manager state`);
	}
	if (needDaemonReload !== "yes" && needDaemonReload !== "no") {
		throw new Error(
			`systemd ${scope} unit ${unit} returned invalid NeedDaemonReload: ${needDaemonReload}`,
		);
	}
	const managerState = {
		loadState,
		activeState,
		needDaemonReload: needDaemonReload === "yes",
	};
	return { ...managerState, enabled };
}

function readSystemdUnitEnablement(
	paths: ReturnType<typeof getRuntimePaths>,
	scope: SystemdRuntimeScope,
	units: readonly string[],
): Map<string, boolean> {
	const args = ["is-enabled", ...units];
	const result = systemdCommandResult(paths, scope, args);
	if (result.status === null || result.error) {
		assertCommandSucceeded(systemdCommandName(scope), args, result);
	}
	const output = result.stdout.trim().split(/\r?\n/);
	return new Map(
		units.map((unit, index) => {
			const state = output.length === units.length ? output[index]?.trim() : undefined;
			if (state === "enabled") return [unit, true];
			if (state === "disabled") return [unit, false];
			return [unit, probeSystemdUnitEnabled(paths, scope, unit)];
		}),
	);
}

function probeSystemdUnitEnabled(
	paths: ReturnType<typeof getRuntimePaths>,
	scope: SystemdRuntimeScope,
	unit: string,
): boolean {
	const args = ["is-enabled", "--quiet", unit];
	const result = systemdCommandResult(paths, scope, args);
	if (result.status === null || result.error) {
		assertCommandSucceeded(systemdCommandName(scope), args, result);
	}
	return result.status === 0;
}

function systemdCommandResult(
	paths: ReturnType<typeof getRuntimePaths>,
	scope: SystemdRuntimeScope,
	args: string[],
): CommandResult {
	return scope === "system" ? systemctlResult(args) : runtimeUserSystemctlResult(paths, args);
}

function systemdCommandName(scope: SystemdRuntimeScope): string {
	return scope === "system" ? systemctlPath() : "systemctl --user";
}

function systemdUnitEnabled(state: SystemdUnitManagerState): boolean {
	return state.enabled === true;
}

function systemdUnitAbsentOrInactive(state: SystemdUnitManagerState): boolean {
	return state.loadState === "not-found" || state.activeState === "inactive";
}

function systemdUnitAbsentOrDisabled(state: SystemdUnitManagerState): boolean {
	return state.loadState === "not-found" || state.enabled === false;
}

function shouldApplySystemdRuntimeUpdate(paths: ReturnType<typeof getRuntimePaths>): boolean {
	const override = process.env.CLAWDI_SYSTEMD_APPLY?.trim().toLowerCase();
	if (override === "1" || override === "true") return true;
	if (override === "0" || override === "false") return false;
	return usesRuntimeSystemUnitFiles(paths);
}

function usesRuntimeSystemUnitFiles(paths: ReturnType<typeof getRuntimePaths>): boolean {
	return paths.systemdSystemRoot === "/run/systemd/system";
}

function systemUnitFileMutationArgs(
	paths: ReturnType<typeof getRuntimePaths>,
	command: "enable" | "disable",
	units: readonly string[],
): string[] {
	return [command, ...(usesRuntimeSystemUnitFiles(paths) ? ["--runtime"] : []), ...units];
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
